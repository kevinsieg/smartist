const path = require('path');
const zlib = require('zlib');
const { toCsv, buildZip } = require(path.join(__dirname, '../../api/_export'));

// Reads every entry of a zip buffer via its central directory.
function unzip(buf) {
  const out = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc    = buf.readUInt32LE(p + 16);
    const csize  = buf.readUInt32LE(p + 20);
    const nlen   = buf.readUInt16LE(p + 28);
    const elen   = buf.readUInt16LE(p + 30);
    const clen   = buf.readUInt16LE(p + 32);
    const local  = buf.readUInt32LE(p + 42);
    const name   = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start  = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw    = buf.subarray(start, start + csize);
    const data   = method === 8 ? zlib.inflateRawSync(raw) : raw;
    out[name] = { text: data.toString('utf8'), crcOk: zlib.crc32(data) === crc };
    p += 46 + nlen + elen + clen;
  }
  return out;
}

const BOM = '﻿';
const lines = csv => csv.replace(BOM, '').trimEnd().split('\r\n');

function run(r) {
  const { test, assert, assertEq, B } = r;

  console.log(B('\ntoCsv'));

  test('drops columns that are empty in every row', () => {
    const csv = toCsv([{ id: 1, title: 'A', bpm: null }, { id: 2, title: 'B', bpm: '' }]);
    assertEq(lines(csv)[0], 'id,title');
  });

  test('keeps a column that has a value in any row', () => {
    const csv = toCsv([{ id: 1, bpm: null }, { id: 2, bpm: 120 }]);
    assertEq(lines(csv), ['id,bpm', '1,', '2,120']);
  });

  test('drops internal columns', () => {
    const csv = toCsv([{ id: 1, artist_id: 8, deleted: false, title: 'A' }]);
    assertEq(lines(csv)[0], 'id,title');
  });

  test('flattens extra into its own columns, skipping empty keys', () => {
    const csv = toCsv([
      { id: 1, extra: { isrc: 'X1', capo: null } },
      { id: 2, extra: { lead: 'Kev' } },
    ]);
    assertEq(lines(csv), ['id,isrc,lead', '1,X1,', '2,,Kev']);
  });

  test('an extra key that clashes with a column is prefixed', () => {
    const csv = toCsv([{ id: 1, key: 'Am', extra: { key: 'C' } }]);
    assertEq(lines(csv), ['id,key,extra_key', '1,Am,C']);
  });

  test('other objects become JSON in the cell', () => {
    const csv = toCsv([{ id: 1, social_links: { ig: 'x' } }]);
    assertEq(lines(csv)[1], '1,"{""ig"":""x""}"');
  });

  test('quotes commas, quotes and newlines', () => {
    const csv = toCsv([{ t: 'a,b' }, { t: 'say "hi"' }, { t: 'l1\nl2' }]);
    assertEq(csv.replace(BOM, ''), 't\r\n"a,b"\r\n"say ""hi"""\r\n"l1\nl2"\r\n');
  });

  test('neutralises spreadsheet formulas', () => {
    const csv = toCsv([{ t: '=HYPERLINK("x")' }, { t: '+1' }, { t: '@a' }]);
    assertEq(lines(csv).slice(1), ['"\'=HYPERLINK(""x"")"', "'+1", "'@a"]);
  });

  test('dates as ISO, booleans as true/false, numbers untouched', () => {
    const csv = toCsv([{ d: new Date('2026-01-22T00:00:00Z'), b: true, n: -5 }]);
    assertEq(lines(csv)[1], '2026-01-22T00:00:00.000Z,true,-5');
  });

  test('starts with a BOM so Excel reads umlauts', () => {
    assert(toCsv([{ t: 'ä' }]).startsWith(BOM), 'expected BOM');
  });

  test('no rows → empty string', () => {
    assertEq(toCsv([]), '');
  });

  console.log(B('\nbuildZip'));

  test('round-trips several files with valid CRCs', () => {
    const files = { 'songs.csv': 'id,title\r\n1,Ä\r\n', 'gigs.csv': 'x'.repeat(5000) };
    const got = unzip(buildZip(files));
    assertEq(Object.keys(got).sort(), ['gigs.csv', 'songs.csv']);
    assertEq(got['songs.csv'].text, files['songs.csv']);
    assertEq(got['gigs.csv'].text, files['gigs.csv']);
    assert(got['songs.csv'].crcOk && got['gigs.csv'].crcOk, 'crc mismatch');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
