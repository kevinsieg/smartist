#!/usr/bin/env node
/**
 * Smartist — energy and genre audit (read-only)
 *
 * Usage:
 *   node scripts/song_values.js [--artist <slug>] [--write-map]
 *
 * Lists every distinct energy value with the 0–10 value it will migrate to, and
 * genre spellings grouped by genreKey() with a proposed canonical spelling.
 * --write-map writes the proposal to data/genre_map.<db endpoint>.<slug>.json (git-ignored)
 * for review; only groups with more than one spelling, or a non-Title-Case one,
 * end up in it.
 *
 * Reads DATABASE_URL from .env / .env.local, or the environment:
 *   DATABASE_URL="postgres://…" node scripts/song_values.js
 */

'use strict';

const { neon }   = require('@neondatabase/serverless');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');
const { mapFile } = require('./_genre_map');
const { energyToScale, genreKey, proposeGenreMap } = require('../api/_song_values');

function loadEnv(filePath) {
  try {
    fs.readFileSync(filePath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    });
  } catch {}
}

loadEnv(path.join(__dirname, '..', '.env'));
loadEnv(path.join(__dirname, '..', '.env.local'));

const B = s => `\x1b[1m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

const args      = process.argv.slice(2);
const WRITE_MAP = args.includes('--write-map');
const artistArg = (() => { const i = args.indexOf('--artist'); return i >= 0 ? args[i + 1] : null; })();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('DATABASE_URL is not set.');
  process.exit(1);
}

function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  ${D('database:')} ${B(host)} ${D('(read-only)')}`);
  return new Promise(resolve =>
    rl.question('  Continue? (y/n): ', answer => {
      rl.close();
      if (!/^y/i.test(answer.trim())) { console.log(D('  Aborted.')); process.exit(0); }
      resolve();
    })
  );
}

async function main() {
  await confirmDb(DATABASE_URL);
  const sql = neon(DATABASE_URL);

  const artists = artistArg
    ? await sql`SELECT id, slug FROM artists WHERE slug = ${artistArg}`
    : await sql`SELECT id, slug FROM artists ORDER BY slug`;
  if (!artists.length) { console.log('  No such artist.'); return; }

  for (const a of artists) {
    console.log(B(`\n${a.slug}`));

    const energy = await sql`
      SELECT energy AS value, count(*)::int AS n FROM songs
      WHERE artist_id = ${a.id} AND energy IS NOT NULL AND trim(energy::text) <> ''
      GROUP BY energy ORDER BY n DESC`;
    console.log(D('  energy  value → 0–10  (songs)'));
    if (!energy.length) console.log(D('    none'));
    for (const e of energy) {
      const to = energyToScale(e.value);
      const shown = to === undefined ? Y('NULL (unreadable)') : to;
      console.log(`    ${JSON.stringify(e.value)} → ${shown}  (${e.n})`);
    }

    const genres = await sql`
      SELECT genre AS value, count(*)::int AS n FROM songs
      WHERE artist_id = ${a.id} AND genre IS NOT NULL AND trim(genre) <> ''
      GROUP BY genre ORDER BY n DESC`;
    const map = proposeGenreMap(genres);
    const groups = new Map();
    for (const g of genres) {
      const k = genreKey(g.value);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    }
    console.log(D('  genre   spellings (songs) → proposed'));
    if (!groups.size) console.log(D('    none'));
    for (const spellings of groups.values()) {
      const list = spellings.map(s => `${JSON.stringify(s.value)} (${s.n})`).join(', ');
      const to = spellings.map(s => map[s.value]).find(Boolean);
      console.log(`    ${list}${to ? ` → ${Y(JSON.stringify(to))}` : ''}`);
    }

    if (WRITE_MAP) {
      const file = mapFile(DATABASE_URL, a.slug);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
      console.log(D(`  wrote ${path.relative(process.cwd(), file)} (${Object.keys(map).length} renames)`));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
