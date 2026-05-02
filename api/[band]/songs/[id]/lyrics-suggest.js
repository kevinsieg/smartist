const { getDb } = require('../../../_db');
const { requireAuth } = require('../../../_auth');
const { wrap } = require('../../../_handler');
const { checkRateLimit, clientIp } = require('../../../_ratelimit');
const { suggestLyricsWithAI } = require('../../../_ai');
const logger = require('../../../_logger');

// Ordered list of sources tried. Returned in every response so the client can
// display what was searched. Add new sources here when extending the pipeline.
const SOURCES = ['lyrics.ovh', 'lrclib', 'ai'];

// lrclib returns timed/synced lyrics ("[00:12.34] some line\n…"); strip timestamps.
function _plainFromSynced(synced) {
  return synced?.replace(/\[\d+:\d+\.\d+\]/g, '').trim() ?? '';
}

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug, id } = req.query;
  const songId = Number(id);
  if (!Number.isInteger(songId) || songId <= 0)
    return res.status(400).json({ error: 'Invalid song id' });

  const band = await requireAuth(req, res, slug);
  if (!band) return;

  const sql = getDb();
  // Pull language from GEMA data if linked, fall back to songs.extra.language (user-editable).
  // Used to tell the AI to return lyrics in the original language rather than translating.
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

  // Use the original/reference artist — lyrics sites index by original artist, not cover band.
  const artist = song.reference_interpret || song.interpret;
  if (!artist) return res.status(400).json({ error: 'No artist on this song — cannot search for lyrics' });

  // Rate-limit after the DB lookup so ghost song IDs don't consume budget.
  if (await checkRateLimit(`lyrics-suggest:${band.id}:${songId}`, 3, 300))
    return res.status(429).json({ error: 'Too many requests — wait a few minutes' });
  if (await checkRateLimit(`lyrics-suggest-ip:${clientIp(req)}`, 10, 3600))
    return res.status(429).json({ error: 'Too many requests — try again later' });

  // Normalise to Title Case — several APIs are case-sensitive.
  const title    = song.title.replace(/\b\w/g, c => c.toUpperCase());
  const language = song.language || null;
  const genre    = song.genre    || null;
  const ctx   = { bandId: band.id, songId, title, artist, language, genre };
  const found    = (lyrics, source) => res.json({ lyrics, source, sources: SOURCES });
  const miss     = (aiSkipped = false) => res.json({ lyrics: null, sources: SOURCES, aiSkipped });

  // ── 1. lyrics.ovh ─────────────────────────────────────────────────────────
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

  // ── 2. lrclib.net ─────────────────────────────────────────────────────────
  try {
    const r = await fetch(
      `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`,
      { headers: { 'Lrclib-Client': 'salmons-band-tools' }, signal: AbortSignal.timeout(6000) }
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

  // ── 3. AI (knowledge-based, configured in api/_ai.js) ─────────────────────
  const { lyrics, skipped } = await suggestLyricsWithAI(title, artist, { language, genre });
  if (lyrics) {
    await logger.info('lyrics_suggest', { ...ctx, source: 'ai' });
    return found(lyrics, 'ai');
  }

  await logger.info('lyrics_suggest_miss', { ...ctx, source: 'ai', skipped: skipped ?? false });
  return miss(skipped ?? false);
});
