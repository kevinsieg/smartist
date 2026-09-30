'use strict';

// CSV song import (POST /api/:artist/songs/import).
//
// The songs page offers a template whose header row is COLUMNS' names. An
// uploaded file is parsed here, every row is checked against the same rules
// as a song created by hand, and duplicates are flagged: a title (ignoring
// case and spacing) that the band already has, or that an earlier row of the
// file has. Nothing is written until every row that is not skipped passes —
// the page shows the problems, the user fixes or skips rows and checks again.

const { energyToScale, matchGenre, cleanTags } = require('../_song_values');
const { LYRICS_MAX } = require('./songs');

const MAX_ROWS = 1000;
const MAX_CSV = 4_000_000;

const KEYS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭',
  'Am', 'Em', 'Bm', 'F♯m', 'C♯m', 'G♯m', 'D♯m', 'A♯m', 'Dm', 'Gm', 'Cm', 'Fm', 'B♭m', 'E♭m', 'A♭m',
];
const LANGUAGE_WORDS = {
  ENGLISH: 'EN', ENGLISCH: 'EN', ANGLAIS: 'EN',
  GERMAN: 'DE', DEUTSCH: 'DE', ALLEMAND: 'DE',
  FRENCH: 'FR', FRANZOESISCH: 'FR', FRANZÖSISCH: 'FR', FRANÇAIS: 'FR', FRANCAIS: 'FR',
};
const TRUE_WORDS  = ['true', 'yes', 'y', '1', 'x', 'ja', 'j', 'oui', 'wahr', '✓'];
const FALSE_WORDS = ['false', 'no', 'n', '0', 'nein', 'non', 'falsch'];

// The template, in the order of the song form. `field` is the songs column,
// or extra.<key> for keys kept in songs.extra. Aliases are the export's column
// labels (EN/FR/DE) and the older keys, so an exported file imports as well.
const COLUMNS = [
  { name: 'title',               field: 'title',                type: 'text', max: 200, required: true,
    aliases: ['titel', 'titre', 'song', 'songtitle', 'name'] },
  { name: 'active',              field: 'active',               type: 'bool', aliases: ['aktiv', 'actif'] },
  { name: 'favourite',           field: 'heart',                type: 'bool', aliases: ['favorite', 'heart', '♥', 'favorit', 'favori'] },
  { name: 'key',                 field: 'key',                  type: 'key',  aliases: ['tonart', 'tonalite', 'tonalité'] },
  { name: 'bpm',                 field: 'bpm',                  type: 'bpm',  aliases: ['tempo'] },
  { name: 'time_signature',      field: 'time_signature',       type: 'timesig', aliases: ['timesig', 'takt', 'mesure'] },
  { name: 'length',              field: 'length_min',           type: 'length', aliases: ['lengthmin', 'duration', 'länge', 'lange', 'durée', 'duree', 'dauer'] },
  { name: 'language',            field: 'language',             type: 'language', aliases: ['lang', 'sprache', 'langue'] },
  { name: 'genre',               field: 'genre',                type: 'text', max: 100, aliases: [] },
  { name: 'tags',                field: 'tags',                 type: 'tags', aliases: ['tag'] },
  { name: 'energy',              field: 'energy',               type: 'energy', aliases: ['energie', 'énergie'] },
  { name: 'reference_interpret', field: 'reference_interpret',  type: 'text', max: 500,
    aliases: ['referenzinterpret', 'interpretedereference', 'interprètedeférence'] },
  { name: 'reference_url',       field: 'extra.referenceUrl',   type: 'url',  aliases: ['referenceurl', 'referenzurl', 'urldereference'] },
  { name: 'songinfo_url',        field: 'extra.songinfoUrl',    type: 'url',  aliases: ['songinfourl', 'urldinfochanson'] },
  { name: 'comment',             field: 'comment',              type: 'text', max: 2000, aliases: ['kommentar', 'commentaire', 'notes', 'note'] },
  { name: 'lead',                field: 'extra.lead',           type: 'text', max: 200, aliases: [] },
  { name: 'guitar2',             field: 'extra.git2',           type: 'bool', aliases: ['git2', '2ndguitar', '2gitarre', '2èmeguitare'] },
  { name: 'harmonica',           field: 'extra.harp',           type: 'bool', aliases: ['harp', 'mundharmonika'] },
  { name: 'guitar_capo',         field: 'extra.gitCapo',        type: 'capo', aliases: ['gitcapo', 'gitarrecapo', 'capoguitare', 'capo'] },
  { name: 'banjo_capo',          field: 'extra.banjoCapo',      type: 'capo', aliases: ['banjocapo', 'capobanjo'] },
  { name: 'author',              field: 'extra.author',         type: 'text', max: 500, aliases: ['autor', 'auteur', 'composer', 'komponist', 'compositeur'] },
  { name: 'lyricist',            field: 'extra.lyricist',       type: 'text', max: 500, aliases: ['textdichter', 'parolier', 'texter'] },
  { name: 'interpret',           field: 'interpret',            type: 'text', max: 200, aliases: ['interprete', 'interprète', 'artist', 'künstler'] },
  { name: 'label',               field: 'extra.label',          type: 'text', max: 200, aliases: ['recordlabel'] },
  { name: 'publisher',           field: 'extra.publisher',      type: 'text', max: 200, aliases: ['verlag', 'editeur', 'éditeur'] },
  { name: 'lyrics',              field: 'lyrics',               type: 'lyrics', aliases: ['paroles', 'songtext', 'text'] },
];
const BY_NAME = new Map(COLUMNS.map(c => [c.name, c]));

