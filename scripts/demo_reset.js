#!/usr/bin/env node
/**
 * Smartist — Reset the public demo band to its seeded state
 *
 * Usage:
 *   node scripts/demo_reset.js --export            # snapshot the band into scripts/demo_seed.json
 *   node scripts/demo_reset.js                     # restore the band from that snapshot
 *   node scripts/demo_reset.js --dry-run           # show what would change, write nothing
 *   node scripts/demo_reset.js --yes               # no confirmation prompt (for the scheduled run)
 *
 * The demo band lives in the production database alongside real bands, so every
 * statement here is scoped to one artist_id. There is no table-wide DELETE.
 *
 * What it does NOT touch: the artists row itself (plan, config, logo) and the
 * users table — the accounts that can sign in to the demo survive a reset.
 *
 * Row ids are preserved so setlists keep pointing at the right songs, and each
 * sequence is bumped past the restored maximum afterwards.
 */

'use strict';

const postgres = require('postgres');
const readline = require('readline');
const fs       = require('fs');
const path     = require('path');

// ── Env ────────────────────────────────────────────────────────────────────

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
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

const ok   = msg => console.log(`  ${G('✓')} ${msg}`);
const warn = msg => console.log(`  ${Y('!')} ${msg}`);
const err  = msg => console.log(`  ${R('✗')} ${msg}`);

// ── Args ───────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const argOf    = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const slug     = argOf('artist') || process.env.DEMO_ARTIST_SLUG || 'demo';
const doExport = args.includes('--export');
const dryRun   = args.includes('--dry-run');
const assumeYes = args.includes('--yes');

const SEED_FILE = path.join(__dirname, 'demo_seed.json');

if (!process.env.DATABASE_URL) { err('DATABASE_URL is not set.'); process.exit(1); }

/**
 * Tables in dependency order — parents first. Restore walks this forwards,
 * the wipe walks it backwards.
 *
 *   scope: how rows of this table belong to the artist.
 *          'artist' = has its own artist_id column
 *          otherwise a SQL fragment selecting by a parent that does.
 */
const TABLES = [
  { name: 'songs',             scope: 'artist', order: 'id' },
  { name: 'venues',            scope: 'artist', order: 'id' },
  { name: 'organizers',        scope: 'artist', order: 'id' },
  { name: 'gigs',              scope: 'artist', order: 'id' },
  { name: 'setlists',          scope: 'artist', order: 'id' },
  // setlist_songs is keyed (setlist_id, position) and has no id column at all.
  { name: 'setlist_songs',     scope: 'setlist_id IN (SELECT id FROM setlists WHERE artist_id = $1)',
                               order: 'setlist_id, position', serialId: false },
  { name: 'song_logs',         scope: 'artist', order: 'id' },
  { name: 'gema_works',        scope: 'artist', order: 'id' },
  { name: 'gema_rightholders', scope: 'gema_work_id IN (SELECT id FROM gema_works WHERE artist_id = $1)', order: 'id' },
  { name: 'song_arrangements', scope: 'artist', order: 'id' },
];

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`  ${question}`, a => { rl.close(); resolve(a.trim()); }));
}

// A table may not exist in every deployment (song_arrangements arrived later).
async function tableExists(sql, name) {
  const [row] = await sql`
    SELECT 1 AS ok FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${name}`;
  return !!row;
}

async function selectRows(sql, table, artistId) {
  const where = table.scope === 'artist'
    ? `artist_id = ${artistId}`
    : table.scope.replace('$1', String(artistId));
  return sql.unsafe(`SELECT * FROM ${table.name} WHERE ${where} ORDER BY ${table.order}`);
}

async function deleteRows(sql, table, artistId) {
  const where = table.scope === 'artist'
    ? `artist_id = ${artistId}`
    : table.scope.replace('$1', String(artistId));
  const rows = await sql.unsafe(`DELETE FROM ${table.name} WHERE ${where} RETURNING 1 AS n`);
  return rows.length;
}

