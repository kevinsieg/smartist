'use strict';

// Energy is a 0–10 integer. Imports and old song_logs snapshots may still hold
// percentages or words; this maps them.
// Returns the scale value, null for empty, undefined when it cannot be read.
const ENERGY_WORDS = { low: 2, slow: 2, mid: 5, middle: 5, medium: 5, high: 8, fast: 8 };

function energyToScale(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const word = ENERGY_WORDS[s.toLowerCase()];
  if (word !== undefined) return word;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n > 10 ? n / 10 : n);
}

// Two genres are the same genre when they differ only in case, spacing or
// punctuation. & is kept: R&B is not RB.
function genreKey(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}&]/gu, '');
}

// A genre typed in a new casing is stored in the spelling the workspace already
// uses; a genre it has never seen is kept as typed.
function matchGenre(value, known) {
  if (!value) return value;
  const k = genreKey(value);
  return known.find(g => genreKey(g) === k) ?? value;
}

module.exports = { energyToScale, matchGenre };
