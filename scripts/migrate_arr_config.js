#!/usr/bin/env node
// Patches artists.config.arrangementConfig (instruments + members) onto a target DB.
// Usage:
//   node scripts/migrate_arr_config.js <slug> [database_url]
//
//   slug         — artist slug on the target DB (required)
//   database_url — target Neon connection string (optional; falls back to DATABASE_URL in .env)
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

// ── Arrangement config ────────────────────────────────────────────────────────
// Members: name shown in lead/harmony cells, abbr shown in the harmony column.
const ARR_CONFIG = {
  members: [
    { name: 'Ludo',   abbr: 'L' },
    { name: 'Kevin',  abbr: 'K' },
    { name: 'Cerise', abbr: 'C' },
  ],
  instruments: [
    { key: 'GTR',   label: 'Guitar',           techniques: ['STRUM', 'PICK', 'SOLO'] },
    { key: 'GTR_L', label: 'Guitar L (Ludo)',  techniques: ['STRUM', 'PICK', 'SOLO'] },
    { key: 'GTR_K', label: 'Guitar K (Kevin)', techniques: ['STRUM', 'PICK', 'SOLO'] },
    { key: 'BJO',   label: 'Banjo',            techniques: ['ROLL', 'POMP', 'CHOP', 'SOLO', 'OPEN', 'INSTRU'] },
    { key: 'MDO',   label: 'Mando',            techniques: ['CHOP', 'SOLO', 'OPEN', 'STRUM', 'INSTRU'] },
    { key: 'VLN',   label: 'Violon',           techniques: ['LNG BOW', 'CHOP', 'INSTRU'] },
    { key: 'FDL',   label: 'Fiddle',           techniques: ['LONG BOW', 'NAPE', 'CHOP', 'INSTRU'] },
    { key: 'BASS',  label: 'Bass',             techniques: ['ALT', 'BOW', 'SOLO', 'FINGER', 'JOIN'] },
    { key: 'HARMO', label: 'Harp/Harmonica',   techniques: ['NAPE', 'INSTRU'] },
  ],
};
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const slug  = process.argv[2];
  const dbUrl = process.argv[3] || process.env.DATABASE_URL;

  if (!slug) {
    console.error('Usage: node scripts/migrate_arr_config.js <slug> [database_url]');
    process.exit(1);
  }
  if (!dbUrl) {
    console.error('ERROR: No database URL. Pass it as the second argument or set DATABASE_URL in .env');
    process.exit(1);
  }

  const sql = neon(dbUrl);

  console.log('\nDB host:', new URL(dbUrl).hostname);

  const [artist] = await sql`SELECT id, name, config FROM artists WHERE slug = ${slug}`;
  if (!artist) { console.error('ERROR: Artist not found for slug:', slug); process.exit(1); }

  console.log('Artist :', artist.name, '(id=' + artist.id + ')');

  const existing = artist.config?.arrangementConfig;
  if (existing) {
    console.log('\nWARNING: arrangementConfig already set — will be replaced.');
    console.log('  Members     :', (existing.members || []).map(m => m.name).join(', ') || '(none)');
    console.log('  Instruments :', (existing.instruments || []).map(i => i.key).join(', ') || '(none)');
  } else {
    console.log('\narrangementConfig: (not set — will be created)');
  }

  console.log('\nWill write:');
  console.log('  Members     :', ARR_CONFIG.members.map(m => `${m.name} (${m.abbr})`).join(', '));
  console.log('  Instruments :', ARR_CONFIG.instruments.map(i => i.key).join(', '));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question('\nProceed? (y/N) ', ans => {
      rl.close();
      if (ans.toLowerCase() !== 'y') { console.log('Aborted.'); process.exit(0); }
      resolve();
    });
  });

  const patch = JSON.stringify({ arrangementConfig: ARR_CONFIG });
  await sql`
    UPDATE artists
    SET config = COALESCE(config, '{}'::jsonb) || ${patch}::jsonb
    WHERE id = ${artist.id}
  `;

  console.log('Done. arrangementConfig patched.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
