'use strict';

// Melodies: a band instrument's sheet images and recording on a song, kept as
// song_media rows (see media.js). Plain input in, data out; handlers adapt to req/res.

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

// song_media stores the whole song's sheet pages with no instrument.
const voiceKey = instrument => (instrument === SONG_KEY ? null : instrument);

module.exports = { SONG_KEY, MELODY_LIMITS, IMAGE_EXTS, IMAGE_TYPES, instrumentKnown, voiceKey };
