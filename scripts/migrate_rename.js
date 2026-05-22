#!/usr/bin/env node
'use strict';
// One-time migration: rename bands→artists, band_id→artist_id across all tables,
// rename gigs.name→title and gigs.notes→comment, fix setlists FK.
//
// The Neon HTTP driver does not support RENAME COLUMN IF EXISTS syntax;
// idempotency is handled by checking information_schema before each rename.
// Dynamic DDL (table/column names) uses sql([string]) — the raw-string trick
// supported by @neondatabase/serverless instead of sql.unsafe().

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

  /** Execute raw DDL string (table/column names are not user-supplied). */
  const ddl = str => sql([str]);

  /** Returns true if the table exists in public schema. */
  async function tableExists(name) {
    const r = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    `;
    return r.length > 0;
  }

  /** Returns true if the column exists on the given table. */
  async function colExists(table, col) {
    const r = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${col}
    `;
    return r.length > 0;
  }

  /** Returns true if a constraint with this name exists on the table. */
  async function constraintExists(table, constraint) {
    const r = await sql`
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public' AND table_name = ${table} AND constraint_name = ${constraint}
    `;
    return r.length > 0;
  }

  const [{ current_database: db }] = await sql`SELECT current_database()`;
  console.log(`DB: ${db}`);
  const autoYes = process.argv.includes('--yes');
  const ans = autoYes ? 'y' : await ask('Run rename migration? (y/N) ');
  if (ans.trim().toLowerCase() !== 'y') { console.log('Aborted.'); rl.close(); return; }

  // 1. Rename table bands → artists
  if (await tableExists('bands')) {
    await ddl(`ALTER TABLE bands RENAME TO artists`);
    console.log('✓ bands → artists');
  } else {
    console.log('  (bands table not found — already renamed)');
  }

  // 2. Rename band_id → artist_id on each table
  const tables = ['songs', 'gigs', 'setlists', 'song_logs', 'gema_works'];
  for (const tbl of tables) {
    if (await colExists(tbl, 'band_id')) {
      await ddl(`ALTER TABLE ${tbl} RENAME COLUMN band_id TO artist_id`);
      console.log(`✓ ${tbl}.band_id → artist_id`);
    } else {
      console.log(`  (${tbl}.band_id already renamed)`);
    }
  }

  // 3. Rename gigs.name → title and gigs.notes → comment
  if (await colExists('gigs', 'name')) {
    await ddl(`ALTER TABLE gigs RENAME COLUMN name TO title`);
    console.log('✓ gigs.name → title');
  } else {
    console.log('  (gigs.name already renamed)');
  }
  if (await colExists('gigs', 'notes')) {
    await ddl(`ALTER TABLE gigs RENAME COLUMN notes TO comment`);
    console.log('✓ gigs.notes → comment');
  } else {
    console.log('  (gigs.notes already renamed)');
  }

  // 4. Fix setlists.gig_id FK: ON DELETE SET NULL → ON DELETE RESTRICT
  if (await constraintExists('setlists', 'setlists_gig_id_fkey')) {
    await sql`ALTER TABLE setlists DROP CONSTRAINT setlists_gig_id_fkey`;
  }
  await sql`
    ALTER TABLE setlists
      ADD CONSTRAINT setlists_gig_id_fkey
      FOREIGN KEY (gig_id) REFERENCES gigs(id) ON DELETE RESTRICT
  `;
  console.log('✓ setlists.gig_id FK → RESTRICT');

  // 5. Recreate indexes (drop old names, create new)
  await sql`DROP INDEX IF EXISTS songs_band_id_idx`;
  await sql`DROP INDEX IF EXISTS songs_band_active_idx`;
  await sql`DROP INDEX IF EXISTS gigs_band_id_idx`;
  await sql`DROP INDEX IF EXISTS setlists_band_id_idx`;
  await sql`DROP INDEX IF EXISTS song_logs_band_idx`;
  await sql`DROP INDEX IF EXISTS gema_works_band_id_idx`;
  await sql`CREATE INDEX IF NOT EXISTS songs_artist_id_idx     ON songs(artist_id)`;
  await sql`CREATE INDEX IF NOT EXISTS songs_artist_active_idx ON songs(artist_id, active)`;
  await sql`CREATE INDEX IF NOT EXISTS gigs_artist_id_idx      ON gigs(artist_id)`;
  await sql`CREATE INDEX IF NOT EXISTS setlists_artist_id_idx  ON setlists(artist_id)`;
  await sql`CREATE INDEX IF NOT EXISTS song_logs_artist_idx    ON song_logs(artist_id, changed_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS gema_works_artist_id_idx ON gema_works(artist_id)`;
  console.log('✓ indexes recreated');

  console.log('\nDone.');
  rl.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