// Header cells match whatever their case, spacing or punctuation.
function headerKey(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}♥]/gu, '');
}
const BY_HEADER = new Map();
for (const c of COLUMNS) for (const h of [c.name, c.field, ...c.aliases]) BY_HEADER.set(headerKey(h), c);

// Two titles are the same song when they differ only in case and spacing.
function titleKey(s) {
  return cleanCell(s ?? '', false).toLowerCase();
}

// ── CSV ───────────────────────────────────────────────────────────────────────

// Excel writes ; in German and French locales, a spreadsheet may export tabs:
// the delimiter is whichever of the three occurs most in the header line.
function detectDelimiter(text) {
  let best = ',', bestCount = 0, inQuotes = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  for (const [d, n] of Object.entries(counts)) if (n > bestCount) { best = d; bestCount = n; }
  return best;
}

// RFC 4180: quoted cells may hold the delimiter, line breaks and "" for a quote.
// Returns rows of cells with the line each row starts on.
function parseCsvText(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const delim = detectDelimiter(src);
  const rows = [];
  let row = [], cell = '', inQuotes = false, line = 1, rowLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push({ line: rowLine, cells: row });
      row = []; cell = ''; line++; rowLine = line;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push({ line: rowLine, cells: row }); }
  return rows.filter(r => r.cells.some(c => c.trim() !== ''));
}

// → { columns: [name…], ignored: [header…], rows: [{ line, values }] } or { error }
function parseSongCsv(text) {
  const all = parseCsvText(text);
  if (!all.length) return { error: 'empty_file' };
  const [head, ...body] = all;
  const map = [];   // cell index → column name (or null)
  const columns = [];
  const ignored = [];
  for (const raw of head.cells) {
    const col = BY_HEADER.get(headerKey(raw));
    if (!col) { map.push(null); if (raw.trim()) ignored.push(raw.trim()); continue; }
    if (columns.includes(col.name)) return { error: 'duplicate_column', column: col.name };
    map.push(col.name);
    columns.push(col.name);
  }
  if (!columns.includes('title')) return { error: 'no_title_column' };
  if (!body.length) return { error: 'no_rows' };
  if (body.length > MAX_ROWS) return { error: 'too_many_rows', max: MAX_ROWS };
  const rows = body.map(r => {
    const values = {};
    map.forEach((name, i) => { if (name) values[name] = (r.cells[i] ?? '').replace(/\r\n?/g, '\n'); });
    return { line: r.line, values };
  });
  return { columns, ignored, rows };
}

// ── One cell ──────────────────────────────────────────────────────────────────

