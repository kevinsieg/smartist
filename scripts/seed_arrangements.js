#!/usr/bin/env node
// Bulk-loads arrangement data from a JS array into song_arrangements.
// Usage: ARTIST_SLUG=salb node scripts/seed_arrangements.js
//
// Before running:
//   1. Fill in the SONGS_DATA array below with your arrangement data
//   2. Set ARTIST_SLUG env var to your artist slug
//   3. Ensure DATABASE_URL is in .env

'use strict';

const path     = require('path');
const readline = require('readline');

function loadEnv() {
  try {
    const fs    = require('fs');
    const lines = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n');
    lines.forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
}
loadEnv();

const { neon } = require('@neondatabase/serverless');

// ── EDIT THIS SECTION ─────────────────────────────────────────────────────────
// Add your song arrangements here.
// Each entry maps a song title to an arrangement version.
//
// Row fields:
//   structure   — section name, e.g. 'INTRO', 'C1', 'R', 'INSTRU', 'BRIDGE'
//   part        — part label, e.g. 'A', 'B'
//   lead        — lead singer or instrument, e.g. 'Ludo' or 'MDO'
//   lead_type   — 'person' | 'instrument'
//   harmony     — array of member names, e.g. ['Kevin', 'Cerise']
//   licks       — instrument key or '', e.g. 'BJO'
//   parts       — object: { BANJO: 'ROLL', MANDO: 'CHOP', GUITAR: 'STRUM', BASS: '1+5' }
//   comment     — free text
//
// Example:
// const SONGS_DATA = [
//   {
//     title:              'Rocky Top',
//     versionName:        'Default',
//     hiddenInstruments:  [],
//     rows: [
//       { structure: 'INTRO',  part: 'A', lead: 'MDO',  lead_type: 'instrument', harmony: [],               licks: '',    parts: { BANJO: 'POMP', MANDO: 'SOLO', GUITAR: 'STRUM', BASS: '1+5' }, comment: '' },
//       { structure: 'C1',     part: 'A', lead: 'Ludo', lead_type: 'person',      harmony: [],               licks: 'BJO', parts: { BANJO: 'ROLL', MANDO: 'CHOP', GUITAR: 'STRUM', BASS: '1+5' }, comment: '' },
//       { structure: 'R',      part: 'B', lead: 'Ludo', lead_type: 'person',      harmony: ['Kevin','Cerise'], licks: 'BJO', parts: { BANJO: 'ROLL', MANDO: 'CHOP', GUITAR: 'STRUM', BASS: '1+5' }, comment: '' },
//     ],
//   },
// ];

const SONGS_DATA = [
  // Paste your songs here
];
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set. Check your .env file.');
    process.exit(1);
  }
  const slug = process.env.ARTIST_SLUG;
  if (!slug) {
    console.error('ERROR: ARTIST_SLUG not set. Usage: ARTIST_SLUG=salb node scripts/seed_arrangements.js');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);

  const [artist] = await sql`SELECT id, name FROM artists WHERE slug = ${slug}`;
  if (!artist) {
    console.error('ERROR: Artist not found for slug:', slug);
    process.exit(1);
  }

  const dbHost = new URL(process.env.DATABASE_URL).hostname;
  console.log('\nDB host:  ', dbHost);
  console.log('Artist:   ', artist.name, '(id=' + artist.id + ')');
  console.log('Songs:    ', SONGS_DATA.length, 'to seed');

  if (!SONGS_DATA.length) {
    console.log('\nNo songs in SONGS_DATA. Edit the file and add your arrangement data.');
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question('\nProceed? (y/N) ', ans => {
      rl.close();
      if (ans.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
      resolve();
    });
  });

  let ok = 0, skipped = 0, errors = 0;

  for (const entry of SONGS_DATA) {
    try {
      // Match song by title (case-insensitive)
      const matched = await sql`
        SELECT id, title FROM songs
        WHERE artist_id = ${artist.id}
          AND LOWER(title) = LOWER(${entry.title})
          AND deleted = false
      `;
      if (!matched.length) {
        console.warn('SKIP (not found):', entry.title);
        skipped++;
        continue;
      }
      const songId      = matched[0].id;
      const versionName = entry.versionName || 'Default';

      // Upsert: update existing version with same name, or insert new one
      const existing = await sql`
        SELECT id FROM song_arrangements
        WHERE song_id = ${songId} AND artist_id = ${artist.id} AND name = ${versionName}
      `;

      if (existing.length) {
        await sql`
          UPDATE song_arrangements
          SET rows               = ${entry.rows || []},
              hidden_instruments = ${entry.hiddenInstruments || []},
              updated_at         = NOW()
          WHERE id = ${existing[0].id}
        `;
        console.log('UPDATED:', entry.title, '→', versionName);
      } else {
        await sql`
          INSERT INTO song_arrangements (song_id, artist_id, name, rows, hidden_instruments, is_active)
          VALUES (${songId}, ${artist.id}, ${versionName}, ${entry.rows || []}, ${entry.hiddenInstruments || []}, true)
        `;
        console.log('INSERTED:', entry.title, '→', versionName);
      }
      ok++;
    } catch (e) {
      console.error('ERROR:', entry.title, '—', e.message);
      errors++;
    }
  }

  console.log('\nDone.  OK:', ok, ' Skipped:', skipped, ' Errors:', errors);
}

main().catch(e => { console.error(e.message); process.exit(1); });
