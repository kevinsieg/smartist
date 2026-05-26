#!/usr/bin/env node
/**
 * Safe schema migrator
 *
 * Applies `scripts/schema.sql` to the target DATABASE_URL.
 *
 * Design goals:
 * - Idempotent: safe to run multiple times
 * - Non-destructive: schema.sql should only CREATE/ALTER (no DROP/TRUNCATE)
 * - Explicit confirmation: prints hostname + requires "y"
 *
 * Usage:
 *   DATABASE_URL=... node scripts/migrate-schema.js
 *   node scripts/migrate-schema.js            # reads .env.local if present
 */
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

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
loadEnv(path.join(__dirname, '.env.local'));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = prompt =>
  new Promise(resolve => rl.question(prompt, answer => resolve(answer.trim())));

async function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  console.log(`\nTarget database host: ${host}`);
  const answer = await ask('Apply schema.sql to this database? (y/n): ');
  if (!/^y/i.test(answer)) {
    console.log('Aborted.');
    process.exit(0);
  }
}

function stripSqlComments(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function assertNonDestructive(schemaSql) {
  // Guard rail: schema.sql should only CREATE/ALTER — not DROP/TRUNCATE user data.
  const s = stripSqlComments(schemaSql).toLowerCase();
  if (/\bdrop\s+(table|column|index|constraint|database|schema|type|view)\b/.test(s)
    || /\btruncate\s+table\b/.test(s)) {
    throw new Error('Refusing to run schema.sql because it contains DROP or TRUNCATE.');
  }
}

function requirePsql() {
  const r = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  if (r.error) throw new Error('psql not found. Install PostgreSQL client tools (psql) first.');
}

function applySchemaWithPsql(databaseUrl) {
  requirePsql();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const r = spawnSync(
    'psql',
    [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', schemaPath],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) {
    throw new Error(`psql exited with code ${r.status}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('\nDATABASE_URL is not set (add it to .env.local or export it).\n');
    process.exit(1);
  }

  await confirmDb(process.env.DATABASE_URL);

  const src = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  assertNonDestructive(src);

  console.log('\nApplying scripts/schema.sql via psql...');
  applySchemaWithPsql(process.env.DATABASE_URL);
  console.log('\nDone.');
}

main()
  .catch(e => {
    console.error(`\nError: ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());