// "Bb", "bbm", "F#", "A minor", "a-moll", "D-Dur", "H" → the key list's spelling.
function normKey(s) {
  let v = s.trim()
    .replace(/[-\s]*(minor|moll|min|mineur)$/i, 'm')
    .replace(/[-\s]*(major|dur|maj|majeur)$/i, '')
    .replace(/\s+/g, '');
  const m = /^([a-hA-H])([#♯b♭]?)(m?)$/.exec(v);
  if (!m) return undefined;
  const acc = m[2] === '#' || m[2] === '♯' ? '♯' : m[2] ? '♭' : '';
  // H is the German name of B.
  v = (m[1].toUpperCase() === 'H' && !acc ? 'B' : m[1].toUpperCase()) + acc + m[3];
  return KEYS.includes(v) ? v : undefined;
}

// "3:45", "1:02:30", "3.75", "3,75" (minutes) → minutes as a number.
function normLength(s) {
  const t = s.trim();
  let mins;
  const hms = /^(?:(\d+):)?(\d{1,3}):([0-5]\d)$/.exec(t);
  if (hms) mins = (Number(hms[1] || 0) * 60) + Number(hms[2]) + Number(hms[3]) / 60;
  else if (/^\d+([.,]\d+)?$/.test(t)) mins = Number(t.replace(',', '.'));
  else return undefined;
  if (!(mins > 0 && mins < 600)) return undefined;
  return Math.round(mins * 1000) / 1000;
}

function minsToText(mins) {
  const m = Math.floor(mins);
  const sec = Math.round((mins - m) * 60);
  return sec === 60 ? `${m + 1}:00` : `${m}:${String(sec).padStart(2, '0')}`;
}

// One cell → { value, text } (text: what the preview shows, and what a
// re-check sends back) or { error: code }. Empty cells are { value: null }.
// What a spreadsheet leaves in a cell that no one meant to type: invisible
// characters (zero-width spaces, BOMs, soft hyphens, control codes), odd
// spaces (no-break, thin, ideographic), Windows line ends, runs of spaces,
// and the ' our own CSV export puts before a leading = + - @ so Excel does
// not run it as a formula. Single-line fields become one line; lyrics keep
// their line breaks with trailing spaces and extra blank lines removed.
function cleanCell(raw, multiline) {
  let v = String(raw).normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\t]/g, ' ')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '');
  if (multiline) {
    v = v.split('\n').map(l => l.replace(/ +$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  } else {
    v = v.replace(/\s+/g, ' ').trim();
  }
  return v.replace(/^'(?=[=+\-@])/, '');
}

function checkCell(col, raw, ctx) {
  const s = raw == null ? '' : cleanCell(raw, col.type === 'lyrics');
  const t = s;
  if (!t) return col.required ? { error: 'required' } : { value: null, text: '' };
  switch (col.type) {
    case 'text':
      return t.length > col.max ? { error: 'too_long', max: col.max } : { value: t, text: t };
    case 'bool': {
      const w = t.toLowerCase();
      if (TRUE_WORDS.includes(w)) return { value: true, text: 'yes' };
      if (FALSE_WORDS.includes(w)) return { value: false, text: 'no' };
      return { error: 'bool' };
    }
    case 'key': {
      const k = normKey(t);
      return k ? { value: k, text: k } : { error: 'key' };
    }
    case 'bpm': {
      const n = Number(t.replace(',', '.'));
      return Number.isFinite(n) && n >= 20 && n <= 400 ? { value: n, text: String(n) } : { error: 'bpm' };
    }
    case 'timesig': {
      const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(t);
      return m && +m[1] > 0 && +m[2] > 0 ? { value: `${+m[1]}/${+m[2]}`, text: `${+m[1]}/${+m[2]}` } : { error: 'time_signature' };
    }
    case 'length': {
      const n = normLength(t);
      return n === undefined ? { error: 'length' } : { value: n, text: minsToText(n) };
    }
    case 'language': {
      const u = t.toUpperCase();
      const v = LANGUAGE_WORDS[u] ?? u;
      return /^[A-Z]{2,3}$/.test(v) ? { value: v, text: v } : { error: 'language' };
    }
    case 'tags': {
      const tags = cleanTags(t.split(/[;|,]/), ctx.tags);
      if ('error' in tags) return { error: /too many/.test(tags.error) ? 'too_many_tags' : 'tag_too_long' };
      return { value: tags, text: tags.join('; ') };
    }
    case 'energy': {
      const e = energyToScale(t.replace(',', '.'));
      return e == null ? { error: 'energy' } : { value: e, text: String(e) };
    }
    case 'capo': {
      const n = Number(t);
      return Number.isInteger(n) && n >= 0 && n <= 12 ? { value: n, text: String(n) } : { error: 'capo' };
    }
    case 'url': {
      let v = t;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s/]+\.[^\s]+$/.test(v)) v = 'https://' + v;
      if (v.length > 500) return { error: 'too_long', max: 500 };
      return /^https?:\/\/\S+$/i.test(v) ? { value: v, text: v } : { error: 'url' };
    }
    case 'lyrics':
      return s.length > LYRICS_MAX ? { error: 'too_long', max: LYRICS_MAX } : { value: t, text: t };
    default:
      return { error: 'unknown' };
  }
}

