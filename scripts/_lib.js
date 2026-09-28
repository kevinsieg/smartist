'use strict';

// Shared by the scripts: environment files, the "which database?" prompt and
// the database connection (postgres.js, the same driver as the API).

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const postgres = require('postgres');

const ROOT = path.join(__dirname, '..');

// KEY=value lines from .env.local, then .env; an existing variable wins.
// Quotes are stripped (`vercel env pull` wraps values in double quotes).
function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
        if (!m || process.env[m[1]] !== undefined) return;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      });
    } catch {}
  }
}

function dbHost(url) {
  try { return new URL(url).hostname; } catch { return '(unknown)'; }
}

// Shows the database host and asks before anything happens. `yes` skips the
// question (unattended runs).
async function confirmDb(url, { question = 'Continue? (y/n): ', yes = false } = {}) {
  console.log(`\n  database: ${dbHost(url)}`);
  if (yes) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question(`  ${question}`, resolve));
  rl.close();
  if (!/^y/i.test(answer.trim())) { console.log('  Aborted.'); process.exit(0); }
}

// SSL for everything but a local database (CI runs Postgres on localhost).
function connect(url) {
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  return postgres(url, { max: 1, prepare: false, ssl: local ? false : 'require', onnotice: () => {} });
}

module.exports = { ROOT, loadEnv, dbHost, confirmDb, connect };
