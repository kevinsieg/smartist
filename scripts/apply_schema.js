#!/usr/bin/env node
// Apply scripts/schema.sql to a database — idempotent, safe to re-run.
// Unlike setup.js (which skips the schema step once the artists table exists),
// this always executes every statement, so new tables/columns/indexes added to
// schema.sql reach existing databases.
//
// Usage:
//   node scripts/apply_schema.js                          # dev DB from .env
//   DATABASE_URL=<prod-url> node scripts/apply_schema.js  # production
//
// Shows the DB hostname and asks for confirmation before connecting.

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { neon } = require('@neondatabase/serverless');

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
loadEnv(path.join(__dirname, '..', '.env.local'));
loadEnv(path.join(__dirname, '..', '.env'));

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(R('DATABASE_URL not set (pass it inline for prod: DATABASE_URL=… node scripts/apply_schema.js)'));
    process.exit(1);
  }

  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  console.log(`\n  ${D('database:')} ${B(host)}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question('  Apply schema.sql to this database? (y/n): ', res));
  rl.close();
  if (!/^y/i.test(answer.trim())) { console.log(D('\n  Aborted.\n')); process.exit(0); }

  const sql = neon(url);
  const src = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Strip -- comments (whole-line and inline) before splitting on ';' —
  // a semicolon inside a comment would otherwise truncate the statement.
  // Inline strip only applies when the -- is outside single quotes.
  const stripComment = line => {
    let inQuote = false;
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] === "'") inQuote = !inQuote;
      else if (!inQuote && line[i] === '-' && line[i + 1] === '-') return line.slice(0, i);
    }
    return line;
  };
  const statements = src
    .split('\n')
    .map(stripComment)
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  let applied = 0, skipped = 0;
  for (const stmt of statements) {
    try {
      await sql([stmt]); // neon HTTP: tagged template with raw string, no params
      applied++;
    } catch (e) {
      if (e.message.toLowerCase().includes('already exists')) { skipped++; continue; }
      console.error(`\n  ${R('failed:')} ${e.message}\n  ${D(stmt.slice(0, 120))}\n`);
      process.exit(1);
    }
  }
  console.log(`\n  ${G('✓')} ${applied} statements applied, ${skipped} already existed\n`);
}

main();