// ── Export ─────────────────────────────────────────────────────────────────

async function runExport(sql, artist) {
  const seed = { artist: artist.slug, exportedAt: new Date().toISOString(), tables: {} };
  for (const table of TABLES) {
    if (!await tableExists(sql, table.name)) { warn(`${table.name} does not exist here — skipped`); continue; }
    const rows = await selectRows(sql, table, artist.id);
    seed.tables[table.name] = rows.map(r => ({ ...r }));
    console.log(`  ${D(table.name.padEnd(18))} ${rows.length}`);
  }
  if (dryRun) { warn('dry run — snapshot not written'); return; }
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 1));
  ok(`Snapshot written to ${path.relative(process.cwd(), SEED_FILE)}`);
}

// ── Restore ────────────────────────────────────────────────────────────────

async function runRestore(sql, artist) {
  if (!fs.existsSync(SEED_FILE)) {
    err(`No snapshot at ${path.relative(process.cwd(), SEED_FILE)} — run with --export first.`);
    process.exit(1);
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  if (seed.artist !== artist.slug) {
    err(`Snapshot is for "${seed.artist}" but this run targets "${artist.slug}".`);
    process.exit(1);
  }
  console.log(`  ${D('snapshot:')} ${seed.exportedAt}`);

  await sql.begin(async tx => {
    let removed = 0;
    for (const table of [...TABLES].reverse()) {
      if (!await tableExists(tx, table.name)) continue;
      removed += await deleteRows(tx, table, artist.id);
    }
    let added = 0;
    for (const table of TABLES) {
      const rows = seed.tables[table.name];
      if (!rows || !rows.length) continue;
      if (!await tableExists(tx, table.name)) { warn(`${table.name} missing here — ${rows.length} rows skipped`); continue; }
      for (const row of rows) await tx`INSERT INTO ${tx(table.name)} ${tx(row)}`;
      added += rows.length;
      console.log(`  ${D(table.name.padEnd(18))} ${rows.length} restored`);
      // Keep the sequence ahead of the ids we just forced in, or the next
      // insert from the app collides with a restored row. Tables without a
      // serial id (setlist_songs) have no sequence to move.
      if (table.serialId !== false) {
        await tx.unsafe(`SELECT setval(pg_get_serial_sequence('${table.name}', 'id'),
                         GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${table.name}), 1))`);
      }
    }
    console.log(`  ${D('removed:')} ${removed}   ${D('restored:')} ${added}`);
    if (dryRun) { warn('dry run — rolling back'); throw new Error('__rollback__'); }
  }).catch(e => { if (e.message !== '__rollback__') throw e; });

  if (!dryRun) ok(`Demo band "${artist.slug}" reset to the snapshot.`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let host;
  try { host = new URL(process.env.DATABASE_URL).hostname; } catch { host = '(unknown)'; }
  // Actions logs of a public repository are public: name the database there
  // only by its first label, enough to tell dev from prod.
  if (process.env.CI) host = host.split('.')[0].replace(/^(.{4}).*(.{2})$/, '$1…$2');
  console.log(`\n  ${D('database:')} ${B(host)}`);

  const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });
  try {
    const [artist] = await sql`SELECT id, slug, name FROM artists WHERE slug = ${slug}`;
    if (!artist) { err(`Artist "${slug}" not found.`); process.exit(1); }
    console.log(`  ${D('band:')} ${B(artist.name)} ${D(`(${artist.slug}, id ${artist.id})`)}`);
    console.log(`  ${D('mode:')} ${doExport ? 'export' : 'restore'}${dryRun ? ' (dry run)' : ''}\n`);

    if (!doExport && !dryRun && !assumeYes) {
      const answer = await ask(`Replace this band's content with the snapshot? (y/n): `);
      if (answer.toLowerCase() !== 'y') { console.log(D('  Aborted.')); process.exit(0); }
    }

    if (doExport) await runExport(sql, artist);
    else          await runRestore(sql, artist);
  } finally {
    await sql.end();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