// ── Rows ──────────────────────────────────────────────────────────────────────

// ctx: { titles: Set of titleKey of the band's live songs, genres: [], tags: [] }
// rows: [{ line, values: { column name: text }, skip?, force? }]
//
// Returns, per row, the values as they will be saved (`values`, as text),
// `errors` { column: { code, max? } }, `duplicate` (null, { of: 'song' } or
// { of: 'line', line }) and `record`, the song to insert — only for rows that
// are neither skipped nor blocked. A duplicate blocks unless `force` is set
// ("import anyway"); a skipped row neither blocks nor makes a later row a
// duplicate.
function checkRows(rows, ctx) {
  const seen = new Map(); // titleKey → first line
  return rows.map(input => {
    const line = Number(input?.line) || 0;
    const src = input && typeof input.values === 'object' && input.values ? input.values : {};
    const skip = input?.skip === true;
    const force = input?.force === true;
    const values = {};
    const errors = {};
    const record = { extra: {} };
    for (const [name, raw] of Object.entries(src)) {
      const col = BY_NAME.get(name);
      if (!col) continue;
      const r = checkCell(col, raw, ctx);
      if (r.error) {
        errors[name] = r.max ? { code: r.error, max: r.max } : { code: r.error };
        values[name] = raw == null ? '' : String(raw);
        continue;
      }
      values[name] = r.text;
      if (col.field.startsWith('extra.')) { if (r.value !== null) record.extra[col.field.slice(6)] = r.value; }
      else record[col.field] = r.value;
    }
    if (!('title' in src)) errors.title = { code: 'required' };

    let duplicate = null;
    const key = titleKey(record.title);
    if (record.title && !skip) {
      if (ctx.titles.has(key)) duplicate = { of: 'song' };
      else if (seen.has(key)) duplicate = { of: 'line', line: seen.get(key) };
      else seen.set(key, line);
    }
    const errorCount = Object.keys(errors).length;
    const blocked = !skip && (errorCount > 0 || (duplicate && !force));
    const out = { line, values, errors, duplicate, skip, force };
    if (!skip && !blocked) {
      record.genre = matchGenre(record.genre ?? null, ctx.genres) ?? null;
      out.record = record;
    }
    out.status = skip ? 'skipped' : errorCount ? 'error' : duplicate && !force ? 'duplicate' : 'ready';
    return out;
  });
}

function summarize(checked) {
  const s = { total: checked.length, ready: 0, error: 0, duplicate: 0, skipped: 0 };
  for (const r of checked) s[r.status]++;
  return s;
}

// The band's live titles, genres, tags and song count, in one statement.
async function importContext(sql, artistId) {
  const [row] = await sql`
    SELECT
      COALESCE((SELECT jsonb_agg(title) FROM songs WHERE artist_id = ${artistId} AND NOT deleted), '[]'::jsonb) AS titles,
      COALESCE((SELECT jsonb_agg(DISTINCT genre) FROM songs
                WHERE artist_id = ${artistId} AND NOT deleted AND genre IS NOT NULL AND genre <> ''), '[]'::jsonb) AS genres,
      COALESCE((SELECT jsonb_agg(DISTINCT t) FROM songs, unnest(tags) AS t
                WHERE artist_id = ${artistId} AND NOT deleted), '[]'::jsonb) AS tags,
      (SELECT count(*)::int FROM songs WHERE artist_id = ${artistId} AND NOT deleted) AS count`;
  return {
    titles: new Set((row?.titles ?? []).map(titleKey)),
    genres: row?.genres ?? [],
    tags: row?.tags ?? [],
    count: row?.count ?? 0,
  };
}

