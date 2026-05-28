const crypto = require('crypto');
const { getDb, getArtist, insertAuditLog, getSlug, parsePage } = require('../_db');
const { requireAuth } = require('../_auth');
const { validateStr, validateNum } = require('../_validate');
const { wrap } = require('../_handler');
const { suggestLyricsWithAI } = require('../_ai');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { LYRICS_SOURCES, plainFromSynced } = require('../_lyrics');
const { MEDIA_LOG_ACTIONS } = require('../_constants');
const { createPresignedUrl, deleteFromR2, filenameFromUrl, keyFromUrl, verifyUpload } = require('../_r2');
const logger = require('../_logger');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  // ── song-logs (merged from song-logs.js via vercel.json rewrite) ──────────
  if (req.url.includes('song-logs')) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const { songId } = req.query;
    let logs;
    if (songId) {
      const sid = Number(songId);
      if (!Number.isInteger(sid) || sid <= 0) return res.status(400).json({ error: 'Invalid songId' });
      logs = await sql`
        SELECT * FROM song_logs
        WHERE artist_id = ${band.id} AND song_id = ${sid}
          AND action = ANY(${MEDIA_LOG_ACTIONS})
        ORDER BY changed_at DESC LIMIT 20
      `;
    } else {
      logs = await sql`
        SELECT * FROM song_logs WHERE artist_id = ${band.id}
        ORDER BY changed_at DESC LIMIT 10
      `;
    }
    return res.json(logs);
  }

  // ── GET setlist appearances for one song (/songs?setlists=<id>) ────────────
  if (req.method === 'GET' && req.query.setlists != null) {
    const songId = Number(req.query.setlists);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });
    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const setlists = await sql`
      SELECT sl.id, sl.title, sl.comment, sl.created_at,
             g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue
      FROM setlists sl
      JOIN setlist_songs ss ON ss.setlist_id = sl.id
      LEFT JOIN gigs g ON sl.gig_id = g.id
      LEFT JOIN venues v ON v.id = g.venue_id
      WHERE ss.song_id = ${songId} AND sl.artist_id = ${band.id}
      ORDER BY sl.created_at DESC
    `;
    return res.json(setlists);
  }

  if (req.method === 'GET') {
    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const viewMode = !req.headers.authorization;
    if (viewMode) {
      const { limit: rawLimit, offset } = parsePage(req);
      const limit = Math.min(rawLimit, 30);
      const activeOnly = req.query.active !== '0';
      const rows = await sql`
        SELECT s.*,
          COUNT(DISTINCT ss.setlist_id)::int AS play_count,
          MAX(sl.created_at)                 AS last_played_at,
          g.iswc, g.gema_work_number, g.language AS gema_language,
          COUNT(*) OVER()::int AS total
        FROM songs s
        LEFT JOIN setlist_songs ss ON ss.song_id = s.id
        LEFT JOIN setlists sl      ON sl.id = ss.setlist_id
        LEFT JOIN LATERAL (
          SELECT iswc, gema_work_number, language
          FROM gema_works
          WHERE song_id = s.id
          ORDER BY gema_work_number
          LIMIT 1
        ) g ON true
        WHERE s.artist_id = ${band.id} AND s.deleted = false
          AND (${!activeOnly} OR s.active = true)
        GROUP BY s.id, g.iswc, g.gema_work_number, g.language
        ORDER BY s.title
        LIMIT ${limit} OFFSET ${offset}
      `;
      const total = Number(rows[0]?.total ?? 0);
      return res.json({
        rows: rows.map(({ total: _, ...row }) => row),
        total,
        limit,
        offset,
      });
    }
    const songs = await sql`
      SELECT s.*,
        COUNT(DISTINCT ss.setlist_id)::int AS play_count,
        MAX(sl.created_at)                 AS last_played_at,
        g.iswc, g.gema_work_number, g.language AS gema_language
      FROM songs s
      LEFT JOIN setlist_songs ss ON ss.song_id = s.id
      LEFT JOIN setlists sl      ON sl.id = ss.setlist_id
      LEFT JOIN LATERAL (
        SELECT iswc, gema_work_number, language
        FROM gema_works
        WHERE song_id = s.id
        ORDER BY gema_work_number
        LIMIT 1
      ) g ON true
      WHERE s.artist_id = ${band.id} AND s.deleted = false
      GROUP BY s.id, g.iswc, g.gema_work_number, g.language
      ORDER BY s.title
    `;
    return res.json(songs);
  }

  // ── POST lyrics-suggest ───────────────────────────────────────────────────
  // Dispatched via body field to avoid multi-segment POST routing issues.
  // Client sends POST /api/:band/songs with { lyrics_suggest_id: songId }.
  if (req.method === 'POST' && req.body?.lyrics_suggest_id != null) {
    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const songId = Number(req.body.lyrics_suggest_id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });

    const [song] = await sql`
      SELECT s.title, s.interpret, s.reference_interpret,
        COALESCE(g.language, s.extra->>'language') AS language,
        g.gema_genre AS genre
      FROM songs s
      LEFT JOIN LATERAL (
        SELECT language, gema_genre FROM gema_works
        WHERE song_id = s.id ORDER BY gema_work_number LIMIT 1
      ) g ON true
      WHERE s.id = ${songId} AND s.artist_id = ${band.id} AND s.deleted = false
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    const artist = song.reference_interpret || song.interpret;
    if (!artist) return res.status(400).json({ error: 'No artist on this song — cannot search for lyrics' });

    if (await checkRateLimit(`lyrics-suggest:${band.id}:${songId}`, 3, 300))
      return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
    if (await checkRateLimit(`lyrics-suggest-ip:${clientIp(req)}`, 10, 3600))
      return res.status(429).json({ error: 'Too many requests from this IP.' });

    const { title, language, genre } = song;
    const ctx = { band: band.slug, songId, title, artist };
    const found = (lyrics, source) => res.json({ lyrics, source, sources: LYRICS_SOURCES });
    const miss  = (aiSkipped = false) => res.json({ lyrics: null, sources: LYRICS_SOURCES, aiSkipped });

    try {
      const r = await fetch(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data?.lyrics?.length > 50) {
          await logger.info('lyrics_suggest', { ...ctx, source: 'lyrics.ovh' });
          return found(data.lyrics.trim(), 'lyrics.ovh');
        }
      }
      await logger.info('lyrics_suggest_miss', { ...ctx, source: 'lyrics.ovh', status: r.status });
    } catch (e) {
      await logger.warn('lyrics_suggest_error', { ...ctx, source: 'lyrics.ovh', error: e.message });
    }

    try {
      const r = await fetch(
        `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (r.ok) {
        const data = await r.json().catch(() => null);
        const top = Array.isArray(data) && data[0];
        if (top) {
          const lyrics = top.plainLyrics || plainFromSynced(top.syncedLyrics);
          if (lyrics?.length > 50) {
            await logger.info('lyrics_suggest', { ...ctx, source: 'lrclib' });
            return found(lyrics.trim(), 'lrclib');
          }
        }
      }
      await logger.info('lyrics_suggest_miss', { ...ctx, source: 'lrclib', status: r.status });
    } catch (e) {
      await logger.warn('lyrics_suggest_error', { ...ctx, source: 'lrclib', error: e.message });
    }

    const { lyrics, skipped } = await suggestLyricsWithAI(title, artist, { language, genre });
    if (lyrics) {
      await logger.info('lyrics_suggest', { ...ctx, source: 'ai' });
      return found(lyrics, 'ai');
    }

    await logger.info('lyrics_suggest_miss', { ...ctx, source: 'ai', skipped: skipped ?? false });
    return miss(skipped ?? false);
  }

  // ── POST lyrics update (replaces PUT /songs/:id/lyrics) ───────────────────
  if (req.method === 'POST' && req.body?.lyrics_update_id != null) {
    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const songId = Number(req.body.lyrics_update_id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });

    const { lyrics } = req.body;
    if (typeof lyrics !== 'string')
      return res.status(400).json({ error: 'lyrics must be a string' });
    if (lyrics.length > 20000)
      return res.status(400).json({ error: 'Lyrics too long (max 20 000 characters)' });

    const lyricsVal = lyrics.trim() || null;
    const [song] = await sql`
      UPDATE songs SET extra = extra || ${{ lyrics: lyricsVal }}
      WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
      RETURNING id, title
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    await insertAuditLog(sql, band.id, song.id, 'lyrics_update', { title: song.title });
    return res.json({ ok: true });
  }

  // ── POST lyrics delete (replaces DELETE /songs/:id/lyrics) ────────────────
  if (req.method === 'POST' && req.body?.lyrics_delete_id != null) {
    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const songId = Number(req.body.lyrics_delete_id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });

    const [song] = await sql`
      SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    await sql`UPDATE songs SET extra = extra - 'lyrics' WHERE id = ${songId} AND artist_id = ${band.id}`;
    return res.json({ ok: true });
  }

  // ── POST upload presign / confirm / delete (workaround: multi-segment PUT/DELETE to
  //    /songs/:id/:type fails on Vercel catch-alls in dynamic dirs) ────────────────────────
  // Shared config for all three media handlers below.
  // eslint-disable-next-line no-inner-declarations
  const MEDIA_CONFIGS = {
    audio:    { keyPrefix: 'audio/',    extraKey: 'listenUrl',   maxBytes: 50*1024*1024, actionPrefix: 'audio',    allowedExts: new Set(['mp3','m4a','ogg','wav','flac']), mimePrefix: 'audio/' },
    sheet:    { keyPrefix: 'sheets/',   extraKey: 'sheetUrl',    maxBytes: 20*1024*1024, actionPrefix: 'sheet',    mimePrefix: 'application/pdf' },
    playback: { keyPrefix: 'playback/', extraKey: 'playbackUrl', maxBytes: 50*1024*1024, actionPrefix: 'playback', allowedExts: new Set(['mp3','m4a','ogg','wav','flac']), mimePrefix: 'audio/' },
  };

  // Confirm upload: save publicUrl to DB, verify file exists in R2, delete previous file.
  if (req.method === 'POST' && req.body?.media_confirm_id != null) {
    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const songId = Number(req.body.media_confirm_id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });

    const config = MEDIA_CONFIGS[req.body.media_type];
    if (!config) return res.status(400).json({ error: 'media_type must be audio, sheet, or playback' });

    const { publicUrl } = req.body;
    if (!publicUrl || typeof publicUrl !== 'string')
      return res.status(400).json({ error: 'publicUrl required' });

    const base = process.env.R2_PUBLIC_URL;
    if (!base || !publicUrl.startsWith(`${base}/${config.keyPrefix}`))
      return res.status(400).json({ error: 'Invalid publicUrl' });

    const head = await verifyUpload(keyFromUrl(publicUrl));
    if (!head) return res.status(400).json({ error: 'Uploaded file not found in storage' });
    if (!head.contentType.startsWith(config.mimePrefix)) {
      await deleteFromR2(publicUrl);
      return res.status(400).json({ error: `Uploaded file content type does not match ${config.mimePrefix}` });
    }
    if (head.size > config.maxBytes) {
      await deleteFromR2(publicUrl);
      return res.status(400).json({ error: `Uploaded file exceeds ${config.maxBytes / 1024 / 1024} MB` });
    }

    const [song] = await sql`SELECT * FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    const previousUrl = song.extra?.[config.extraKey] ?? null;
    const newExtra = { ...(song.extra ?? {}), [config.extraKey]: publicUrl };
    const [updated] = await sql`UPDATE songs SET extra = ${newExtra} WHERE id = ${songId} AND artist_id = ${band.id} RETURNING *`;

    if (previousUrl && previousUrl !== publicUrl) {
      await deleteFromR2(previousUrl);
      await insertAuditLog(sql, band.id, songId, `${config.actionPrefix}_replace`, {
        previousFilename: filenameFromUrl(previousUrl),
        newFilename:      filenameFromUrl(publicUrl),
        replacedAt:       new Date().toISOString(),
      });
    } else {
      await insertAuditLog(sql, band.id, songId, 'update', updated);
    }
    return res.json({ ok: true, publicUrl });
  }

  // Delete media file from R2 and clear the DB field.
  if (req.method === 'POST' && req.body?.media_delete_id != null) {
    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const songId = Number(req.body.media_delete_id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });

    const config = MEDIA_CONFIGS[req.body.media_type];
    if (!config) return res.status(400).json({ error: 'media_type must be audio, sheet, or playback' });

    const [song] = await sql`SELECT extra FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    const url = song.extra?.[config.extraKey];
    if (url) {
      await deleteFromR2(url);
      await insertAuditLog(sql, band.id, songId, `${config.actionPrefix}_delete`, {
        filename:  filenameFromUrl(url),
        deletedAt: new Date().toISOString(),
      });
    }

    await sql`UPDATE songs SET extra = extra - ${config.extraKey} WHERE id = ${songId} AND artist_id = ${band.id}`;
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && req.body?.upload_presign_id != null) {
    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const songId = Number(req.body.upload_presign_id);
    if (!Number.isInteger(songId) || songId <= 0)
      return res.status(400).json({ error: 'Invalid song id' });
    const config = MEDIA_CONFIGS[req.body.upload_type];
    if (!config) return res.status(400).json({ error: 'upload_type must be audio, sheet, or playback' });

    const { filename, contentType, size } = req.body;
    if (!filename || typeof filename !== 'string')
      return res.status(400).json({ error: 'filename required' });

    const maxMB = config.maxBytes / 1024 / 1024;
    if (config.allowedExts) {
      const ext = filename.split('.').pop().toLowerCase();
      if (!config.allowedExts.has(ext))
        return res.status(400).json({ error: `Unsupported file type. Allowed: ${[...config.allowedExts].join(', ')}` });
      if (!contentType || !String(contentType).startsWith(config.mimePrefix))
        return res.status(400).json({ error: `contentType must be ${config.mimePrefix}*` });
    } else {
      if (!filename.toLowerCase().endsWith('.pdf'))
        return res.status(400).json({ error: 'Only PDF files are allowed' });
    }

    if (!size || Number(size) > config.maxBytes)
      return res.status(400).json({ error: `size required, max ${maxMB} MB` });

    const [song] = await sql`SELECT id FROM songs WHERE id = ${songId} AND artist_id = ${band.id} AND deleted = false`;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const key = `${config.keyPrefix}${crypto.randomUUID()}-${safeName}`;
    return res.json(await createPresignedUrl(key, config.allowedExts ? contentType : 'application/pdf'));
  }

  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const { title: rawTitle, active, heart, key: rawKey, genre: rawCat, energy: rawEnergy,
            time_signature: rawTimeSig, bpm: rawBpm, length_min: rawLen,
            interpret: rawInterp, reference_interpret: rawRef,
            comment: rawComment, extra } = req.body ?? {};

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title required' });
    const key = validateStr(rawKey, 20);
    if (key === false) return res.status(400).json({ error: 'key too long' });
    const genre = validateStr(rawCat, 100);
    if (genre === false) return res.status(400).json({ error: 'genre too long' });
    const energy = validateStr(rawEnergy, 50);
    if (energy === false) return res.status(400).json({ error: 'energy too long' });
    const time_signature = validateStr(rawTimeSig, 20);
    if (time_signature === false) return res.status(400).json({ error: 'time_signature too long' });
    const bpm = validateNum(rawBpm);
    if (bpm === false) return res.status(400).json({ error: 'bpm must be a number' });
    const length_min = validateNum(rawLen);
    if (length_min === false) return res.status(400).json({ error: 'length_min must be a number' });
    const interpret = validateStr(rawInterp, 200);
    if (interpret === false) return res.status(400).json({ error: 'interpret too long' });
    const reference_interpret = validateStr(rawRef, 500);
    if (reference_interpret === false) return res.status(400).json({ error: 'reference_interpret too long' });
    const comment = validateStr(rawComment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long' });

    const [song] = await sql`
      INSERT INTO songs (artist_id, title, active, heart, key, genre, energy, time_signature,
                         bpm, length_min, interpret, reference_interpret, comment, extra)
      VALUES (${band.id}, ${title}, ${active ?? true}, ${heart ?? false}, ${key},
              ${genre}, ${energy}, ${time_signature}, ${bpm}, ${length_min},
              ${interpret}, ${reference_interpret},
              ${comment}, ${extra ?? {}})
      RETURNING *
    `;
    await insertAuditLog(sql, band.id, song.id, 'create', song);
    return res.status(201).json(song);
  }

  // Batch update: [{ id, title, active, key, genre, tempo, length_min,
  //                   interpret, reference_interpret, comment, extra }, ...]
  if (req.method === 'PATCH') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0)
      return res.status(400).json({ error: 'Array of updates required' });
    if (updates.length > 100)
      return res.status(400).json({ error: 'Too many updates (max 100)' });

    let applied = 0;
    for (const update of updates) {
      const songId = Number(update.id);
      if (!Number.isInteger(songId) || songId <= 0) continue;

      const title = validateStr(update.title, 200);
      if (!title) continue;
      const key = validateStr(update.key, 20);
      if (key === false) continue;
      const genre = validateStr(update.genre, 100);
      if (genre === false) continue;
      const energy = validateStr(update.energy, 50);
      if (energy === false) continue;
      const time_signature = validateStr(update.time_signature, 20);
      if (time_signature === false) continue;
      const bpm = validateNum(update.bpm);
      if (bpm === false) continue;
      const length_min = validateNum(update.length_min);
      if (length_min === false) continue;
      const interpret = validateStr(update.interpret, 200);
      if (interpret === false) continue;
      const reference_interpret = validateStr(update.reference_interpret, 500);
      if (reference_interpret === false) continue;
      const comment = validateStr(update.comment, 2000);
      if (comment === false) continue;

      const [updated] = await sql`
        UPDATE songs SET
          title               = ${title},
          active              = ${update.active ?? true},
          heart               = ${update.heart ?? false},
          key                 = ${key},
          genre               = ${genre},
          energy              = ${energy},
          time_signature      = ${time_signature},
          bpm                 = ${bpm},
          length_min          = ${length_min},
          interpret           = ${interpret},
          reference_interpret = ${reference_interpret},
          comment             = ${comment},
          extra               = songs.extra || ${update.extra ?? {}}
        WHERE id = ${songId} AND artist_id = ${band.id}
        RETURNING *
      `;
      if (updated) { await insertAuditLog(sql, band.id, updated.id, 'update', updated); applied++; }
    }
    return res.json({ ok: true, count: applied });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
