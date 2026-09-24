'use strict';

// Energy is a 0–10 integer. Older rows hold 1–10, percentages or words; this is
// the one mapping the API and the migration share.
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

function titleCaseGenre(s) {
  return String(s).trim().replace(/\s+/g, ' ')
    .replace(/\p{L}+/gu, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// [{ value, n }] sorted by use, most used first → { spelling: canonical } for every
// spelling that changes. Per group of same-key spellings the most used one wins,
// Title-Cased when it is all upper or all lower case. Acronyms (R&B, EDM) come out
// wrong and are fixed by hand in the reviewed map file.
function proposeGenreMap(counts) {
  const groups = new Map();
  for (const c of counts) {
    const k = genreKey(c.value);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c.value);
  }
  const map = {};
  for (const spellings of groups.values()) {
    const top = spellings[0].trim();
    const canonical = top === top.toUpperCase() || top === top.toLowerCase() ? titleCaseGenre(top) : top;
    for (const v of spellings) if (v !== canonical) map[v] = canonical;
  }
  return map;
}

module.exports = { energyToScale, genreKey, matchGenre, titleCaseGenre, proposeGenreMap };
