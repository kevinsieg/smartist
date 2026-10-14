'use strict';

// song_media: every additional file or link of a song (see scripts/schema.sql).
// Plain input in, data out. Reads of a song go through the songs_with_media
// view; these helpers fold rows into the shapes the clients read and save the
// three link fields of the song form.

const { SONG_KEY, voiceKey } = require('./melodies');

// The song form's fields and the kind each one is stored as.
const LINK_KINDS = { listenUrl: 'listen', playbackUrl: 'playback', sheetUrl: 'pdf' };

// Rows of one song (id, kind, instrument, url, waveform, position, updated_at)
// as the melodies the client reads: one entry per voice, and `_song` for the
// whole song's images, each with its pages in order and its recording.
function melodiesFromMedia(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    if (r.kind !== 'sheet' && r.kind !== 'instrument') continue;
    const key = r.instrument ?? SONG_KEY;
    if (!byKey.has(key)) byKey.set(key, { id: r.id, instrument: key, pages: [], audio_url: null, waveform: null, updated_at: r.updated_at });
    const m = byKey.get(key);
    if (r.kind === 'sheet') m.pages.push(r);
    else { m.audio_url = r.url; m.waveform = r.waveform ?? null; }
    if (r.updated_at > m.updated_at) m.updated_at = r.updated_at;
  }
  return [...byKey.values()].map(({ pages, ...m }) => ({
    ...m,
    sheet_urls: pages.sort((a, b) => a.position - b.position || a.id - b.id).map(p => p.url),
  }));
}

// The song's extra keys that come from its media rows.
function songLinks(rows) {
  const out = {};
  for (const r of rows || []) {
    if (r.kind === 'listen') { out.listenUrl = r.url; if (r.waveform) out.waveform = r.waveform; }
    else if (r.kind === 'playback') { out.playbackUrl = r.url; if (r.waveform) out.playbackWaveform = r.waveform; }
    else if (r.kind === 'pdf') out.sheetUrl = r.url;
  }
  return out;
}

// Saves the link fields present in `links` (a string sets, an empty value or
// null removes); absent keys are left alone. A recording keeps its waveform
// when the same address is saved again, as the song form does with every save.
async function setSongLinks(sql, artistId, songId, links) {
  const writes = [];
  for (const [key, kind] of Object.entries(LINK_KINDS)) {
    if (!links || !(key in links)) continue;
    const url = typeof links[key] === 'string' ? links[key].trim() : '';
    if (!url) {
      writes.push(sql`DELETE FROM song_media WHERE song_id = ${songId} AND artist_id = ${artistId} AND kind = ${kind}`);
      continue;
    }
    const onKind = kind === 'listen' ? sql`WHERE kind = 'listen'` : kind === 'playback' ? sql`WHERE kind = 'playback'` : sql`WHERE kind = 'pdf'`;
    writes.push(sql`
      INSERT INTO song_media (song_id, artist_id, kind, url)
      SELECT s.id, s.artist_id, ${kind}::text, ${url}::text FROM songs s
      WHERE s.id = ${songId} AND s.artist_id = ${artistId} AND NOT s.deleted
      ON CONFLICT (song_id) ${onKind} DO UPDATE
        SET url = EXCLUDED.url, waveform = NULL, updated_at = NOW()
        WHERE song_media.url <> EXCLUDED.url`);
  }
  await Promise.all(writes);
}

// One melody (a voice, or the whole song as `_song`) of a song, as melodiesFromMedia
// shapes it, or undefined when it holds nothing.
async function getMelody(sql, artistId, songId, instrument) {
  const key = voiceKey(instrument);
  const rows = await sql`
    SELECT id, kind, instrument, url, waveform, position, updated_at FROM song_media
    WHERE song_id = ${songId} AND artist_id = ${artistId} AND kind IN ('instrument', 'sheet')
      AND instrument IS NOT DISTINCT FROM ${key}::text
    ORDER BY id`;
  return melodiesFromMedia(rows)[0];
}

const MEDIA_EXTRA_KEYS = [...Object.keys(LINK_KINDS), 'waveform', 'playbackWaveform'];

// The song form's link keys out of an `extra` patch: `rest` is stored on the
// song, `links` (the keys that were present) go to setSongLinks.
function splitLinks(extra) {
  if (!extra || typeof extra !== 'object') return { rest: extra, links: {} };
  const rest = {}, links = {};
  for (const [k, v] of Object.entries(extra)) (k in LINK_KINDS ? links : rest)[k] = v;
  return { rest, links };
}

// Song rows as a write returns them (RETURNING …) with their media keys in
// `extra`, as the songs_with_media view gives them to a read: one query for all.
async function withMedia(sql, songs) {
  if (!songs.length) return songs;
  const found = await sql`
    SELECT song_id, kind, url, waveform FROM song_media
    WHERE song_id = ANY(${songs.map(s => s.id)}::int[]) AND kind IN ('listen', 'playback', 'pdf')`;
  return songs.map(song => {
    const extra = { ...(song.extra || {}) };
    for (const k of MEDIA_EXTRA_KEYS) delete extra[k];
    return { ...song, extra: { ...extra, ...songLinks(found.filter(r => r.song_id === song.id)) } };
  });
}

module.exports = { LINK_KINDS, melodiesFromMedia, getMelody, songLinks, setSongLinks, splitLinks, withMedia };
