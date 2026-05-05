const { getDb, getBand, insertAuditLog } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { wrap } = require('../../_handler');
const { checkRateLimit, clientIp } = require('../../_ratelimit');
const { suggestLyricsWithAI } = require('../../_ai');
const { makeMediaFn } = require('../../_media');
const logger = require('../../_logger');

const MEDIA = {
  audio:    makeMediaFn({ keyPrefix: 'audio/',    extraKey: 'listenUrl',   maxBytes: 50*1024*1024, actionPrefix: 'audio',    allowedExts: new Set(['mp3','m4a','ogg','wav','flac']), mimePrefix: 'audio/' }),
  sheet:    makeMediaFn({ keyPrefix: 'sheets/',   extraKey: 'sheetUrl',    maxBytes: 20*1024*1024, actionPrefix: 'sheet',    mimePrefix: 'application/pdf' }),
  playback: makeMediaFn({ keyPrefix: 'playback/', extraKey: 'playbackUrl', maxBytes: 50*1024*1024, actionPrefix: 'playback', allowedExts: new Set(['mp3','m4a','ogg','wav','flac']), mimePrefix: 'audio/' }),
};

const SOURCES = ['lyrics.ovh', 'lrclib', 'ai'];

function _plainFromSynced(synced) {
  return synced?.replace(/\[\d+:\d+\.\d+\]/g, '').trim() ?? '';
}

module.exports = wrap(async function handler(req, res) {
  // vercel dev 52.x does not populate req.query.path for catch-alls inside dynamic dirs
  const pathParts = Array.isArray(req.query.path) && req.query.path.length
    ? req.query.path
    : req.url.split('?')[0].split('/songs/')[1]?.split('/') ?? [];
  const [rawId, action] = pathParts;
  const songId = Number(rawId);
  if (!Number.isInteger(songId) || songId <= 0)
    return res.status(400).json({ error: 'Invalid song id' });

  const slug = req.query.band || req.url.split('?')[0].split('/')[2];

  // ── Media (audio, sheet, playback) ────────────────────────────────────────
  if (action in MEDIA) {
    req.query.id = rawId;
    return MEDIA[action](req, res);
  }

  // ── DELETE song ───────────────────────────────────────────────────────────
  if (!action) {
    if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const sql = getDb();
    const [song] = await sql`
      UPDATE songs SET deleted = true
      WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
      RETURNING *
    `;
    if (!song) return res.status(404).json({ error: 'Song not found' });

    await insertAuditLog(sql, band.id, songId, 'delete', song);
    return res.status(204).end();
  }

  // ── POST restore ──────────────────────────────────────────────────────────
  if (action === 'restore') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const sql = getDb();
    const [log] = await sql`
      SELECT * FROM song_logs
      WHERE song_id = ${songId} AND band_id = ${band.id} AND action = 'delete'
      ORDER BY changed_at DESC
      LIMIT 1
    `;
    if (!log) return res.status(404).json({ error: 'No delete record found for this song' });

    let song;
    const [existing] = await sql`
      SELECT id FROM songs WHERE id = ${songId} AND band_id = ${band.id} AND deleted = true
    `;
    if (existing) {
      [song] = await sql`
        UPDATE songs SET deleted = false
        WHERE id = ${songId} AND band_id = ${band.id}
        RETURNING *
      `;
    } else {
      const d = log.song_data;
      [song] = await sql`
        INSERT INTO songs (band_id, title, active, key, genre, tempo, length_min,
                           interpret, reference_interpret, comment, extra)
        VALUES (${band.id}, ${d.title}, ${d.active ?? true}, ${d.key ?? null},
                ${d.genre ?? null}, ${d.tempo ?? null}, ${d.length_min ?? null},
                ${d.interpret ?? null}, ${d.reference_interpret ?? null},
                ${d.comment ?? null}, ${d.extra ?? {}})
        RETURNING *
      `;
    }

    await insertAuditLog(sql, band.id, song.id, 'create', song);
    return res.status(201).json(song);
  }

  // ── GET setlist appearances ───────────────────────────────────────────────
  if (action === 'setlists') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });

    const sql = getDb();
    const setlists = await sql`
      SELECT sl.id, sl.title, sl.comment, sl.created_at,
             g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue
      FROM setlists sl
      JOIN setlist_songs ss ON ss.setlist_id = sl.id
      LEFT JOIN gigs g ON sl.gig_id = g.id
      WHERE ss.song_id = ${songId} AND sl.band_id = ${band.id}
      ORDER BY sl.created_at DESC
    `;
    return res.json(setlists);
  }

  // ── GET GEMA data ─────────────────────────────────────────────────────────
  if (action === 'gema') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });

    const sql = getDb();
    const works = await sql`
      SELECT * FROM gema_works
      WHERE band_id = ${band.id} AND song_id = ${songId}
      ORDER BY gema_work_number
    `;
    if (!works.length) return res.json({ works: [], rightholders: [] });

    const workIds = works.map(w => w.id);
    const rightholders = await sql`
      SELECT r.*, g.gema_work_number
      FROM gema_rightholders r
      JOIN gema_works g ON g.id = r.gema_work_id
      WHERE r.gema_work_id = ANY(${workIds})
      ORDER BY g.gema_work_number, r.role, r.role_order NULLS LAST, r.name
    `;
    return res.json({ works, rightholders });
  }

  // ── PUT/DELETE lyrics ─────────────────────────────────────────────────────
  if (action === 'lyrics') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const sql = getDb();

    if (req.method === 'PUT') {
      const { lyrics } = req.body ?? {};
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

    if (req.method === 'DELETE') {
      const [song] = await sql`
        SELECT id FROM songs WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
      `;
      if (!song) return res.status(404).json({ error: 'Song not found' });

      await sql`UPDATE songs SET extra = extra - 'lyrics' WHERE id = ${songId} AND band_id = ${band.id}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── POST lyrics-suggest ───────────────────────────────────────────────────
  if (action === 'lyrics-suggest') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const sql = getDb();
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

    const ip = clientIp(req);
    if (await checkRateLimit(`lyrics-suggest:${band.id}:${songId}`, 3, 300)) {
      await logger.warn('rate_limit_lyrics_suggest', { band: slug, songId, ip, key: 'per-song' });
      return res.status(429).json({ error: 'Too many requests — wait a few minutes' });
    }
    if (await checkRateLimit(`lyrics-suggest-ip:${ip}`, 10, 3600)) {
      await logger.warn('rate_limit_lyrics_suggest', { band: slug, songId, ip, key: 'per-ip' });
      return res.status(429).json({ error: 'Too many requests — try again later' });
    }

    const title    = song.title.replace(/\b\w/g, c => c.toUpperCase());
    const language = song.language || null;
    const genre    = song.genre    || null;
    const ctx      = { bandId: band.id, songId, title, artist, language, genre };
    const found    = (lyrics, source) => res.json({ lyrics, source, sources: SOURCES });
    const miss     = (aiSkipped = false) => res.json({ lyrics: null, sources: SOURCES, aiSkipped });

    try {
      const r = await fetch(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const data = await r.json();
        if (data.lyrics?.length > 50) {
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
        `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`,
        { headers: { 'Lrclib-Client': 'smartist-band-tools' }, signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const data   = await r.json();
        const lyrics = data.plainLyrics || _plainFromSynced(data.syncedLyrics);
        if (lyrics?.length > 50) {
          await logger.info('lyrics_suggest', { ...ctx, source: 'lrclib' });
          return found(lyrics.trim(), 'lrclib');
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

  return res.status(404).json({ error: 'Not found' });
});
