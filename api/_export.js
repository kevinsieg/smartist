const zlib = require('zlib');

// Bookkeeping columns that mean nothing outside this database. ids stay: they
// are what joins setlist_songs to songs across the files.
const INTERNAL = new Set(['artist_id', 'deleted']);

// A cell starting with one of these is run as a formula by Excel/Sheets.
const FORMULA_START = /^[=+\-@\t\r]/;

function isEmpty(v) {
  return v === null || v === undefined || v === '';
}

function cell(v) {
  if (isEmpty(v)) return '';
  let s;
  if (v instanceof Date)        s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else                            s = String(v);
  if (typeof v === 'string' && FORMULA_START.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// songs.extra is where most per-song data lives, so it gets real columns;
// any other JSON column stays a JSON string in its cell.
function flatten(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (INTERNAL.has(k) || k === 'extra') continue;
    out[k] = v;
  }
  if (row.extra && typeof row.extra === 'object') {
    for (const [k, v] of Object.entries(row.extra)) {
      if (isEmpty(v)) continue;
      out[k in row ? 'extra_' + k : k] = v;
    }
  }
  return out;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const flat = rows.map(flatten);
  const cols = [];
  for (const r of flat) {
    for (const k of Object.keys(r)) {
      if (!cols.includes(k) && flat.some(x => !isEmpty(x[k]))) cols.push(k);
    }
  }
  const lines = [cols.join(','), ...flat.map(r => cols.map(c => cell(r[c])).join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Minimal ZIP writer (deflate, UTF-8 names) — enough for a handful of CSVs
// without pulling in an archive dependency.
function buildZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data    = Buffer.from(content, 'utf8');
    const packed  = zlib.deflateRawSync(data);
    const crc     = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);       // UTF-8 file names
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

module.exports = { toCsv, buildZip };
