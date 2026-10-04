#!/usr/bin/env node
// An upgraded database must end up with the schema a fresh one gets.
//
// Production databases are never empty: a deploy runs schema.sql over the
// schema they already have, where every CREATE TABLE IF NOT EXISTS is a no-op
// and only the dated blocks change anything. The other suites run on a fresh
// database, where the CREATE TABLEs do everything. A column added inside a
// CREATE TABLE instead of a dated ALTER block would reach every test database
// and no production one, with every test green and the health check saying
// "current" (it compares migration ids only).
//
// So: one database gets the base branch's schema.sql, a few rows, then this
// branch's schema.sql; another gets this branch's schema.sql alone. Their
// columns, constraints and indexes must match. The rows make a migration that
// only works on an empty table (a NOT NULL column without a default, a new
// UNIQUE index) fail here too.
//
//   node tests/schema-upgrade.js            # base: origin/main
//   BASE_REF=origin/dev node tests/schema-upgrade.js
//
// Creates and drops two scratch databases next to DATABASE_URL's, so it runs on
// a local server only (the local stack, CI's service container).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const postgres = require('postgres');
const { applyStatements, connect } = require('../scripts/apply_schema');

const ROOT = path.join(__dirname, '..');
const URL_ = process.env.DATABASE_URL;
const BASE_REF = process.env.BASE_REF || 'origin/main';
const DBS = { upgraded: 'schema_check_upgraded', fresh: 'schema_check_fresh' };

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

function urlFor(db) {
  const u = new URL(URL_);
  u.pathname = '/' + db;
  return u.toString();
}

// Everything that makes up the schema, as comparable lines. A constraint added
// NOT VALID (the only way to add one to a table with rows without a full scan)
// is the same constraint as one declared in CREATE TABLE.
async function snapshot(db) {
  const sql = connect(urlFor(db));
  try {
    const [columns, constraints, indexes, migrations] = await Promise.all([
      sql([`
        SELECT table_name || '.' || column_name || ' ' || data_type
               || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
               || COALESCE(' DEFAULT ' || column_default, '') AS line
        FROM information_schema.columns WHERE table_schema = 'public'`]),
      sql([`
        SELECT conrelid::regclass::text || ' ' || conname || ' ' ||
               regexp_replace(pg_get_constraintdef(oid), ' NOT VALID$', '') AS line
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND conrelid <> 0`]),
      sql([`SELECT indexdef AS line FROM pg_indexes WHERE schemaname = 'public'`]),
      sql([`SELECT 'migration ' || id AS line FROM schema_migrations`]),
    ]);
    return [...columns, ...constraints, ...indexes, ...migrations].map(r => r.line).sort();
  } finally {
    await sql.end();
  }
}

// A few rows in the tables a migration is most likely to touch.
async function seed(db) {
  const sql = connect(urlFor(db));
  try {
    await sql([`
      WITH a AS (INSERT INTO artists (slug, name) VALUES ('upgrade-check', 'Upgrade Check') RETURNING id),
      u AS (INSERT INTO users (artist_id, email, role) SELECT id, 'upgrade@example.test', 'admin' FROM a),
      s AS (INSERT INTO songs (artist_id, title) SELECT id, t FROM a, (VALUES ('One'), ('Two')) v(t) RETURNING id, artist_id),
      v AS (INSERT INTO venues (artist_id, name) SELECT id, 'Hall' FROM a RETURNING id, artist_id),
      g AS (INSERT INTO gigs (artist_id, title, date, venue_id) SELECT artist_id, 'Gig', '2099-01-01', id FROM v RETURNING id, artist_id),
      l AS (INSERT INTO setlists (artist_id, title, gig_id) SELECT artist_id, 'Set', id FROM g RETURNING id)
      INSERT INTO setlist_songs (setlist_id, song_id, position)
      SELECT l.id, s.id, row_number() OVER () FROM l, s`]);
  } finally {
    await sql.end();
  }
}

async function apply(db, src) {
  const sql = connect(urlFor(db));
  try { await applyStatements(sql, src); }
  catch (e) { throw new Error(`${db}: ${e.message}\n  ${(e.statement || '').slice(0, 160)}`); }
  finally { await sql.end(); }
}

async function main() {
  if (!URL_) { console.error(R('DATABASE_URL not set')); process.exit(1); }
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_)) {
    console.error(R('Refusing: this creates and drops databases, so it runs against a local server only.'));
    process.exit(1);
  }
  let base;
  try {
    base = execFileSync('git', ['show', `${BASE_REF}:scripts/schema.sql`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    console.error(R(`Cannot read scripts/schema.sql at ${BASE_REF} (git fetch origin ${BASE_REF.replace(/^origin\//, '')}).`));
    process.exit(1);
  }
  const head = fs.readFileSync(path.join(ROOT, 'scripts/schema.sql'), 'utf8');

  console.log(`schema upgrade check ${D(`(${BASE_REF} + rows → this branch, vs this branch fresh)`)}`);
  const admin = postgres(URL_, { max: 1, onnotice: () => {} });
  const reset = async () => {
    for (const db of Object.values(DBS)) await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
  };
  let failed = false;
  try {
    await reset();
    for (const db of Object.values(DBS)) await admin.unsafe(`CREATE DATABASE ${db}`);

    await apply(DBS.upgraded, base);
    await seed(DBS.upgraded);
    await apply(DBS.upgraded, head);
    await apply(DBS.fresh, head);

    const [up, fresh] = await Promise.all([snapshot(DBS.upgraded), snapshot(DBS.fresh)]);
    const onlyUp = up.filter(l => !fresh.includes(l));
    const onlyFresh = fresh.filter(l => !up.includes(l));
    if (onlyUp.length || onlyFresh.length) {
      failed = true;
      console.log(R('  ✗ an upgraded database differs from a fresh one'));
      for (const l of onlyFresh) console.log(`    ${R('only fresh:   ')} ${l}`);
      for (const l of onlyUp)    console.log(`    ${R('only upgraded:')} ${l}`);
      console.log(D('  A change inside a CREATE TABLE never reaches an existing database: add a dated block for it.'));
    } else {
      console.log(`  ${G('✓')} same schema ${D(`(${up.length} columns, constraints, indexes and migrations)`)}`);
    }
  } catch (e) {
    failed = true;
    console.log(R(`  ✗ ${e.message}`));
  } finally {
    await reset().catch(() => {});
    await admin.end();
  }
  process.exit(failed ? 1 : 0);
}

main();
