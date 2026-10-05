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
// member session, so it gets the free sources only. The stops are per band
// (AI_BAND_DAILY_MAX) and per person across all their bands
// (AI_PERSON_DAILY_MAX): a workspace costs one click, so a cap per band alone
// let one account multiply it. Everyone together past AI_DAILY_ALARM raises an
// alarm, not a refusal — as a hard stop, a few free accounts could switch AI
// lyrics off for every band for the day. AI_DAILY_MAX is the hard cost
// ceiling, far above normal use.
const AI_DAILY_ALARM = 500;
const AI_DAILY_MAX = 5000;
const AI_BAND_DAILY_MAX = 50;
const AI_PERSON_DAILY_MAX = 100;

// opts.allowAI: false skips the AI step (the demo session). opts.who: the
// session's address, for the cap per person.
async function suggestLyrics(sql, band, songId, ip, { allowAI = true, who = null } = {}) {
  const { lyricsSearchInfo } = require('./_domain/songs');
  const { checkRateLimit, countInWindows, alarmAt, personKey } = require('./_ratelimit');
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

  let aiAllowed = false;
  if (allowAI && who) {
    const bandKey = `lyrics-ai-day:${band.id}`, personK = personKey('lyrics-ai-person', who);
    const n = await countInWindows([
      { key: bandKey, windowSecs: 86400 },
      { key: personK, windowSecs: 86400 },
      { key: 'lyrics-ai-day', windowSecs: 86400 },
    ]);
    await alarmAt(n.get('lyrics-ai-day'), 'lyrics-ai-day', AI_DAILY_ALARM);
    aiAllowed = n.get(bandKey) <= AI_BAND_DAILY_MAX && n.get(personK) <= AI_PERSON_DAILY_MAX
      && n.get('lyrics-ai-day') <= AI_DAILY_MAX;
  }
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

module.exports = {
  LYRICS_SOURCES, plainFromSynced, suggestLyrics,
  AI_DAILY_ALARM, AI_DAILY_MAX, AI_BAND_DAILY_MAX, AI_PERSON_DAILY_MAX,
};
