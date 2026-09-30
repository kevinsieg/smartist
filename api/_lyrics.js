'use strict';

const LYRICS_SOURCES = ['lyrics.ovh', 'lrclib', 'ai'];

function plainFromSynced(synced) {
  return synced?.replace(/\[\d+:\d+\.\d+\]/g, '').trim() ?? '';
}

// Look lyrics up for one song: lyrics.ovh, then lrclib, then the AI provider.
// Behind POST /api/:artist/songs/:id/lyrics/suggest (songs/item.js).
// Returns { status, body }. Required lazily so the pure helpers above stay
// loadable without the database or logger.
// The AI step is the only one that costs money. The public demo hands anyone a
// member session, so it gets the free sources only, and every band together
// shares a daily cap: the per-IP limit alone let many addresses spend without end.
// A per-band cap under the global one keeps a single band (any free sign-up)
// from spending the whole day's budget for everyone else.
const AI_DAILY_MAX = 500;
const AI_BAND_DAILY_MAX = 50;

// opts.allowAI: false skips the AI step (the demo session).
async function suggestLyrics(sql, band, songId, ip, { allowAI = true } = {}) {
  const { lyricsSearchInfo } = require('./_domain/songs');
  const { checkRateLimit } = require('./_ratelimit');
  const { suggestLyricsWithAI } = require('./_ai');
  const logger = require('./_logger');

  const song = await lyricsSearchInfo(sql, band.id, songId);
  if (!song) return { status: 404, body: { error: 'Song not found' } };

  const artist = song.reference_interpret || song.interpret;
  if (!artist) return { status: 400, body: { error: 'No artist on this song — cannot search for lyrics' } };

  if (await checkRateLimit(`lyrics-suggest:${band.id}:${songId}`, 3, 300))
    return { status: 429, body: { error: 'Too many requests. Try again in a few minutes.' } };
  if (await checkRateLimit(`lyrics-suggest-ip:${ip}`, 10, 3600))
    return { status: 429, body: { error: 'Too many requests from this IP.' } };

  const { title, language, genre } = song;
  const ctx = { band: band.slug, songId, title, artist };
  const found = (lyrics, source) => ({ status: 200, body: { lyrics, source, sources: LYRICS_SOURCES } });

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

  const aiAllowed = allowAI
    && !(await checkRateLimit(`lyrics-ai-day:${band.id}`, AI_BAND_DAILY_MAX, 86400))
    && !(await checkRateLimit('lyrics-ai-day', AI_DAILY_MAX, 86400));
  const { lyrics, skipped } = aiAllowed
    ? await suggestLyricsWithAI(title, artist, { language, genre })
    : { lyrics: null, skipped: true };
  if (lyrics) {
    await logger.info('lyrics_suggest', { ...ctx, source: 'ai' });
    return found(lyrics, 'ai');
  }
  await logger.info('lyrics_suggest_miss', { ...ctx, source: 'ai', skipped: skipped ?? false });
  return { status: 200, body: { lyrics: null, sources: LYRICS_SOURCES, aiSkipped: skipped ?? false } };
}

module.exports = { LYRICS_SOURCES, AI_DAILY_MAX, AI_BAND_DAILY_MAX, plainFromSynced, suggestLyrics };
