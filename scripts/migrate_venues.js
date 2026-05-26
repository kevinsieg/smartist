#!/usr/bin/env node
'use strict';
// One-time migration: convert gigs.venue text → venues rows + backfill venue_id.
// Safe to re-run: checks for existing venue rows before inserting.

const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');
const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, res));

function loadEnv(f) {
  try { fs.readFileSync(f,'utf8').split('\n').forEach(l => { const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)/); if(m&&!process.env[m[1]]){let v=m[2].trim();if((v[0]==='"'&&v.slice(-1)==='"')||(v[0]==="'"&&v.slice(-1)==="'"))v=v.slice(1,-1);process.env[m[1]]=v;}}); } catch {}
}
loadEnv(path.join(__dirname,'../.env.local'));
loadEnv(path.join(__dirname,'../.env'));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sql = neon(url);

  const venuesTable = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'venues'
  `;
  if (!venuesTable.length) {
    console.error('\nrelation "venues" does not exist — apply schema first:\n  node scripts/migrate-schema.js\n');
    process.exit(1);
  }

  const venueIdCol = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'gigs' AND column_name = 'venue_id'
  `;
  if (!venueIdCol.length) {
    console.error('\ngigs.venue_id missing — apply schema first:\n  node scripts/migrate-schema.js\n');
    process.exit(1);
  }

  // Check the venue column still exists (migration is safe to skip if already run)
  const cols = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name='gigs' AND column_name='venue'
  `;
  if (!cols.length) { console.log('venue column already dropped — skipping.'); rl.close(); return; }

  const artists = await sql`SELECT id, name FROM artists`;
  console.log(`Found ${artists.length} artist(s).`);
  const autoYes = process.argv.includes('--yes');
  const ans = autoYes ? 'y' : await ask('Run venue migration? (y/N) ');
  if (ans.trim().toLowerCase() !== 'y') { console.log('Aborted.'); rl.close(); return; }

  for (const artist of artists) {
    console.log(`\nProcessing artist: ${artist.name}`);

    // Seed placeholder venues
    const placeholders = [
      { name: 'Private Event', category: 'placeholder' },
      { name: 'One-off / TBD',  category: 'placeholder' },
      { name: 'Festival (unlisted)', category: 'placeholder' },
    ];
    for (const p of placeholders) {
      await sql`
        INSERT INTO venues (artist_id, name, category)
        VALUES (${artist.id}, ${p.name}, ${p.category})
        ON CONFLICT DO NOTHING
      `;
    }
    console.log('  ✓ placeholder venues seeded');

    // Collect distinct non-null venue texts
    const rows = await sql`
      SELECT DISTINCT venue FROM gigs
      WHERE artist_id = ${artist.id} AND venue IS NOT NULL AND venue <> ''
    `;
    console.log(`  Found ${rows.length} distinct venue text(s)`);

    for (const { venue: text } of rows) {
      const existing = await sql`
        SELECT id FROM venues WHERE artist_id = ${artist.id} AND name = ${text} AND category = 'legacy'
      `;
      const venueId = existing.length
        ? existing[0].id
        : (await sql`INSERT INTO venues (artist_id, name, category) VALUES (${artist.id}, ${text}, 'legacy') RETURNING id`)[0].id;

      await sql`UPDATE gigs SET venue_id = ${venueId} WHERE artist_id = ${artist.id} AND venue = ${text}`;
      console.log(`  ✓ "${text}" → venue #${venueId}`);
    }
  }

  // Drop the old text column
  await sql`ALTER TABLE gigs DROP COLUMN IF EXISTS venue`;
  console.log('\n✓ gigs.venue column dropped');
  console.log('Done.');
  rl.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