// Songs, lyrics and one audit entry each, in one statement. Ids are drawn up
// front so the lyrics rows can refer to their song.
async function insertSongs(sql, artistId, records) {
  const rows = records.map(r => ({
    title: r.title,
    active: r.active ?? true,
    heart: r.heart ?? false,
    key: r.key ?? null,
    genre: r.genre ?? null,
    energy: r.energy ?? null,
    time_signature: r.time_signature ?? null,
    bpm: r.bpm ?? null,
    length_min: r.length_min ?? null,
    interpret: r.interpret ?? null,
    reference_interpret: r.reference_interpret ?? null,
    comment: r.comment ?? null,
    language: r.language ?? null,
    extra: r.extra ?? {},
    tags: r.tags ?? [],
    lyrics: r.lyrics || null,
  }));
  const [res] = await sql`
    WITH v AS (
      SELECT nextval(pg_get_serial_sequence('songs', 'id')) AS id, r.*
      FROM jsonb_to_recordset(${sql.json(rows)}) AS r(
        title text, active boolean, heart boolean, key text, genre text, energy numeric,
        time_signature text, bpm numeric, length_min numeric, interpret text,
        reference_interpret text, comment text, language text, extra jsonb, tags text[],
        lyrics text)
    ), s AS (
      INSERT INTO songs (id, artist_id, title, active, heart, key, genre, energy, time_signature,
                         bpm, length_min, interpret, reference_interpret, comment, language, extra, tags)
      SELECT id, ${artistId}, title, active, heart, key, genre, energy, time_signature,
             bpm, length_min, interpret, reference_interpret, comment, language,
             COALESCE(extra, '{}'::jsonb), COALESCE(tags, '{}')
      FROM v
      RETURNING *
    ), saved_lyrics AS (
      INSERT INTO song_lyrics (song_id, artist_id, lyrics)
      SELECT s.id, s.artist_id, v.lyrics FROM s JOIN v ON v.id = s.id WHERE v.lyrics IS NOT NULL
    ), logged AS (
      INSERT INTO song_logs (artist_id, song_id, action, song_data)
      SELECT artist_id, id, 'create', to_jsonb(s) FROM s
    )
    SELECT count(*)::int AS count FROM s`;
  return res?.count ?? 0;
}

// The whole request body: { csv } (a new file) or
// { rows, commit } (a re-check after edits, or the import itself).
// maxSongs: the plan's song limit, or null. → { status, body }
async function songImport(sql, artistId, input, { maxSongs = null } = {}) {
  const inp = input && typeof input === 'object' ? input : {};
  let parsed = null;
  let rows;
  if (typeof inp.csv === 'string') {
    if (inp.csv.length > MAX_CSV) return { status: 413, body: { error: 'file_too_large' } };
    parsed = parseSongCsv(inp.csv);
    if (parsed.error) return { status: 400, body: parsed };
    rows = parsed.rows;
  } else if (Array.isArray(inp.rows)) {
    if (!inp.rows.length) return { status: 400, body: { error: 'no_rows' } };
    if (inp.rows.length > MAX_ROWS) return { status: 400, body: { error: 'too_many_rows', max: MAX_ROWS } };
    rows = inp.rows;
  } else {
    return { status: 400, body: { error: 'csv or rows required' } };
  }

  const ctx = await importContext(sql, artistId);
  const checked = checkRows(rows, ctx);
  const summary = summarize(checked);
  const room = maxSongs == null ? null : Math.max(0, maxSongs - ctx.count);
  const view = checked.map(({ record: _, ...r }) => r);

  if (!inp.commit || parsed) {
    return { status: 200, body: {
      ...(parsed ? { columns: parsed.columns, ignored: parsed.ignored } : {}),
      rows: view, summary, limit: maxSongs == null ? null : { max: maxSongs, room },
    } };
  }
  if (summary.error || summary.duplicate)
    return { status: 422, body: { error: 'rows_need_attention', rows: view, summary } };
  const records = checked.filter(r => r.record).map(r => r.record);
  if (!records.length) return { status: 400, body: { error: 'no_rows' } };
  if (room != null && records.length > room)
    return { status: 402, body: { error: 'song_limit', limit: maxSongs, room } };
  const imported = await insertSongs(sql, artistId, records);
  return { status: 201, body: { ok: true, imported } };
}

module.exports = {
  COLUMNS, cleanCell, MAX_ROWS, parseCsvText, parseSongCsv, checkCell, checkRows, titleKey,
  normKey, normLength, songImport,
};
