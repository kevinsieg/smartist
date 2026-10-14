'use strict';

// Melodies: one row per song and band instrument, holding sheet images and an
// audio recording. Plain input in, data out; handlers adapt to req/res.

const MELODY_LIMITS = { perSong: 20, images: 8, imageBytes: 5 * 1024 * 1024, audioBytes: 50 * 1024 * 1024 };
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

// The melody row for the song itself, not for one voice: sheet images only.
const SONG_KEY = '_song';

function instrumentKnown(band, key) {
  if (typeof key !== 'string') return false;
  const list = band?.config?.arrangementConfig?.instruments;
  return Array.isArray(list) && list.some(i => i && i.key === key);
}

function listMelodies(sql, artistId, songId) {
  return sql`
    SELECT id, instrument, sheet_urls, audio_url, waveform, updated_at
    FROM song_melodies
    WHERE song_id = ${songId} AND artist_id = ${artistId}
    ORDER BY created_at, id`;
}

async function getMelody(sql, artistId, songId, instrument) {
  const [row] = await sql`
    SELECT id, instrument, sheet_urls, audio_url, waveform
    FROM song_melodies
    WHERE song_id = ${songId} AND artist_id = ${artistId} AND instrument = ${instrument}`;
  return row;
}

module.exports = { SONG_KEY, MELODY_LIMITS, IMAGE_EXTS, IMAGE_TYPES, instrumentKnown, listMelodies, getMelody };
