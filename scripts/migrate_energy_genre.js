#!/usr/bin/env node
/**
 * Smartist — migrate songs.energy to a 0–10 SMALLINT and harmonise genre spellings
 *
 * Usage:
 *   node scripts/migrate_energy_genre.js --dry-run     # print every change, write nothing
 *   node scripts/migrate_energy_genre.js               # apply, in one transaction
 *
 * Energy: 0–10 kept, 11–100 → n/10, Low/Slow 2 · Middle/Medium 5 · High/Fast 8,
 * anything else → NULL (listed). Then the column becomes SMALLINT with a 0–10 CHECK.
 *
 * Genre: data/genre_map.<db endpoint>.<slug>.json when it exists (written by
 * scripts/song_values.js --write-map and reviewed), else the same automatic
 * proposal. Safe to run twice: a migrated database has nothing left to change.
 *
 * Reads DATABASE_URL from .env / .env.local, or the environment:
 *   DATABASE_URL="postgres://…" node scripts/migrate_energy_genre.js --dry-run
 */

'use strict';

const postgres = require('postgres');
const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const { mapFile } = require('./_genre_map');
const { energyToScale, proposeGenreMap } = require('../api/_song_values');

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
const G = s => `\x1b[32m${s}\x1b[0m`;

const DRY = process.argv.includes('--dry-run');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.log('DATABASE_URL is not set.'); process.exit(1); }

function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  ${D('database:')} ${B(host)} ${DRY ? D('(dry run — nothing is written)') : Y('(WRITES)')}`);
  return new Promise(resolve =>
    rl.question('  Continue? (y/n): ', answer => {
      rl.close();
      if (!/^y/i.test(answer.trim())) { console.log(D('  Aborted.')); process.exit(0); }
      resolve();
    })
  );
}

function genreMapFor(slug, rows) {
  const file = mapFile(DATABASE_URL, slug);
  if (fs.existsSync(file)) return { map: JSON.parse(fs.readFileSync(file, 'utf8')), source: path.relative(process.cwd(), file) };
  const counts = new Map();
  for (const r of rows) if (r.genre && r.genre.trim()) counts.set(r.genre, (counts.get(r.genre) || 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
  return { map: proposeGenreMap(sorted), source: 'automatic proposal' };
}

async function main() {
  await confirmDb(DATABASE_URL);
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

  const [{ data_type: energyType }] = await sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'songs' AND column_name = 'energy'`;
  const needsAlter = energyType !== 'smallint';

  const artists = await sql`SELECT id, slug FROM artists ORDER BY slug`;
  const plan = [];   // { id, energy?, genre? }
  for (const a of artists) {
    const rows = await sql`SELECT id, title, energy::text AS energy, genre FROM songs WHERE artist_id = ${a.id} ORDER BY title`;
    const { map, source } = genreMapFor(a.slug, rows);
    console.log(B(`\n${a.slug}`) + D(`  (${rows.length} songs, genres from ${source})`));
    let changes = 0;
    for (const r of rows) {
      const change = { id: r.id };
      const raw = r.energy == null ? null : r.energy.trim();
      if (raw !== null) {
        const to = energyToScale(raw);
        const target = to === undefined ? null : to;
        if (String(target) !== raw) {
          change.energy = target;
          const warn = to === undefined ? Y('  unreadable → NULL') : '';
          console.log(`  energy  ${r.title}: ${JSON.stringify(raw)} → ${target}${warn}`);
        }
      }
      if (r.genre && map[r.genre] && map[r.genre] !== r.genre) {
        change.genre = map[r.genre];
        console.log(`  genre   ${r.title}: ${JSON.stringify(r.genre)} → ${JSON.stringify(change.genre)}`);
      }
      if ('energy' in change || 'genre' in change) { plan.push(change); changes++; }
    }
    if (!changes) console.log(D('  nothing to change'));
  }

  console.log(`\n  ${plan.length} songs to change${needsAlter ? ', energy column TEXT → SMALLINT 0–10' : ', energy column already SMALLINT'}`);
  if (DRY) { console.log(D('  Dry run — nothing written.')); await sql.end(); return; }

  await sql.begin(async tx => {
    for (const c of plan) {
      if ('energy' in c) await tx`UPDATE songs SET energy = ${c.energy === null ? null : String(c.energy)} WHERE id = ${c.id}`;
      if ('genre' in c)  await tx`UPDATE songs SET genre = ${c.genre} WHERE id = ${c.id}`;
    }
    if (needsAlter) {
      await tx`ALTER TABLE songs ALTER COLUMN energy TYPE SMALLINT USING NULLIF(trim(energy), '')::smallint`;
      await tx`ALTER TABLE songs ADD CONSTRAINT songs_energy_range CHECK (energy BETWEEN 0 AND 10)`;
    }
  });
  console.log(G('  ✓ done'));
  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
