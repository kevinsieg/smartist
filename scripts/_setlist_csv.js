'use strict';

// The logic of scripts/import_setlist_csv.js, free of any database: reading the
// CSV, deciding which row is which existing song, and what a matched song may
// be completed with. Tested in tests/unit/setlist_csv.js.

const { parseCsvText, normLength } = require('../api/_domain/song_import');
const { normTitle, similar } = require('../api/_domain/title_match');

// CSV header (case, accents and punctuation ignored) → field.
const HEADERS = {
  title:       ['title', 'titre', 'titel'],
  length:      ['length', 'duration', 'duree', 'dauer', 'lange'],
  author:      ['author', 'auteur', 'autor'],
  composer:    ['composer', 'compositeur', 'komponist'],
  arranger:    ['arranger', 'harmonisation', 'arrangement', 'arrangeur'],
  traditional: ['traditional', 'traditionnel', 'traditionell', 'trad'],
};
const EXTRA_KEYS = ['author', 'composer', 'arranger'];

function foldHeader(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// → { rows: [{ line, title, length_min, author, composer, arranger, traditional }], errors: [text] }
function parseRows(text) {
  const all = parseCsvText(text);
  const errors = [];
  if (!all.length) return { rows: [], errors: ['the file is empty'] };
  const index = {};
  all[0].cells.forEach((cell, i) => {
    const key = Object.keys(HEADERS).find(k => HEADERS[k].includes(foldHeader(cell)));
    if (key && index[key] === undefined) index[key] = i;
  });
  if (index.title === undefined) return { rows: [], errors: ['no title column (title, titre or titel)'] };

  const rows = [];
  const seen = new Map();
  for (const { line, cells } of all.slice(1)) {
    const get = k => {
      const v = index[k] === undefined ? '' : String(cells[index[k]] ?? '').trim();
      return v === '' ? null : v;
    };
    const title = get('title');
    if (!title) { errors.push(`line ${line}: no title`); continue; }
    let length_min = null;
    if (get('length') !== null) {
      length_min = normLength(get('length'));
      if (length_min === undefined) { errors.push(`line ${line}: bad length "${get('length')}"`); continue; }
    }
    const key = normTitle(title);
    if (seen.has(key)) { errors.push(`line ${line}: "${title}" repeats line ${seen.get(key)}`); continue; }
    seen.set(key, line);
    rows.push({
      line, title, length_min,
      author: get('author'), composer: get('composer'), arranger: get('arranger'),
      traditional: /^(yes|y|true|1|oui|ja|x)$/i.test(get('traditional') || ''),
    });
  }
  return { rows, errors };
}

// ["csv title=db title", …] → { normalized csv title: normalized db title }
function parseSame(pairs) {
  const out = {};
  for (const p of pairs || []) {
    const i = p.indexOf('=');
    if (i > 0) out[normTitle(p.slice(0, i))] = normTitle(p.slice(i + 1));
  }
  return out;
}

// → { kind: 'match', song } | { kind: 'maybe', candidates } | { kind: 'new' } | { kind: 'skip' }
// Only a live song with the same normalized title matches by itself. `same`
// (from parseSame) settles a "maybe" as a match, `forceNew` (a Set of
// normalized titles) as a new song; `skip` (a Set) leaves a title out.
function classify(row, songs, same, forceNew, skip) {
  const key = normTitle(row.title);
  if (skip && skip.has(key)) return { kind: 'skip' };
  const live = songs.filter(s => !s.deleted);
  const settled = same && same[key];
  if (settled) {
    const hit = live.filter(s => normTitle(s.title) === settled);
    if (hit.length === 1) return { kind: 'match', song: hit[0] };
  }
  const exact = live.filter(s => normTitle(s.title) === key);
  if (exact.length === 1) return { kind: 'match', song: exact[0] };
  const near = exact.length > 1 ? exact : songs.filter(s => similar(key, normTitle(s.title)));
  if (!near.length) return { kind: 'new' };
  if (forceNew && forceNew.has(key)) return { kind: 'new' };
  return { kind: 'maybe', candidates: near };
}

const blank = v => v == null || String(v).trim() === '';

// What a matched song may be completed with: only what it has not got yet.
// → { length_min?, interpret?, extra? } or null when there is nothing to add.
function completion(song, row, traditionalLabel) {
  const patch = {};
  if (row.length_min != null && !song.length_min) patch.length_min = row.length_min;
  if (row.traditional && blank(song.interpret)) patch.interpret = traditionalLabel;
  const extra = {};
  for (const k of EXTRA_KEYS) if (row[k] != null && blank((song.extra || {})[k])) extra[k] = row[k];
  if (Object.keys(extra).length) patch.extra = extra;
  return Object.keys(patch).length ? patch : null;
}

function newSong(row, traditionalLabel) {
  const extra = {};
  for (const k of EXTRA_KEYS) if (row[k] != null) extra[k] = row[k];
  return { title: row.title, length_min: row.length_min, interpret: row.traditional ? traditionalLabel : null, extra };
}

// What the user typed for a "maybe": the number of a live candidate (the same
// song), n (a new song), s (leave it out), q (stop). null: ask again.
function parseChoice(input, candidates) {
  const t = String(input).trim().toLowerCase();
  if (t === 'n') return { kind: 'new' };
  if (t === 's') return { kind: 'skip' };
  if (t === 'q') return { kind: 'abort' };
  if (/^\d+$/.test(t)) {
    const song = candidates[Number(t) - 1];
    if (song && !song.deleted) return { kind: 'same', song };
  }
  return null;
}

// The choices made at the prompt as the flags that repeat them without one
// (for the run on the real database).
function decisionFlags(decisions) {
  const q = s => '"' + String(s).replace(/[\\"$`]/g, '\\$&') + '"';
  return decisions.map(d =>
    d.kind === 'same' ? `--same ${q(`${d.row.title}=${d.song.title}`)}`
      : d.kind === 'new' ? `--new ${q(d.row.title)}`
      : `--skip ${q(d.row.title)}`);
}

module.exports = { normTitle, parseRows, parseSame, classify, completion, newSong, similar, parseChoice, decisionFlags };
