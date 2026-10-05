'use strict';

// CSV song import (api/_domain/song_import.js): parsing, per-cell checks,
// duplicates, and that nothing is written while a row still needs attention.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeRunner } = require('./_runner');
const {
  COLUMNS, cleanCell, parseCsvText, parseSongCsv, checkRows, normKey, normLength, songImport,
} = require('../../api/_domain/song_import');

const CTX = () => ({ titles: new Set(['wonderwall']), genres: ['Rock'], tags: ['Liebe'] });

// A fake sql tag: answers the context query with `band`, records the insert.
// band.liveAtInsert: the band's song count the insert sees (a parallel
// import committed in between); the insert then writes nothing over the limit.
const isInsert = c => c.text.startsWith('WITH live AS');
function fakeSql(band = {}) {
  const calls = [];
  let inTx = false;
  const sql = (strings, ...values) => {
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values, inTx });
    if (text.startsWith('WITH live AS')) {
      const rows = values.find(v => v && v.json).json;
      const max = values[values.length - 1];
      const live = band.liveAtInsert ?? band.count ?? 1;
      const fits = max == null || live + rows.length <= max;
      return Promise.resolve([{ count: fits ? rows.length : 0, live }]);
    }
    return Promise.resolve([{
      titles: band.titles ?? ['Wonderwall'], genres: ['Rock'], tags: ['Liebe'], count: band.count ?? 1,
    }]);
  };
  sql.json = v => ({ json: v });
  sql.begin = async fn => { inTx = true; try { return await fn(sql); } finally { inTx = false; } };
  return { sql, calls, inserts: () => calls.filter(isInsert) };
}

