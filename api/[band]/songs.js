const { getDb, getBand, insertAuditLog } = require('../_db');
const { requireAuth } = require('../_auth');
const { validateStr, validateNum } = require('../_validate');
const { wrap } = require('../_handler');
const { suggestLyricsWithAI } = require('../_ai');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { LYRICS_SOURCES, plainFromSynced } = require('../_lyrics');
const logger = require('../_logger');

module.exports = wrap(async function handler(req, res) {
  const { band: slug } = req.query;
  const sql = getDb();

  if (req.method === 'GET') {
    const band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
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
      WHERE s.band_id = ${band.id} AND s.deleted = false
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
      WHERE s.id = ${songId} AND s.band_id = ${band.id} AND s.deleted = false
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
      WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
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
      SELECT id FROM songs WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    await sql`UPDATE songs SET extra = extra - 'lyrics' WHERE id = ${songId} AND band_id = ${band.id}`;
    return res.json({ ok: true });
  }

  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const { title: rawTitle, active, key: rawKey, genre: rawCat, tempo: rawTempo,
            bpm: rawBpm, length_min: rawLen, interpret: rawInterp, reference_interpret: rawRef,
            comment: rawComment, extra } = req.body ?? {};

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title required' });
    const key = validateStr(rawKey, 20);
    if (key === false) return res.status(400).json({ error: 'key too long' });
    const genre = validateStr(rawCat, 100);
    if (genre === false) return res.status(400).json({ error: 'genre too long' });
    const tempo = validateStr(rawTempo, 50);
    if (tempo === false) return res.status(400).json({ error: 'tempo too long' });
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
      INSERT INTO songs (band_id, title, active, key, genre, tempo, bpm, length_min,
                         interpret, reference_interpret, comment, extra)
      VALUES (${band.id}, ${title}, ${active ?? true}, ${key},
              ${genre}, ${tempo}, ${bpm}, ${length_min},
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
      const tempo = validateStr(update.tempo, 50);
      if (tempo === false) continue;
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
          key                 = ${key},
          genre            = ${genre},
          tempo               = ${tempo},
          bpm                 = ${bpm},
          length_min          = ${length_min},
          interpret           = ${interpret},
          reference_interpret = ${reference_interpret},
          comment             = ${comment},
          extra               = songs.extra || ${update.extra ?? {}}
        WHERE id = ${songId} AND band_id = ${band.id}
        RETURNING *
      `;
      if (updated) { await insertAuditLog(sql, band.id, updated.id, 'update', updated); applied++; }
    }
    return res.json({ ok: true, count: applied });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
