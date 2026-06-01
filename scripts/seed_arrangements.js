#!/usr/bin/env node
// Bulk-loads arrangement data from a JS array into song_arrangements.
// Usage: node scripts/seed_arrangements.js <slug> [database_url]
//
//   slug         — artist slug (required)
//   database_url — Neon connection string (optional; falls back to DATABASE_URL in .env)
//
// Examples:
//   node scripts/seed_arrangements.js salb
//   node scripts/seed_arrangements.js salb postgresql://user:pass@host/db

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

// Instrument keys used across all songs:
//   GTR     = Guitar (single guitar songs)
//   GTR_L   = Guitar Ludo
//   GTR_K   = Guitar Kevin
//   BJO     = Banjo        techniques: ROLL, POMP, CHOP, SOLO, INSTRU
//   MDO     = Mando        techniques: CHOP, SOLO, INSTRU, OPEN
//   VLN     = Violon       techniques: LNG BOW, INSTRU
//   FDL     = Fiddle       techniques: LONG BOW, NAPE, INSTRU
//   BASS    = Bass         techniques: ALT, BOW, SOLO
//   HARMO   = Harp/Harmonica  techniques: NAPE, INSTRU
//
// Configure these exact keys in Hub → Arrangement → Instruments before running.

const SONGS_DATA = [
  // ── What Is A Home Without Love ──────────────────────────────────────────
  {
    title:             'What Is A Home Without Love',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'FDL', 'BASS'],
    rows: [
      { structure: 'INTRO',  part: '',  lead: '',        lead_type: '',           harmony: [],               licks: '',    parts: { GTR: '',      BJO: '',      MDO: 'CHOP',   VLN: ''        }, comment: 'E' },
      { structure: 'C1',     part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: [],               licks: 'VLN', parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'CHOP',   VLN: 'LNG BOW' }, comment: '' },
      { structure: 'R1',     part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: ['Kevin'],        licks: 'VLN', parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'CHOP',   VLN: 'LNG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'VLN',     lead_type: 'instrument', harmony: [],               licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'CHOP',   VLN: 'INSTRU'  }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: [],               licks: 'VLN', parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'CHOP',   VLN: 'LNG BOW' }, comment: '' },
      { structure: 'R2',     part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: ['Kevin'],        licks: 'VLN', parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'CHOP',   VLN: 'LNG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'VLN+MDO', lead_type: 'instrument', harmony: [],               licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', VLN: 'INSTRU'  }, comment: 'Turnaround' },
    ],
  },

  // ── Big Spike Hammer ─────────────────────────────────────────────────────
  // NOTE: C3 and final R rows inherit GUITAR=SOLO by ditto from the 2nd INSTRU.
  // Verify this is intentional — change to 'STRUM' if not.
  {
    title:             'Big Spike Hammer',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'VLN', 'FDL'],
    rows: [
      { structure: 'INTRO',  part: 'A', lead: 'MDO',  lead_type: 'instrument', harmony: [],                  licks: '',    parts: { BJO: 'POMP', MDO: 'SOLO', GTR: 'STRUM', BASS: 'ALT' }, comment: '' },
      { structure: 'C1',     part: 'A', lead: 'Ludo', lead_type: 'person',     harmony: [],                  licks: 'BJO', parts: { BJO: 'ROLL', MDO: 'CHOP', GTR: 'STRUM', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Ludo', lead_type: 'person',     harmony: ['Kevin', 'Cerise'], licks: 'BJO', parts: { BJO: 'ROLL', MDO: 'CHOP', GTR: 'STRUM', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'BJO',  lead_type: 'instrument', harmony: [],                  licks: '',    parts: { BJO: 'SOLO', MDO: 'CHOP', GTR: 'STRUM', BASS: 'ALT' }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Ludo', lead_type: 'person',     harmony: [],                  licks: 'GTR', parts: { BJO: 'ROLL', MDO: 'CHOP', GTR: 'STRUM', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Ludo', lead_type: 'person',     harmony: ['Kevin', 'Cerise'], licks: 'GTR', parts: { BJO: 'ROLL', MDO: 'CHOP', GTR: 'STRUM', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR',  lead_type: 'instrument', harmony: [],                  licks: '',    parts: { BJO: 'POMP', MDO: 'OPEN', GTR: 'SOLO',  BASS: 'ALT' }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Ludo', lead_type: 'person',     harmony: [],                  licks: 'BJO', parts: { BJO: 'ROLL', MDO: 'CHOP', GTR: 'SOLO',  BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Ludo', lead_type: 'person',     harmony: ['Kevin', 'Cerise'], licks: '',    parts: { BJO: 'ROLL', MDO: 'CHOP', GTR: 'SOLO',  BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Ludo', lead_type: 'person',     harmony: ['Kevin', 'Cerise'], licks: '',    parts: { BJO: 'ROLL', MDO: 'CHOP', GTR: 'SOLO',  BASS: 'ALT' }, comment: '' },
    ],
  },

  // ── Gloryland ─────────────────────────────────────────────────────────────
  // NOTE: Intro has GUITAR L = 'Grun' — unknown technique, clarify with band.
  // GTR K / VIOLON in LEAD = instrument leads (no separate column for those sections).
  {
    title:             'Gloryland',
    versionName:       'Default',
    hiddenInstruments: ['GTR', 'MDO', 'VLN', 'FDL'],
    rows: [
      { structure: 'INTRO',  part: '',  lead: '',       lead_type: '',           harmony: [],               licks: '',    parts: { GTR_L: 'Grun',  GTR_K: '',     BJO: '',      BASS: ''    }, comment: 'Am' },
      { structure: 'C1',     part: 'A', lead: 'Ludo',   lead_type: 'person',     harmony: ['Kevin','Cerise'], licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Ludo',   lead_type: 'person',     harmony: ['Kevin','Cerise'], licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR K',  lead_type: 'instrument', harmony: [],               licks: '',    parts: { GTR_L: 'STRUM', GTR_K: 'SOLO',  BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Ludo',   lead_type: 'person',     harmony: ['Kevin','Cerise'], licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Ludo',   lead_type: 'person',     harmony: ['Kevin','Cerise'], licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'VIOLON', lead_type: 'instrument', harmony: [],               licks: '',    parts: { GTR_L: 'STRUM', GTR_K: 'SOLO',  BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Ludo',   lead_type: 'person',     harmony: ['Kevin','Cerise'], licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Ludo',   lead_type: 'person',     harmony: ['Kevin','Cerise'], licks: '',    parts: { GTR_L: '',      GTR_K: '',      BJO: '',      BASS: ''    }, comment: 'A CAPPELLA — demi grille' },
      { structure: 'R',      part: 'B', lead: 'Ludo',   lead_type: 'person',     harmony: ['Kevin','Cerise'], licks: '',    parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
    ],
  },

  // ── Hares on the Mountain ────────────────────────────────────────────────
  // HARMO = mouth harp (the "HARP" column). Techniques: NAPE, INSTRU.
  // NOTE: Intro FIDDLE=NAPE — verify technique name is correct.
  // NOTE: C5/C6 FIDDLE=INSTRU by ditto from fiddle INSTRU — verify intentional.
  // LEAD=ALL in final INSTRU = all instruments play together.
  {
    title:             'Hares on the Mountain',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'MDO', 'VLN', 'BASS'],
    rows: [
      { structure: 'INTRO',  part: 'A', lead: 'BANJO',  lead_type: 'instrument', harmony: [],       licks: '',      parts: { GTR: 'STRUM', HARMO: '',       BJO: 'INSTRU', FDL: 'NAPE'    }, comment: 'Kick Guitar' },
      { structure: 'C1',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Ludo'], licks: '',      parts: { GTR: 'STRUM', HARMO: '',       BJO: 'ROLL',   FDL: 'LONG BOW' }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Ludo'], licks: '',      parts: { GTR: 'STRUM', HARMO: 'NAPE',   BJO: 'ROLL',   FDL: 'LONG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'HARMO',  lead_type: 'instrument', harmony: [],       licks: '',      parts: { GTR: 'STRUM', HARMO: 'INSTRU', BJO: 'ROLL',   FDL: 'LONG BOW' }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Ludo'], licks: 'HARMO', parts: { GTR: 'STRUM', HARMO: 'NAPE',   BJO: 'ROLL',   FDL: 'LONG BOW' }, comment: '' },
      { structure: 'C4',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Ludo'], licks: 'HARMO', parts: { GTR: 'STRUM', HARMO: 'NAPE',   BJO: 'ROLL',   FDL: 'LONG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'FIDDLE', lead_type: 'instrument', harmony: [],       licks: '',      parts: { GTR: 'STRUM', HARMO: 'NAPE',   BJO: 'ROLL',   FDL: 'INSTRU'  }, comment: '' },
      { structure: 'C5',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Ludo'], licks: 'HARMO', parts: { GTR: 'STRUM', HARMO: 'NAPE',   BJO: 'ROLL',   FDL: 'INSTRU'  }, comment: '' },
      { structure: 'C6',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Ludo'], licks: 'HARMO', parts: { GTR: 'STRUM', HARMO: 'NAPE',   BJO: 'ROLL',   FDL: 'INSTRU'  }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'ALL',    lead_type: 'instrument', harmony: [],       licks: '',      parts: { GTR: 'STRUM', HARMO: 'INSTRU', BJO: 'INSTRU', FDL: 'INSTRU'  }, comment: '' },
    ],
  },

  // ── The Train That Carried My Girl From Town ─────────────────────────────
  {
    title:             'The Train That Carried My Girl From Town',
    versionName:       'Default',
    hiddenInstruments: ['GTR', 'MDO', 'VLN', 'FDL', 'HARMO'],
    rows: [
      { structure: 'INTRO',  part: 'AAB', lead: 'GTR L',  lead_type: 'instrument', harmony: [],               licks: '', parts: { GTR_L: 'SOLO',  GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'C1',     part: 'AA',  lead: 'Ludo',   lead_type: 'person',     harmony: [],               licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: 'Break' },
      { structure: 'R',      part: 'BB',  lead: 'Ludo',   lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'AAB', lead: 'BJO',    lead_type: 'instrument', harmony: [],               licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'SOLO', BASS: 'ALT' }, comment: '' },
      { structure: 'C2',     part: 'AA',  lead: 'Ludo',   lead_type: 'person',     harmony: [],               licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: 'Break' },
      { structure: 'R',      part: 'BB',  lead: 'Ludo',   lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'AAB', lead: 'GTR K',  lead_type: 'instrument', harmony: [],               licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'C3',     part: 'AA',  lead: 'Ludo',   lead_type: 'person',     harmony: [],               licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: 'Break' },
      { structure: 'R',      part: 'BB',  lead: 'Ludo',   lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'AAB', lead: 'GTR L',  lead_type: 'instrument', harmony: [],               licks: '', parts: { GTR_L: 'SOLO',  GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'C4',     part: 'AA',  lead: 'Ludo',   lead_type: 'person',     harmony: [],               licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: 'Break' },
      { structure: 'R',      part: 'BB',  lead: 'Ludo',   lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'BB',  lead: 'Ludo',   lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: '', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
    ],
  },

  // ── Cowboy Man ────────────────────────────────────────────────────────────
  {
    title:             'Cowboy Man',
    versionName:       'Default',
    hiddenInstruments: ['GTR', 'MDO', 'VLN'],
    rows: [
      { structure: 'C1', part: 'A', lead: 'Ludo', lead_type: 'person', harmony: [],                  licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT', FDL: 'LNG BOW' }, comment: '' },
      { structure: 'C2', part: 'A', lead: 'Ludo', lead_type: 'person', harmony: [],                  licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT', FDL: 'LNG BOW' }, comment: '' },
      { structure: 'R',  part: 'B', lead: 'Ludo', lead_type: 'person', harmony: ['Cerise', 'Kevin'], licks: 'FDL', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT', FDL: 'CHOP'    }, comment: '' },
      { structure: 'C3', part: 'A', lead: 'Ludo', lead_type: 'person', harmony: [],                  licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT', FDL: 'LNG BOW' }, comment: '' },
      { structure: 'R',  part: 'B', lead: 'Ludo', lead_type: 'person', harmony: ['Cerise', 'Kevin'], licks: 'FDL', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT', FDL: 'CHOP'    }, comment: '' },
      { structure: 'C4', part: 'A', lead: 'Ludo', lead_type: 'person', harmony: [],                  licks: 'BJO', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT', FDL: 'LNG BOW' }, comment: '' },
      { structure: 'R',  part: 'B', lead: 'Ludo', lead_type: 'person', harmony: ['Cerise', 'Kevin'], licks: 'FDL', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT', FDL: 'CHOP'    }, comment: '' },
      { structure: 'R',  part: 'B', lead: 'Ludo', lead_type: 'person', harmony: ['Cerise', 'Kevin'], licks: 'FDL', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT', FDL: 'CHOP'    }, comment: "Tenir le dernier D jusqu'à épuisement" },
    ],
  },
];
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const slug   = process.argv[2] || process.env.ARTIST_SLUG;
  const dbUrl  = process.argv[3] || process.env.DATABASE_URL;

  if (!slug) {
    console.error('Usage: node scripts/seed_arrangements.js <slug> [database_url]');
    process.exit(1);
  }
  if (!dbUrl) {
    console.error('ERROR: No database URL. Pass it as the second argument or set DATABASE_URL in .env');
    process.exit(1);
  }

  const sql = neon(dbUrl);

  const [artist] = await sql`SELECT id, name FROM artists WHERE slug = ${slug}`;
  if (!artist) {
    console.error('ERROR: Artist not found for slug:', slug);
    process.exit(1);
  }

  const dbHost = new URL(dbUrl).hostname;
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

      // Deactivate all existing versions before inserting/updating to maintain one-active invariant
      await sql`UPDATE song_arrangements SET is_active = false WHERE song_id = ${songId} AND artist_id = ${artist.id}`;

      if (existing.length) {
        await sql`
          UPDATE song_arrangements
          SET rows               = ${entry.rows || []},
              hidden_instruments = ${entry.hiddenInstruments || []},
              is_active          = true,
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
