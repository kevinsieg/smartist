#!/usr/bin/env node
/**
 * Band Tools — Song importer
 *
 * Imports songs from a JSON file into the database for a given artist.
 * Run setup.js first to create the artist if it does not exist yet.
 *
 * Usage:
 *   node scripts/import_songs.js --artist <slug> <file.json>
 *
 * JSON format — array of song objects:
 *   [
 *     {
 *       "title": "Song Title",          // required
 *       "active": true,                 // optional, default true
 *       "key": "G",                     // optional
 *       "genre": "Blues",            // optional
 *       "tempo": "Medium",              // optional
 *       "length_min": 3.5,              // optional, decimal minutes
 *       "interpret": "Artist",          // optional
 *       "reference_interpret": "Ref",   // optional
 *       "comment": "Notes",             // optional
 *       "extra": { "capo": 2 }          // optional, band-specific fields
 *     }
 *   ]
 *
 * Reads DATABASE_URL from .env.local in the project root if not set in env.
 */

'use strict';

const { neon }   = require('@neondatabase/serverless');
const readline   = require('readline');
const fs         = require('fs');
const path       = require('path');

// Load .env.local
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
loadEnv(path.join(__dirname, '..', '.env.local'));

// ── Args ───────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const artistIdx = args.indexOf('--artist');

if (artistIdx === -1 || !args[artistIdx + 1]) {
  console.error('Usage: node scripts/import_songs.js --artist <slug> <file.json>');
  process.exit(1);
}

const slug = args[artistIdx + 1];
const file = args.find((a, i) => i !== artistIdx && i !== artistIdx + 1);

if (!file) {
  console.error('No JSON file specified.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env.local or export it.');
  process.exit(1);
}

// ── Import ─────────────────────────────────────────────────────────────────

function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  database: ${host}`);
  return new Promise(resolve =>
    rl.question('  Continue? (y/n): ', answer => {
      rl.close();
      if (!/^y/i.test(answer.trim())) { console.log('  Aborted.'); process.exit(0); }
      resolve();
    })
  );
}

(async () => {
  await confirmDb(process.env.DATABASE_URL);
  const sql   = neon(process.env.DATABASE_URL);
  const songs = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

  if (!Array.isArray(songs) || songs.length === 0) {
    console.error('JSON file must contain a non-empty array of songs.');
    process.exit(1);
  }

  const [artist] = await sql`SELECT id FROM artists WHERE slug = ${slug} LIMIT 1`;
  if (!artist) {
    console.error(`Artist "${slug}" not found. Run setup.js first.`);
    process.exit(1);
  }

  let imported = 0;
  let skipped  = 0;

  for (const s of songs) {
    if (!s.title || !String(s.title).trim()) {
      skipped++;
      continue;
    }

    await sql`
      INSERT INTO songs
        (artist_id, title, active, key, genre, tempo, length_min,
         interpret, reference_interpret, comment, extra)
      VALUES (
        ${artist.id},
        ${String(s.title).trim()},
        ${s.active ?? true},
        ${s.key        ?? null},
        ${s.genre   ?? null},
        ${s.tempo      ?? null},
        ${s.length_min ?? null},
        ${s.interpret           ?? null},
        ${s.reference_interpret ?? null},
        ${s.comment    ?? null},
        ${s.extra      ?? {}}
      )
    `;

    imported++;
    if (imported % 20 === 0) process.stdout.write(`  ${imported} imported...\r`);
  }

  console.log(`\nDone — ${imported} songs imported, ${skipped} skipped (missing title).`);
})().catch(e => { console.error(e.message); process.exit(1); });
