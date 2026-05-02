// Returns validated array of positive integers (max 200, unique), or null if invalid.
function validateSongIds(song_ids) {
  if (!Array.isArray(song_ids)) return null;
  if (song_ids.length > 200) return null;
  const ids = song_ids.map(Number).filter(n => Number.isFinite(n) && Number.isInteger(n) && n > 0);
  if (ids.length !== song_ids.length) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

// Returns trimmed string if valid, null if empty/missing, false if exceeds maxLen.
function validateStr(val, maxLen) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  if (!s) return null;
  if (s.length > maxLen) return false;
  return s;
}

// Returns finite number if valid, null if empty/missing, false if not a number.
function validateNum(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : false;
}

// Returns lowercase email if valid format, null if empty/missing, false if bad format.
function validateEmail(val) {
  if (!val) return null;
  const e = String(val).trim().toLowerCase();
  if (!e) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : false;
}

module.exports = { validateSongIds, validateStr, validateNum, validateEmail };
