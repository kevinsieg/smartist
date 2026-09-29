#!/usr/bin/env node
// Runs in every Vercel deployment, after npm install (vercel.json
// "installCommand" — not "buildCommand": with a build command Vercel expects a
// public/ output directory, and this app serves from the root). Brings this
// deployment's own database up to scripts/schema.sql before the new code goes
// live. Each
// Vercel project builds with its own DATABASE_URL, so every deployment
// migrates its own database and no production connection string ever leaves
// Vercel.
//
// Nothing pending → nothing runs. A failed migration fails the build, and the
// previous deployment stays live.
//
// The migration lands a minute or two before the new code does. Adding is
// always safe in that window; dropping a column the live code still reads is
// not — stop using it in one release, drop it in a later one
// (tests/unit/schema_drops.js).
//
// Only runs inside a Vercel build: locally use apply_schema.js, which asks.

const fs = require('fs');
const path = require('path');
const lib = require('./_lib');
const { migrationIds, applyStatements, connect } = require('./apply_schema');

async function main() {
  if (process.env.VERCEL !== '1') {
    console.error('deploy_migrate.js runs in Vercel builds only; use scripts/apply_schema.js');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set for this Vercel environment: the build cannot migrate.');
    process.exit(1);
  }

  const src = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const ids = migrationIds(src);
  console.log(`schema: ${process.env.VERCEL_ENV || 'unknown'} database ${lib.dbHost(url)}`);

  const sql = connect(url);
  try {
    let have = [];
    try { have = (await sql(['SELECT id FROM schema_migrations'])).map(r => r.id); }
    catch (e) { if (!/does not exist/i.test(e.message)) throw e; }
    const pending = ids.filter(id => !have.includes(id));
    if (!pending.length) { console.log(`schema: up to date (${ids[ids.length - 1]})`); return; }

    console.log(`schema: applying ${pending.join(', ')}`);
    const { applied, skipped } = await applyStatements(sql, src);
    const after = (await sql(['SELECT id FROM schema_migrations'])).map(r => r.id);
    const still = ids.filter(id => !after.includes(id));
    if (still.length) throw new Error(`still pending after apply: ${still.join(', ')}`);
    console.log(`schema: done (${applied} statements run, ${skipped} already existed)`);
  } catch (e) {
    console.error(`schema: FAILED — ${e.message}`);
    if (e.statement) console.error(`  in: ${e.statement.slice(0, 200)}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