async function run(r) {
  const { test, testAsync, assert, assertEq } = r;
  console.log(r.B('\nCSV song import'));

  test('client template columns match the server columns', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../app/js/song-import.js'), 'utf8');
    const m = /var SI_COLUMNS = (\[[\s\S]*?\]);/.exec(src);
    assert(m, 'SI_COLUMNS not found');
    const client = vm.runInNewContext(m[1]);
    assertEq(JSON.stringify(client), JSON.stringify(COLUMNS.map(c => c.name)));
  });

  test('every column has a guide text in en, fr and de', () => {
    for (const l of ['en', 'fr', 'de']) {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, `../../app/i18n/${l}.json`), 'utf8'));
      for (const c of COLUMNS) assert(d['songImport.col.' + c.name], `${l}: songImport.col.${c.name} missing`);
    }
  });

  test('quoted cells keep delimiters, quotes and line breaks', () => {
    const rows = parseCsvText('title,comment\r\n"A, B","say ""hi""\nsecond line"\r\nC,d\r\n');
    assertEq(rows.length, 3);
    assertEq(rows[1].cells[0], 'A, B');
    assertEq(rows[1].cells[1], 'say "hi"\nsecond line');
    assertEq(rows[2].line, 4, 'line numbers count the break inside the quoted cell');
  });

  test('semicolon files (Excel DE/FR) and a BOM are read', () => {
    const p = parseSongCsv('﻿Titel;Tonart;Länge\nSong;Bb;3:30\n');
    assertEq(JSON.stringify(p.columns), '["title","key","length"]');
    assertEq(p.rows[0].values.key, 'Bb');
  });

  test('unknown columns are listed, a missing title column is an error', () => {
    const p = parseSongCsv('title,colour\nA,red\n');
    assertEq(JSON.stringify(p.ignored), '["colour"]');
    assertEq(parseSongCsv('name2,key\nA,C\n').error, 'no_title_column');
    assertEq(parseSongCsv('title,titel\nA,B\n').error, 'duplicate_column');
    assertEq(parseSongCsv('title\n').error, 'no_rows');
    assertEq(parseSongCsv('  \n').error, 'empty_file');
  });

  test('blank rows are dropped', () => {
    assertEq(parseSongCsv('title,key\nA,C\n,\n\nB,D\n').rows.length, 2);
  });

  test('keys are normalised to the key list', () => {
    assertEq(normKey('Bb'), 'B♭');
    assertEq(normKey('f#m'), 'F♯m');
    assertEq(normKey('A minor'), 'Am');
    assertEq(normKey('D-Dur'), 'D');
    assertEq(normKey('H'), 'B');
    assertEq(normKey('X'), undefined);
    assertEq(normKey('G#'), undefined, 'not in the list (A♭)');
  });

  test('lengths read as mm:ss, h:mm:ss or decimal minutes', () => {
    assertEq(normLength('3:45'), 3.75);
    assertEq(normLength('3,5'), 3.5);
    assertEq(normLength('1:02:30'), 62.5);
    assertEq(normLength('3:75'), undefined);
    assertEq(normLength('abc'), undefined);
  });

  test('each bad cell gets its own error code', () => {
    const [row] = checkRows([{ line: 2, values: {
      title: 'New', key: 'Q', bpm: 'fast', length: 'long', active: 'maybe', energy: 'very',
      reference_url: 'not a link', guitar_capo: '15', time_signature: 'four',
    } }], CTX());
    assertEq(row.status, 'error');
    const codes = Object.fromEntries(Object.entries(row.errors).map(([k, v]) => [k, v.code]));
    assertEq(JSON.stringify(codes), JSON.stringify({
      key: 'key', bpm: 'bpm', length: 'length', active: 'bool', energy: 'energy',
      reference_url: 'url', guitar_capo: 'capo', time_signature: 'time_signature',
    }));
    assertEq(row.values.key, 'Q', 'a bad value comes back as typed');
    assert(!row.record, 'a blocked row has no record');
  });

  test('good cells are normalised and mapped to columns and extra', () => {
    const [row] = checkRows([{ line: 2, values: {
      title: ' New  Song ', key: 'bb', active: 'nein', favourite: 'x', length: '3:30', tags: 'liebe; Sommer',
      genre: 'rock', guitar_capo: '2', author: 'A. Writer', reference_url: 'www.example.com', language: 'Deutsch',
      lyrics: 'one\ntwo',
    } }], CTX());
    assertEq(row.status, 'ready');
    const rec = row.record;
    assertEq(rec.title, 'New Song', 'spaces collapsed');
    assertEq(rec.key, 'B♭');
    assertEq(rec.active, false);
    assertEq(rec.heart, true);
    assertEq(rec.length_min, 3.5);
    assertEq(JSON.stringify(rec.tags), '["Liebe","Sommer"]', 'tag takes the band spelling');
    assertEq(rec.genre, 'Rock', 'genre takes the band spelling');
    assertEq(rec.language, 'DE');
    assertEq(rec.lyrics, 'one\ntwo');
    assertEq(JSON.stringify(rec.extra), JSON.stringify({ gitCapo: 2, author: 'A. Writer', referenceUrl: 'https://www.example.com' }));
    assertEq(row.values.length, '3:30');
    assertEq(row.values.active, 'no');
  });

  test('cells are cleaned of invisible characters, odd spaces and export quotes', () => {
    assertEq(cleanCell('\u200BHey\u00A0\u00A0Jude\u00AD\t ', false), 'Hey Jude');
    assertEq(cleanCell('two\r\nlines', false), 'two lines', 'single-line fields lose line breaks');
    assertEq(cleanCell("'=Intro", false), '=Intro', 'the export formula guard is removed');
    assertEq(cleanCell("Don't", false), "Don't");
    assertEq(cleanCell('bell\u0007', false), 'bell');
    assertEq(cleanCell('Cafe\u0301', false), 'Caf\u00e9', 'NFC');
    assertEq(cleanCell('  a  \r\n\r\n\r\n\r\nb \n', true), 'a\n\nb', 'lyrics keep breaks, lose trailing spaces and extra blank lines');
  });

  test('a title differing only in invisible characters is a duplicate', () => {
    const [row] = checkRows([{ line: 2, values: { title: 'Wonder\u200Bwall\u00A0' } }], CTX());
    assertEq(row.values.title, 'Wonderwall');
    assertEq(row.status, 'duplicate');
  });

  test('duplicates: a title the band has, or an earlier row, ignoring case and spaces', () => {
    const rows = checkRows([
      { line: 2, values: { title: 'WONDERWALL ' } },
      { line: 3, values: { title: 'Hey  Jude' } },
      { line: 4, values: { title: 'hey jude' } },
    ], CTX());
    assertEq(JSON.stringify(rows.map(x => x.status)), '["duplicate","ready","duplicate"]');
    assertEq(rows[0].duplicate.of, 'song');
    assertEq(JSON.stringify(rows[2].duplicate), '{"of":"line","line":3}');
  });

  test('a skipped row blocks nothing and makes no later row a duplicate', () => {
    const rows = checkRows([
      { line: 2, values: { title: 'Hey Jude', key: 'Q' }, skip: true },
      { line: 3, values: { title: 'hey jude' } },
    ], CTX());
    assertEq(rows[0].status, 'skipped');
    assertEq(rows[1].status, 'ready');
  });

  test('"import anyway" lets a duplicate through', () => {
    const [row] = checkRows([{ line: 2, values: { title: 'Wonderwall' }, force: true }], CTX());
    assertEq(row.status, 'ready');
    assert(row.duplicate, 'still marked as a duplicate');
    assert(row.record, 'has a record');
  });

  await testAsync('a file is checked, never written', async () => {
    const { sql, inserts } = fakeSql();
    const res = await songImport(sql, 1, { csv: 'title,key\nNew,C\nWonderwall,G\n', commit: true });
    assertEq(res.status, 200);
    assertEq(inserts().length, 0);
    assertEq(JSON.stringify(res.body.summary), '{"total":2,"ready":1,"error":0,"duplicate":1,"skipped":0}');
    assertEq(JSON.stringify(res.body.columns), '["title","key"]');
  });

  await testAsync('commit with an unresolved row → 422 and nothing written', async () => {
    const { sql, inserts } = fakeSql();
    const res = await songImport(sql, 1, { commit: true, rows: [
      { line: 2, values: { title: 'New' } },
      { line: 3, values: { title: 'Wonderwall' } },
    ] });
    assertEq(res.status, 422);
    assertEq(res.body.error, 'rows_need_attention');
    assertEq(inserts().length, 0);
  });

  await testAsync('commit writes the rows that are not skipped, in one statement', async () => {
    const { sql, inserts } = fakeSql();
    const res = await songImport(sql, 1, { commit: true, rows: [
      { line: 2, values: { title: 'New', lyrics: 'la la' } },
      { line: 3, values: { title: 'Wonderwall' }, skip: true },
      { line: 4, values: { title: 'Other', key: 'Q' }, skip: true },
    ] });
    assertEq(res.status, 201);
    assertEq(res.body.imported, 1);
    assertEq(inserts().length, 1);
    const rows = inserts()[0].values.find(v => v && v.json).json;
    assertEq(rows.length, 1);
    assertEq(rows[0].title, 'New');
    assertEq(rows[0].lyrics, 'la la');
    assertEq(rows[0].active, true, 'active defaults to on');
    assert(inserts()[0].values.includes(1), 'scoped to the band');
  });

  await testAsync('the plan song limit counts the rows to import', async () => {
    const { sql, inserts } = fakeSql({ count: 99 });
    const rows = [{ line: 2, values: { title: 'A' } }, { line: 3, values: { title: 'B' } }];
    const res = await songImport(sql, 1, { commit: true, rows }, { maxSongs: 100 });
    assertEq(res.status, 402);
    assertEq(res.body.room, 1);
    assertEq(inserts().length, 0);
    const check = await songImport(sql, 1, { rows }, { maxSongs: 100 });
    assertEq(JSON.stringify(check.body.limit), '{"max":100,"room":1}');
  });

  // Parallel imports each read the same count before inserting: five of 100
  // rows put 500 songs into a band limited to 100.
  await testAsync('under a song limit the insert re-counts under the band\'s lock', async () => {
    const { sql, calls, inserts } = fakeSql({ count: 50 });
    const rows = [{ line: 2, values: { title: 'A' } }, { line: 3, values: { title: 'B' } }];
    const res = await songImport(sql, 7, { commit: true, rows }, { maxSongs: 100 });
    assertEq(res.status, 201);
    const lock = calls.findIndex(c => /pg_advisory_xact_lock/.test(c.text));
    assert(lock >= 0 && calls[lock].inTx, 'the lock is taken in the transaction');
    assert(calls[lock].values.includes(7), 'the band\'s lock');
    const insert = calls.findIndex(isInsert);
    assert(insert > lock && calls[insert].inTx, 'the insert runs after the lock, in the same transaction');
    assert(/count\(\*\) FROM live\) \+/.test(inserts()[0].text), 'the insert counts again');
  });

  await testAsync('an import that no longer fits once the lock is held → 402, nothing written', async () => {
    const { sql } = fakeSql({ count: 50, liveAtInsert: 99 });
    const rows = [{ line: 2, values: { title: 'A' } }, { line: 3, values: { title: 'B' } }];
    const res = await songImport(sql, 1, { commit: true, rows }, { maxSongs: 100 });
    assertEq(res.status, 402);
    assertEq(res.body.error, 'song_limit');
    assertEq(res.body.room, 1);
  });

  await testAsync('bad input is refused before the database', async () => {
    const { sql, calls } = fakeSql();
    assertEq((await songImport(sql, 1, {})).status, 400);
    assertEq((await songImport(sql, 1, { rows: [] })).status, 400);
    assertEq((await songImport(sql, 1, { rows: new Array(1001).fill({}) })).status, 400);
    assertEq((await songImport(sql, 1, { csv: 'x'.repeat(4_000_001) })).status, 413);
    assertEq(calls.length, 0);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
