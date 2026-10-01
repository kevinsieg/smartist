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

// ── Field specs ───────────────────────────────────────────────────────────────
// A resource's writable fields as one table, so create and update validate the
// same fields the same way (they used to drift: update skipped half of them and
// could not clear a field, because `body.x ?? stored.x` turns null into "keep").
//
//   const VENUE = { name: F.text(200, { required: true }), website: F.url(), size: F.int(0, 1e7) };
//   const { value, error } = parseFields(req.body, VENUE, { partial: true });
//
// Only fields present in the body end up in `value`; an empty value ('' or
// null) clears the field unless it is required or not nullable. Unknown keys
// are ignored. `value` maps column names to clean values, ready for sql(value).
const F = {
  text:   (max, opts = {}) => ({ type: 'text', max, ...opts }),
  url:    (max = 500, opts = {}) => ({ type: 'url', max, ...opts }),
  email:  (opts = {}) => ({ type: 'email', max: 254, ...opts }),
  int:    (min, max, opts = {}) => ({ type: 'int', min, max, ...opts }),
  num:    (min, max, opts = {}) => ({ type: 'num', min, max, ...opts }),
  bool:   (opts = {}) => ({ type: 'bool', nullable: false, ...opts }),
  date:   (opts = {}) => ({ type: 'date', ...opts }),
  time:   (opts = {}) => ({ type: 'time', ...opts }),
  object: (opts = {}) => ({ type: 'object', ...opts }),
};

// Serialized size of a JSON value: free-form fields are capped by it so one
// request cannot park megabytes in a row that every list then ships.
function jsonBytes(v) {
  return Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

// → { value } or { error }
function parseField(name, f, raw) {
  const empty = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
  if (empty) {
    if (f.required) return { error: `${name} is required` };
    if (f.nullable === false) return { error: `${name} cannot be empty` };
    return { value: null };
  }
  switch (f.type) {
    case 'text': {
      const v = validateStr(raw, f.max);
      return v === false ? { error: `${name} too long (max ${f.max})` } : { value: v };
    }
    case 'url': {
      let v = validateStr(raw, f.max);
      if (v === false) return { error: `${name} too long (max ${f.max})` };
      // "www.example.com" as typed into a form: an https link, not an error.
      if (f.addScheme && !/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s/]+\.[^\s]+$/.test(v)) v = 'https://' + v;
      return /^https?:\/\/\S+$/i.test(v) ? { value: v } : { error: `${name} must be an http(s) URL` };
    }
    case 'email': {
      const v = validateEmail(raw);
      return v ? { value: v } : { error: `${name} must be an email address` };
    }
    case 'int':
    case 'num': {
      const n = Number(raw);
      if (!Number.isFinite(n) || (f.type === 'int' && !Number.isInteger(n))) return { error: `${name} must be a${f.type === 'int' ? 'n integer' : ' number'}` };
      if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) return { error: `${name} must be between ${f.min} and ${f.max}` };
      return { value: n };
    }
    case 'bool':
      if (raw === true || raw === 'true') return { value: true };
      if (raw === false || raw === 'false') return { value: false };
      return { error: `${name} must be true or false` };
    case 'date': {
      // Accepts YYYY-MM-DD and the full ISO timestamp a date column comes back as.
      const m = DATE_RE.exec(raw instanceof Date ? raw.toISOString() : String(raw).trim());
      if (!m) return { error: `${name} must be a date (YYYY-MM-DD)` };
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return { error: `${name} is not a valid date` };
      return { value: `${m[1]}-${m[2]}-${m[3]}` };
    }
    case 'time': {
      const m = TIME_RE.exec(String(raw).trim());
      return m ? { value: `${m[1]}:${m[2]}:${m[3] || '00'}` } : { error: `${name} must be a time (HH:MM)` };
    }
    case 'object':
      if (typeof raw !== 'object' || Array.isArray(raw)) return { error: `${name} must be an object` };
      if (f.maxBytes && jsonBytes(raw) > f.maxBytes) return { error: `${name} is too large` };
      return { value: raw };
    default:
      return { error: `${name}: unknown field type` };
  }
}

// partial: false — every required field must be present (create).
// partial: true  — only what is present is checked (update).
function parseFields(body, spec, { partial = false } = {}) {
  const src = body && typeof body === 'object' ? body : {};
  const value = {};
  for (const [name, f] of Object.entries(spec)) {
    if (!(name in src)) {
      if (!partial && f.required) return { error: `${name} is required` };
      continue;
    }
    const r = parseField(name, f, src[name]);
    if (r.error) return { error: r.error };
    value[name] = r.value;
  }
  return { value };
}

module.exports = { validateSongIds, validateStr, validateNum, validateEmail, F, parseFields, jsonBytes };
