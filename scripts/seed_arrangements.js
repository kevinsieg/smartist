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
//   MDO     = Mando        techniques: CHOP, SOLO, OPEN, INSTRU
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

  // ── How Mountain Girls Can Love ──────────────────────────────────────────
  // Kevin leads throughout. harmony='All' = whole band sings.
  // First R is a cappella (no instruments). GTR END on last R = comment only.
  {
    title:             'How Mountain Girls Can Love',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'VLN', 'HARMO'],
    rows: [
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['All'], licks: '',    parts: { GTR: '',      BJO: '',      MDO: '',      BASS: '',    FDL: ''      }, comment: 'A CAPPELLA' },
      { structure: 'C1',     part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],      licks: 'MDO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: ''      }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['All'], licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: ''      }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'MDO',   lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', BASS: 'ALT', FDL: ''     }, comment: '' },
      { structure: 'INSTRU', part: 'B', lead: 'BJO',   lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'INSTRU', MDO: 'CHOP', BASS: 'ALT', FDL: ''     }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],      licks: 'FDL', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: ''      }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['All'], licks: 'FDL', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: ''      }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'FDL',   lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'INSTRU' }, comment: '' },
      { structure: 'INSTRU', part: 'B', lead: 'FDL',   lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'INSTRU' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['All'], licks: 'FDL', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: ''      }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['All'], licks: 'FDL', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: ''      }, comment: 'GTR END' },
    ],
  },

  // ── Jackaroe ──────────────────────────────────────────────────────────────
  // Cerise leads throughout. 'Blanche' = whole/half note style (comment only).
  // C8 has no instruments (silent section before Blanche).
  // INSTRU GTR K: both GTR_K and GTR_L play SOLO simultaneously — verify intentional.
  // Column order in source was GUITAR K / GUITAR L (reversed vs other songs).
  {
    title:             'Jackaroe',
    versionName:       'Default',
    hiddenInstruments: ['GTR', 'MDO', 'VLN', 'FDL', 'HARMO'],
    rows: [
      { structure: 'INTRO',  part: '',  lead: 'GTR K',  lead_type: 'instrument', harmony: [],              licks: '', parts: { GTR_K: 'PICK',  GTR_L: '',      BJO: '',      BASS: ''    }, comment: 'kick Kevin' },
      { structure: 'C1',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'PICK',  GTR_L: '',      BJO: '',      BASS: ''    }, comment: 'Blanche' },
      { structure: 'C2',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'PICK',  GTR_L: '',      BJO: '',      BASS: ''    }, comment: 'Blanche' },
      { structure: 'C3',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'PICK',  GTR_L: 'STRUM', BJO: '',      BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'BJO',    lead_type: 'instrument', harmony: [],              licks: '', parts: { GTR_K: 'STRUM', GTR_L: 'STRUM', BJO: 'SOLO', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'BJO',    lead_type: 'instrument', harmony: [],              licks: '', parts: { GTR_K: 'STRUM', GTR_L: 'STRUM', BJO: 'SOLO', BASS: 'ALT' }, comment: '' },
      { structure: 'C4',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'STRUM', GTR_L: 'STRUM', BJO: '',      BASS: 'ALT' }, comment: '' },
      { structure: 'C5',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'STRUM', GTR_L: 'STRUM', BJO: '',      BASS: 'ALT' }, comment: '' },
      { structure: 'C6',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'STRUM', GTR_L: 'STRUM', BJO: '',      BASS: 'ALT' }, comment: '' },
      { structure: 'C7',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'STRUM', GTR_L: 'STRUM', BJO: '',      BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR L',  lead_type: 'instrument', harmony: [],              licks: '', parts: { GTR_K: 'STRUM', GTR_L: 'SOLO',  BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR K',  lead_type: 'instrument', harmony: [],              licks: '', parts: { GTR_K: 'SOLO',  GTR_L: 'SOLO',  BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR L',  lead_type: 'instrument', harmony: [],              licks: '', parts: { GTR_K: 'STRUM', GTR_L: 'SOLO',  BJO: 'CHOP', BASS: 'ALT' }, comment: '' },
      { structure: 'C8',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: '',      GTR_L: '',      BJO: '',      BASS: ''    }, comment: 'Blanche' },
      { structure: 'C9',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'PICK',  GTR_L: '',      BJO: '',      BASS: ''    }, comment: 'Blanche' },
      { structure: 'C10',    part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: ['Kevin','Ludo'], licks: '', parts: { GTR_K: 'PICK',  GTR_L: 'STRUM', BJO: '',      BASS: 'ALT' }, comment: '' },
    ],
  },

  // ── There Is A Time ──────────────────────────────────────────────────────
  {
    title:             'There Is A Time',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'VLN', 'HARMO'],
    rows: [
      { structure: 'INTRO',  part: 'A', lead: 'MDO',   lead_type: 'instrument', harmony: [],               licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'SOLO', BASS: 'ALT', FDL: 'CHOP'     }, comment: 'Kick Mando' },
      { structure: 'C1',     part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],               licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: 'FDL', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'BJO',   lead_type: 'instrument', harmony: [],               licks: '',    parts: { GTR: 'STRUM', BJO: 'SOLO', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],               licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: 'FDL', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR',   lead_type: 'instrument', harmony: [],               licks: '',    parts: { GTR: 'SOLO',  BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],               licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: 'FDL', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'FDL',   lead_type: 'instrument', harmony: [],               licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'SOLO'     }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'ALT', FDL: 'LONG BOW' }, comment: '' },
    ],
  },

  // ── Troubles ─────────────────────────────────────────────────────────────
  {
    title:             'Troubles',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'FDL', 'HARMO', 'BASS'],
    rows: [
      { structure: 'INTRO',  part: 'A', lead: 'MDO',     lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', VLN: 'LNG BOW' }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: [],      licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'OPEN',   VLN: 'LNG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'VLN',     lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'OPEN',   VLN: 'INSTRU'  }, comment: '' },
      { structure: 'C1',     part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: [],      licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'OPEN',   VLN: 'CHOP'    }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: ['Kevin'], licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'OPEN',   VLN: 'LNG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'VLN+MDO', lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', VLN: 'INSTRU'  }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: ['Kevin'], licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'OPEN',   VLN: 'LNG BOW' }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Ludo',    lead_type: 'person',     harmony: ['Kevin'], licks: 'BJO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'OPEN',   VLN: 'LNG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'VLN+MDO', lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', VLN: 'INSTRU'  }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'VLN+MDO', lead_type: 'instrument', harmony: [],      licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', VLN: 'INSTRU'  }, comment: '' },
    ],
  },

  // ── Way Over Yonder ──────────────────────────────────────────────────────
  // NOTE: C5/C6 and final R rows inherit MDO='SOLO' by ditto from INSTRU MDO — verify intentional.
  // NOTE: GTR='STRUM' carries from C3 through all subsequent rows including INSTRU sections — verify.
  // NOTE: harmony on final two R rows is '?' in source — left empty pending confirmation.
  {
    title:             'Way Over Yonder',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'VLN', 'BASS', 'HARMO'],
    rows: [
      { structure: 'INTRO',  part: '',  lead: '',       lead_type: '',           harmony: [],    licks: '',    parts: { BJO: '',     MDO: '',      GTR: '',      FDL: ''        }, comment: 'INTRO' },
      { structure: 'C1',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: '',    parts: { BJO: 'OPEN', MDO: '',      GTR: '',      FDL: ''        }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: '',    parts: { BJO: 'OPEN', MDO: '',      GTR: '',      FDL: 'LONG BOW' }, comment: '' },
      { structure: 'R',      part: 'B', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: '',    parts: { BJO: 'CHOP', MDO: 'STRUM', GTR: '',      FDL: 'LONG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'BJO',    lead_type: 'instrument', harmony: [],    licks: '',    parts: { BJO: 'SOLO', MDO: 'OPEN',  GTR: '',      FDL: 'LONG BOW' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR',    lead_type: 'instrument', harmony: [],    licks: '',    parts: { BJO: 'POMP', MDO: 'OPEN',  GTR: 'SOLO',  FDL: 'LONG BOW' }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: 'MDO', parts: { BJO: '',     MDO: 'OPEN',  GTR: 'STRUM', FDL: 'LONG BOW' }, comment: 'Shuffle' },
      { structure: 'C4',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: 'MDO', parts: { BJO: '',     MDO: 'OPEN',  GTR: 'STRUM', FDL: 'LONG BOW' }, comment: 'Shuffle' },
      { structure: 'R',      part: 'B', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: 'FDL', parts: { BJO: 'CHOP', MDO: 'OPEN',  GTR: 'STRUM', FDL: 'LONG BOW' }, comment: 'Licks' },
      { structure: 'INSTRU', part: 'A', lead: 'VIOLON', lead_type: 'instrument', harmony: [],    licks: '',    parts: { BJO: 'POMP', MDO: 'OPEN',  GTR: 'STRUM', FDL: 'SOLO'    }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'MDO',    lead_type: 'instrument', harmony: [],    licks: '',    parts: { BJO: 'POMP', MDO: 'SOLO',  GTR: 'STRUM', FDL: 'CHOP'    }, comment: '' },
      { structure: 'C5',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: 'MDO', parts: { BJO: '',     MDO: 'SOLO',  GTR: 'STRUM', FDL: 'LONG BOW' }, comment: '' },
      { structure: 'C6',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: 'MDO', parts: { BJO: '',     MDO: 'SOLO',  GTR: 'STRUM', FDL: 'LONG BOW' }, comment: 'Shuffle' },
      { structure: 'R',      part: 'B', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: 'FDL', parts: { BJO: '',     MDO: 'SOLO',  GTR: 'STRUM', FDL: 'LONG BOW' }, comment: 'Licks — harmony TBD' },
      { structure: 'R',      part: 'B', lead: 'Cerise', lead_type: 'person',     harmony: [],    licks: 'FDL', parts: { BJO: '',     MDO: 'SOLO',  GTR: 'STRUM', FDL: 'LONG BOW' }, comment: 'Licks — harmony TBD' },
    ],
  },

  // ── Walk On Boy ──────────────────────────────────────────────────────────
  // NOTE: C3/R3 (rows after GTR K INSTRU) inherit GTR_K='SOLO' by ditto — verify intentional.
  // NOTE: C3/R3/OUTRO (rows after GTR L INSTRU) inherit GTR_L='SOLO' + GTR_K='SOLO' by ditto — verify intentional.
  {
    title:             'Walk On Boy',
    versionName:       'Default',
    hiddenInstruments: ['GTR', 'MDO', 'VLN', 'FDL', 'HARMO'],
    rows: [
      { structure: 'C1',     part: 'A', lead: 'Ludo',  lead_type: 'person',     harmony: [],                 licks: 'GTR_L', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: '2 premiere mesure ludo acapella' },
      { structure: 'R1',     part: 'B', lead: 'Ludo',  lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: 'GTR_L', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'BJO',   lead_type: 'instrument', harmony: [],                 licks: '',      parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'SOLO', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'B', lead: 'BJO',   lead_type: 'instrument', harmony: [],                 licks: '',      parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'SOLO', BASS: 'ALT' }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Ludo',  lead_type: 'person',     harmony: [],                 licks: 'GTR_L', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'R2',     part: 'B', lead: 'Ludo',  lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: 'GTR_L', parts: { GTR_L: 'STRUM', GTR_K: 'STRUM', BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR K', lead_type: 'instrument', harmony: [],                 licks: '',      parts: { GTR_L: 'STRUM', GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'B', lead: 'GTR K', lead_type: 'instrument', harmony: [],                 licks: '',      parts: { GTR_L: 'STRUM', GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Ludo',  lead_type: 'person',     harmony: [],                 licks: 'GTR_L', parts: { GTR_L: 'STRUM', GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'R3',     part: 'B', lead: 'Ludo',  lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: 'GTR_L', parts: { GTR_L: 'STRUM', GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'GTR L', lead_type: 'instrument', harmony: [],                 licks: '',      parts: { GTR_L: 'SOLO',  GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'B', lead: 'GTR L', lead_type: 'instrument', harmony: [],                 licks: '',      parts: { GTR_L: 'SOLO',  GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Ludo',  lead_type: 'person',     harmony: [],                 licks: 'GTR_L', parts: { GTR_L: 'SOLO',  GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'R3',     part: 'B', lead: 'Ludo',  lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: 'GTR_L', parts: { GTR_L: 'SOLO',  GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: '' },
      { structure: 'OUTRO',  part: 'B', lead: 'Ludo',  lead_type: 'person',     harmony: ['Cerise','Kevin'], licks: 'GTR_L', parts: { GTR_L: 'SOLO',  GTR_K: 'SOLO',  BJO: 'ROLL', BASS: 'ALT' }, comment: 'Turnaround' },
    ],
  },

  // ── White Oak Mountain ───────────────────────────────────────────────────
  // BJO drops out for all verse/refrain rows; only plays CHOP in INSTRU sections.
  // Final two R (All) rows carry FDL='INSTRU' by ditto from the preceding MDO+FDL INSTRU.
  {
    title:             'White Oak Mountain',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'VLN', 'HARMO'],
    rows: [
      { structure: 'INTRO',  part: 'A', lead: 'MDO',     lead_type: 'instrument', harmony: [],       licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', FDL: 'CHOP',   BASS: 'ALT' }, comment: 'Kick Mando' },
      { structure: 'R',      part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: ['Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: '',     MDO: 'OPEN',   FDL: 'CHOP',   BASS: 'ALT' }, comment: '' },
      { structure: 'C1',     part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: [],       licks: 'FDL', parts: { GTR: 'STRUM', BJO: '',     MDO: 'CHOP',   FDL: 'NAPE',   BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: ['Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: '',     MDO: 'OPEN',   FDL: 'CHOP',   BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'FDL',     lead_type: 'instrument', harmony: [],       licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'OPEN',   FDL: 'INSTRU', BASS: 'ALT' }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: [],       licks: 'FDL', parts: { GTR: 'STRUM', BJO: '',     MDO: 'CHOP',   FDL: 'NAPE',   BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: ['Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: '',     MDO: 'OPEN',   FDL: 'CHOP',   BASS: 'ALT' }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'MDO+FDL', lead_type: 'instrument', harmony: [],       licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', FDL: 'INSTRU', BASS: 'ALT' }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: [],       licks: 'FDL', parts: { GTR: 'STRUM', BJO: '',     MDO: 'CHOP',   FDL: 'NAPE',   BASS: 'ALT' }, comment: '' },
      { structure: 'C4',     part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: [],       licks: 'FDL', parts: { GTR: 'STRUM', BJO: '',     MDO: 'CHOP',   FDL: 'NAPE',   BASS: 'ALT' }, comment: 'Break sur "Blow"' },
      { structure: 'R',      part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: ['Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: '',     MDO: 'OPEN',   FDL: 'CHOP',   BASS: 'ALT' }, comment: 'Reprise sur 1' },
      { structure: 'INSTRU', part: 'A', lead: 'MDO+FDL', lead_type: 'instrument', harmony: [],       licks: '',    parts: { GTR: 'STRUM', BJO: 'CHOP', MDO: 'INSTRU', FDL: 'INSTRU', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: ['All'],  licks: '',    parts: { GTR: 'STRUM', BJO: '',     MDO: 'OPEN',   FDL: 'INSTRU', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: ['All'],  licks: '',    parts: { GTR: 'STRUM', BJO: '',     MDO: 'OPEN',   FDL: 'INSTRU', BASS: 'ALT' }, comment: '' },
      { structure: 'R',      part: 'A', lead: 'Cerise',  lead_type: 'person',     harmony: ['All'],  licks: '',    parts: { GTR: '',      BJO: '',     MDO: '',       FDL: '',       BASS: ''    }, comment: 'A CAPPELLA' },
    ],
  },

  // ── Caleb Meyer ──────────────────────────────────────────────────────────
  // HARMO column is always '-' (silent) → hidden.
  // BASS drops out after the INTRO JOIN — only guitar plays through most verses.
  // BREAK + C7: fully silent / a cappella — all parts empty.
  // 2nd INSTRU + R3: GTR='STRUM' resumed from pre-break value (source ditto was ambiguous after silent C7).
  // 'JOIN' technique in INTRO = instruments enter on the guitar cue — add to Hub config if needed.
  {
    title:             'Caleb Meyer',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'VLN', 'FDL', 'HARMO'],
    rows: [
      { structure: 'INTRO',  part: '',  lead: 'Kevin',  lead_type: 'person',     harmony: [],                licks: '',    parts: { GTR: 'STRUM', BJO: 'JOIN', MDO: 'JOIN', BASS: 'JOIN' }, comment: 'INSTR JOIN GIT' },
      { structure: 'C1',     part: 'A', lead: 'Kevin',  lead_type: 'person',     harmony: [],                licks: '',    parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'C2',     part: 'A', lead: 'Kevin',  lead_type: 'person',     harmony: [],                licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'R1',     part: 'A', lead: 'Kevin',  lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'C3',     part: 'A', lead: 'Kevin',  lead_type: 'person',     harmony: [],                licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'C4',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],                licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],                licks: '',    parts: { GTR: 'STRUM', BJO: 'SOLO', MDO: 'CHOP', BASS: ''     }, comment: '' },
      { structure: 'R2',     part: 'A', lead: 'Kevin',  lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'C5',     part: 'A', lead: 'Kevin',  lead_type: 'person',     harmony: [],                licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'C6',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],                licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'BREAK',  part: '',  lead: '',        lead_type: '',           harmony: [],                licks: '',    parts: { GTR: '',      BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'C7',     part: 'A', lead: 'Cerise', lead_type: 'person',     harmony: [],                licks: '',    parts: { GTR: '',      BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
      { structure: 'INSTRU', part: 'A', lead: 'Ludo',   lead_type: 'person',     harmony: [],                licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: 'SOLO', BASS: ''     }, comment: '' },
      { structure: 'R3',     part: 'A', lead: 'Kevin',  lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: 'MDO', parts: { GTR: 'STRUM', BJO: '',     MDO: '',     BASS: ''     }, comment: '' },
    ],
  },

  // ── Polly Vaughn ─────────────────────────────────────────────────────────
  // HARMONICA and VIOLON columns are always '-' (silent) → hidden.
  // MDO is empty in C3/C4 because LICKS=MDO (plays fills instead of a fixed technique).
  // BASS='FINGER' — add this technique to Hub config if not already present.
  {
    title:             'Polly Vaughn',
    versionName:       'Default',
    hiddenInstruments: ['GTR_L', 'GTR_K', 'HARMO', 'VLN'],
    rows: [
      { structure: 'INTRO',    part: '',  lead: 'GTR',   lead_type: 'instrument', harmony: [],                licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'FINGER' }, comment: 'Acceler vitesse' },
      { structure: 'C1',       part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],                licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'FINGER' }, comment: '' },
      { structure: 'R1',       part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'FINGER' }, comment: '' },
      { structure: 'C2',       part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],                licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'FINGER' }, comment: '' },
      { structure: 'R2',       part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'FINGER' }, comment: '' },
      { structure: 'C3',       part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],                licks: 'MDO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: '',     BASS: 'FINGER' }, comment: '' },
      { structure: 'R3',       part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'FINGER' }, comment: '' },
      { structure: 'C4',       part: 'A', lead: 'Kevin', lead_type: 'person',     harmony: [],                licks: 'MDO', parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: '',     BASS: 'FINGER' }, comment: '' },
      { structure: 'R4',       part: 'B', lead: 'Kevin', lead_type: 'person',     harmony: ['Cerise','Ludo'], licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'FINGER' }, comment: '' },
      { structure: 'TURNARND', part: '',  lead: 'Kevin', lead_type: 'person',     harmony: [],                licks: '',    parts: { GTR: 'STRUM', BJO: 'ROLL', MDO: 'CHOP', BASS: 'FINGER' }, comment: '' },
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

      const rowsJson        = JSON.stringify(entry.rows || []);
      const hiddenJson      = JSON.stringify(entry.hiddenInstruments || []);

      if (existing.length) {
        await sql`
          UPDATE song_arrangements
          SET rows               = ${rowsJson}::jsonb,
              hidden_instruments = ${hiddenJson}::jsonb,
              is_active          = true,
              updated_at         = NOW()
          WHERE id = ${existing[0].id}
        `;
        console.log('UPDATED:', entry.title, '→', versionName);
      } else {
        await sql`
          INSERT INTO song_arrangements (song_id, artist_id, name, rows, hidden_instruments, is_active)
          VALUES (${songId}, ${artist.id}, ${versionName}, ${rowsJson}::jsonb, ${hiddenJson}::jsonb, true)
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
