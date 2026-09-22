#!/usr/bin/env node
/**
 * Smartist — Create the first user account for an existing band
 *
 * Usage:
 *   node scripts/create_user.js --artist <slug> --email <address> [--role admin|member|viewer] [--yes]
 *   USER_PASSWORD=… node scripts/create_user.js --artist <slug> --email <address> --yes   # unattended
 *   DATABASE_URL=<url> node scripts/create_user.js --artist bandtwo --email me@example.com
 *
 * Why this exists: signup (api/_domain/registration.js) creates a *new* band,
 * and invite (api/[artist]/auth.js) needs an already-authenticated admin. A band
 * created before multi-user auth — or by scripts/setup.js — has no `users` rows
 * at all and logs in through the legacy band password, which issues no user
 * token. Such a workspace can never reach /admin, and nobody can be invited into
 * it. This script writes that first row so the normal flows take over.
 *
 * The password is read from the terminal without echoing and stored as a bcrypt
 * hash, the same way the invite-acceptance path does it.
 */

'use strict';

const postgres = require('postgres');
const bcrypt   = require('bcryptjs');
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

// ── Print helpers ──────────────────────────────────────────────────────────

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

const ok   = msg => console.log(`  ${G('✓')} ${msg}`);
const warn = msg => console.log(`  ${Y('!')} ${msg}`);
const err  = msg => console.log(`  ${R('✗')} ${msg}`);

// ── Args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg  = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };

const slug  = arg('artist');
const email = (arg('email') || '').trim().toLowerCase();
const role  = arg('role') || 'admin';
const assumeYes = args.includes('--yes');

if (!slug || !email) {
  err('Usage: node scripts/create_user.js --artist <slug> --email <address> [--role admin|member|viewer] [--yes]');
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  err(`"${email}" is not a valid email address.`);
  process.exit(1);
}
if (!['admin', 'member', 'viewer'].includes(role)) {
  err(`Role must be admin, member or viewer — got "${role}".`);
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  err('DATABASE_URL is not set. Add it to .env or pass it inline.');
  process.exit(1);
}

// ── Prompts ────────────────────────────────────────────────────────────────

// One interface for the whole run, as in setup.js: closing and reopening around
// each prompt ends a piped stdin, and every prompt after the first hangs.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(`  ${question}`, a => resolve(a.trim())));
}

// Reads a line without echoing it, so the password never lands in the terminal
// scrollback or in shell history.
function askSecret(question) {
  return new Promise(resolve => {
    let muted = false;
    const restore = rl._writeToOutput;
    // Muting has to start *after* rl.question() has drawn the prompt, or the
    // prompt itself is swallowed and the caller types into an invisible line.
    rl._writeToOutput = function (s) {
      if (!muted) return restore.call(rl, s);
      if (s.includes('\n')) restore.call(rl, '\n');   // keep Enter moving the cursor
    };
    rl.question(`  ${question}`, a => { rl._writeToOutput = restore; resolve(a.trim()); });
    muted = true;
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let host;
  try { host = new URL(DATABASE_URL).hostname; } catch { host = '(unknown)'; }
  console.log(`\n  ${D('database:')} ${B(host)}`);

  const sql = postgres(DATABASE_URL, { ssl: 'require', max: 1 });
  try {
    const [artist] = await sql`SELECT id, slug, name FROM artists WHERE slug = ${slug}`;
    if (!artist) { err(`Artist "${slug}" not found in this database.`); process.exit(1); }
    console.log(`  ${D('band:')} ${B(artist.name)} ${D(`(${artist.slug})`)}`);

    const existing = await sql`SELECT email, role FROM users WHERE artist_id = ${artist.id} ORDER BY id`;
    if (existing.length) {
      console.log(`  ${D('existing users:')} ${existing.map(u => `${u.email} (${u.role})`).join(', ')}`);
      const clash = existing.find(u => u.email.toLowerCase() === email);
      if (clash) { err(`${email} is already a user of this band.`); process.exit(1); }
      warn('This band already has users — the invite flow in the app is the normal way to add more.');
    } else {
      console.log(`  ${D('existing users:')} none — this will be the first, replacing the band-password login`);
    }

    if (!assumeYes && (await ask(`Create ${B(email)} as ${B(role)}? (y/n): `)).toLowerCase() !== 'y') {
      console.log(D('  Aborted.')); process.exit(0);
    }

    // USER_PASSWORD lets this run unattended without putting the password in
    // shell history the way a --password flag would.
    let password = process.env.USER_PASSWORD;
    if (password) {
      console.log(D('  password: taken from USER_PASSWORD'));
    } else {
      password = await askSecret('Password (min 8 characters): ');
      if ((await askSecret('Repeat password: ')) !== password) { err('Passwords do not match.'); process.exit(1); }
    }
    if (password.length < 8) { err('Password must be at least 8 characters.'); process.exit(1); }

    const hash = await bcrypt.hash(password, 10);
    const [user] = await sql`
      INSERT INTO users (artist_id, email, role, password_hash)
      VALUES (${artist.id}, ${email}, ${role}, ${hash})
      RETURNING id, email, role
    `;

    ok(`Created user ${user.email} (${user.role}, id ${user.id}) for ${artist.slug}.`);
    console.log(D('\n  Log in with this address and password at the band\'s domain.'));
    if (role === 'admin') {
      console.log(D('  For /admin access, this address must also be in SUPER_ADMIN_EMAILS on that Vercel project.'));
    }
  } finally {
    rl.close();
    await sql.end();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
