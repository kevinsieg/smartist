#!/usr/bin/env node
// Runs in every Vercel deployment as package.json's "postinstall": Vercel's
// build installs dependencies itself and ignores vercel.json "installCommand"
// for an app without a framework or build step (the build log showed only
// "Installing dependencies..."), and a "buildCommand" makes it expect a
// public/ output directory. npm runs "postinstall" on every install, even
// "up to date". Brings this deployment's own database up to
// scripts/schema.sql before the new code goes live. Each
// Vercel project builds with its own DATABASE_URL, so every deployment
// migrates its own database and no production connection string ever leaves
// Vercel.
//
// Nothing pending → nothing runs. A failed migration fails the build, and the
// previous deployment stays live.
//
// The migration lands a minute or two before the new code does. Adding is
// always safe in that window; dropping a column the live code still reads is
// not — stop using it in one release, drop it in a later one (CI's "Live code
// on the new schema" job runs main's API suite on the new schema).
//
// Only runs inside a Vercel build: anywhere else (a local or CI npm install)
// it does nothing. Locally use apply_schema.js, which asks.

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');
const { migrationIds, applyStatements, connect } = require('./apply_schema');

// What this install does about the database, from the build's environment:
// 'skip' outside a Vercel build (a local or CI install, vercel dev) and for a
// preview with no database of its own (a tenant project that only runs
// production), 'fail' for production without one, 'migrate' otherwise.
function decide(env) {
  if (env.VERCEL !== '1' || env.VERCEL_ENV === 'development') return 'skip';
  if (!env.DATABASE_URL) return env.VERCEL_ENV === 'production' ? 'fail' : 'skip';
  return 'migrate';
}

async function migratedIds(sql) {
  try { return (await sql(['SELECT id FROM schema_migrations'])).map(r => r.id); }
  catch (e) { if (/does not exist/i.test(e.message)) return []; throw e; }
}

// Brings the database up to `src`. Nothing pending → no statement runs. Throws
// when a migration is still missing afterwards. `log` hears the pending ids
// before anything runs, so a failed build's log still names them.
async function migrate(sql, src, log = () => {}) {
  const ids = migrationIds(src);
  const have = await migratedIds(sql);
  const pending = ids.filter(id => !have.includes(id));
  if (!pending.length) return { latest: ids[ids.length - 1], pending };
  log(`schema: applying ${pending.join(', ')}`);
  const { applied, skipped } = await applyStatements(sql, src);
  const after = await migratedIds(sql);
  const still = ids.filter(id => !after.includes(id));
  if (still.length) throw new Error(`still pending after apply: ${still.join(', ')}`);
  return { latest: ids[ids.length - 1], pending, applied, skipped };
}

async function main() {
  const action = decide(process.env);
  if (action === 'skip') {
    if (process.env.VERCEL === '1' && process.env.VERCEL_ENV !== 'development')
      console.log(`schema: no DATABASE_URL for ${process.env.VERCEL_ENV || 'this'} environment, nothing to migrate`);
    return;
  }
  if (action === 'fail') {
    console.error('DATABASE_URL is not set for production: the build cannot migrate.');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  const src = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log(`schema: ${process.env.VERCEL_ENV || 'unknown'} database ${lib.dbHost(url)}`);

  const sql = connect(url);
  try {
    const { latest, pending, applied, skipped } = await migrate(sql, src, console.log);
    if (!pending.length) console.log(`schema: up to date (${latest})`);
    else console.log(`schema: done (${applied} statements run, ${skipped} already existed)`);
  } catch (e) {
    console.error(`schema: FAILED — ${e.message}`);
    if (e.statement) console.error(`  in: ${e.statement.slice(0, 200)}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (require.main === module) main();

module.exports = { decide, migrate };
