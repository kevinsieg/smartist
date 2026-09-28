'use strict';

const LYRICS_SOURCES = ['lyrics.ovh', 'lrclib', 'ai'];

function plainFromSynced(synced) {
  return synced?.replace(/\[\d+:\d+\.\d+\]/g, '').trim() ?? '';
}

// Look lyrics up for one song: lyrics.ovh, then lrclib, then the AI provider.
// Shared by the body-dispatched POST in songs.js and the catch-all route.
// Returns { status, body }. Required lazily so the pure helpers above stay
// loadable without the database or logger.
async function suggestLyrics(sql, band, songId, ip) {
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

  const { lyrics, skipped } = await suggestLyricsWithAI(title, artist, { language, genre });
  if (lyrics) {
    await logger.info('lyrics_suggest', { ...ctx, source: 'ai' });
    return found(lyrics, 'ai');
  }
  await logger.info('lyrics_suggest_miss', { ...ctx, source: 'ai', skipped: skipped ?? false });
  return { status: 200, body: { lyrics: null, sources: LYRICS_SOURCES, aiSkipped: skipped ?? false } };
}

module.exports = { LYRICS_SOURCES, plainFromSynced, suggestLyrics };
