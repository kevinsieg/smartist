#!/usr/bin/env node
// Apply scripts/schema.sql to a database — idempotent, safe to re-run.
// Unlike setup.js (which skips the schema step once the artists table exists),
// this always executes every statement, so new tables/columns/indexes added to
// schema.sql reach existing databases.
//
// Usage:
//   node scripts/apply_schema.js                          # dev DB from .env
//   DATABASE_URL=<prod-url> node scripts/apply_schema.js  # production
//   node scripts/apply_schema.js --check                  # list missing migrations, change nothing
//   node scripts/apply_schema.js --yes                    # no prompt (CI, throwaway databases)
//
// Shows the DB hostname and asks for confirmation before changing anything.

const fs   = require('fs');
const path = require('path');
const lib  = require('./_lib');

// A runner for raw statements over the shared connection.
function connect(url) {
  const pg = lib.connect(url);
  const run = strings => pg.unsafe(strings.join(''));
  run.end = () => pg.end();
  return run;
}

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

// Strip -- comments (whole-line and inline) before splitting on ';' —
// a semicolon inside a comment would otherwise truncate the statement.
// Inline strip only applies when the -- is outside single quotes.
// The split is naive on purpose: schema.sql holds no DO $$ blocks or functions.
function splitStatements(src) {
  const stripComment = line => {
    let inQuote = false;
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] === "'") inQuote = !inQuote;
      else if (!inQuote && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i);
    }
    return line;
  };
  return src
    .split('\n')
    .map(stripComment)
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

// Migration ids recorded by schema.sql, in file order (statements only — the
// example in the header comment does not count).
function migrationIds(src) {
  const re = /INSERT INTO schema_migrations \(id\) VALUES \('([^']+)'\)/g;
  return [...splitStatements(src).join(';\n').matchAll(re)].map(m => m[1]);
}

async function check(sql, src) {
  const ids = migrationIds(src);
  let have = [];
  try { have = (await sql(['SELECT id FROM schema_migrations'])).map(r => r.id); }
  catch (e) { if (!/does not exist/i.test(e.message)) throw e; }
  const pending = ids.filter(id => !have.includes(id));
  if (!pending.length) { console.log(`\n  ${G('✓')} up to date (${ids[ids.length - 1]})\n`); return 0; }
  console.log(`\n  ${R('pending:')} ${pending.join(', ')}\n  ${D('run without --check to apply')}\n`);
  return 1;
}

async function main() {
  lib.loadEnv();
  const args = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(R('DATABASE_URL not set (pass it inline for prod: DATABASE_URL=… node scripts/apply_schema.js)'));
    process.exit(1);
  }

  const src = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  // --check only reads: no confirmation, exit code 1 when a migration is missing.
  if (args.includes('--check')) {
    console.log(`\n  ${D('database:')} ${B(lib.dbHost(url))}`);
    const sql = connect(url);
    const code = await check(sql, src);
    await sql.end();
    process.exit(code);
  }

  // --yes skips the prompt (CI against a throwaway database).
  await lib.confirmDb(url, { question: 'Apply schema.sql to this database? (y/n): ', yes: args.includes('--yes') });

  const sql = connect(url);
  try {
    const { applied, skipped } = await applyStatements(sql, src);
    console.log(`\n  ${G('✓')} ${applied} statements applied, ${skipped} already existed\n`);
  } catch (e) {
    console.error(`\n  ${R('failed:')} ${e.message}\n  ${D(e.statement.slice(0, 120))}\n`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

// Runs every statement of schema.sql; "already exists" is not an error. Also
// used by setup.js. `sql` is a raw runner from connect() above.
async function applyStatements(sql, src) {
  let applied = 0, skipped = 0;
  for (const stmt of splitStatements(src)) {
    try {
      await sql([stmt]);
      applied++;
    } catch (e) {
      if (e.message.toLowerCase().includes('already exists')) { skipped++; continue; }
      e.statement = stmt;
      throw e;
    }
  }
  return { applied, skipped };
}

if (require.main === module) main();

module.exports = { splitStatements, migrationIds, applyStatements, connect };
