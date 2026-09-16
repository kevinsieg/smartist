#!/usr/bin/env node
/**
 * Smartist — Plans CLI
 *
 * Usage:
 *   node scripts/plans.js                              # list all bands with plan/storage/songs/users
 *   node scripts/plans.js --artist <slug> --plan <free|pro>  # set plan for a band
 *   node scripts/plans.js --recount                    # recompute storage_used_bytes from R2
 *
 * Reads DATABASE_URL and ARTIST_SLUG from .env / .env.local in the project root.
 */

'use strict';

const { neon }              = require('@neondatabase/serverless');
const readline              = require('readline');
const fs                    = require('fs');
const path                  = require('path');
const { storageLimitBytes } = require('../api/_plans');

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

const args     = process.argv.slice(2);
const RECOUNT  = args.includes('--recount');
const artistArg = (() => { const i = args.indexOf('--artist'); return i >= 0 ? args[i + 1] : null; })();
const planArg   = (() => { const i = args.indexOf('--plan');   return i >= 0 ? args[i + 1] : null; })();

// ── DB ─────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  err('DATABASE_URL is not set. Add it to .env or pass it as an environment variable.');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

function confirmDb(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = '(unknown)'; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n  ${D('database:')} ${B(host)}`);
  return new Promise(resolve =>
    rl.question(`  Continue? (y/n): `, answer => {
      rl.close();
      if (!/^y/i.test(answer.trim())) {
        console.log(D('  Aborted.'));
        process.exit(0);
      }
      resolve();
    })
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtStorage(usedBytes, limitBytes) {
  const usedMB = (Number(usedBytes) / (1024 * 1024)).toFixed(1);
  if (limitBytes == null) return `${usedMB} MB / unlimited`;
  const limitMB = (limitBytes / (1024 * 1024)).toFixed(0);
  return `${usedMB} / ${limitMB} MB`;
}

// ── Modes ──────────────────────────────────────────────────────────────────

async function listArtists() {
  const rows = await sql`
    SELECT a.id, a.slug, a.name, COALESCE(a.config->>'plan','free') AS plan, a.storage_used_bytes,
           (SELECT count(*)::int FROM songs s WHERE s.artist_id = a.id AND NOT s.deleted) AS songs,
           (SELECT count(*)::int FROM users u WHERE u.artist_id = a.id) AS users
    FROM artists a ORDER BY a.name`;

  if (!rows.length) { warn('No artists found.'); return; }

  const COL = { slug: 16, name: 22, plan: 6, storage: 22, songs: 6, users: 6 };
  const hdr = [
    'SLUG'.padEnd(COL.slug),
    'NAME'.padEnd(COL.name),
    'PLAN'.padEnd(COL.plan),
    'STORAGE (used / limit)'.padEnd(COL.storage),
    'SONGS'.padStart(COL.songs),
    'USERS'.padStart(COL.users),
  ].join('  ');

  console.log('\n' + B(hdr));
  console.log(D('─'.repeat(hdr.length)));

  for (const r of rows) {
    const fakeArtist = { config: { plan: r.plan } };
    const limitBytes = storageLimitBytes(fakeArtist);
    const storage    = fmtStorage(r.storage_used_bytes ?? 0, limitBytes);
    const line = [
      r.slug.padEnd(COL.slug),
      r.name.slice(0, COL.name).padEnd(COL.name),
      r.plan.padEnd(COL.plan),
      storage.padEnd(COL.storage),
      String(r.songs).padStart(COL.songs),
      String(r.users).padStart(COL.users),
    ].join('  ');
    console.log(line);
  }
  console.log();
}

async function setPlan(slug, plan) {
  const VALID = new Set(['free', 'pro']);
  if (!VALID.has(plan)) {
    err(`Invalid plan "${plan}". Must be: free | pro`);
    process.exit(1);
  }

  // The neon HTTP driver resolves to rows, never a row count, so an UPDATE
  // without RETURNING always looks like "0 rows matched".
  const updated = await sql`UPDATE artists SET config = config || ${{ plan }} WHERE slug = ${slug} RETURNING slug`;
  if (updated.length > 0) {
    ok(`Artist "${slug}" plan set to "${plan}".`);
  } else {
    warn(`No artist found with slug "${slug}".`);
  }
}

// Read a public media file's size via HTTP HEAD (media live on public r2.dev
// URLs). This needs no R2 credentials and no R2_PUBLIC_URL, so recount works
// against any database — including production — with only DATABASE_URL set.
async function headContentLength(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    if (!r.ok) return null;
    const len = r.headers.get('content-length');
    return len == null ? null : Number(len);
  } catch { return null; }
}

async function recount() {
  const artists = await sql`SELECT id, slug, name FROM artists ORDER BY name`;
  if (!artists.length) { warn('No artists found.'); return; }

  // Compute first (no writes), so a guard can refuse to clobber on failure.
  const results = [];
  for (const a of artists) {
    const songs = await sql`SELECT extra FROM songs WHERE artist_id = ${a.id} AND NOT deleted`;
    let total = 0, urls = 0, missing = 0;
    for (const s of songs) {
      for (const k of ['listenUrl', 'sheetUrl', 'playbackUrl']) {
        const url = s.extra && s.extra[k];
        if (!url) continue;
        urls++;
        const len = await headContentLength(url);
        if (len == null) missing++; else total += len;
      }
    }
    results.push({ a, total, urls, missing });
  }

  console.log();
  for (const { a, total, urls, missing } of results) {
    // If a band has media URLs but every one is unreachable, the URLs/network
    // are wrong — do NOT overwrite its stored value with 0.
    if (urls > 0 && missing === urls) {
      err(`${a.slug.padEnd(20)} ${urls} media URL(s) ALL unreachable — NOT written (would clobber to 0).`);
      continue;
    }
    await sql`UPDATE artists SET storage_used_bytes = ${total} WHERE id = ${a.id}`;
    const mb   = (total / (1024 * 1024)).toFixed(2);
    const note = missing ? Y(`  (${missing}/${urls} files unreachable)`) : '';
    ok(`${a.slug.padEnd(20)} ${mb} MB  (${total} bytes)${note}`);
  }
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  await confirmDb(DATABASE_URL);

  if (RECOUNT) {
    console.log(`\n  ${B('Recounting storage from R2...')}\n`);
    await recount();
  } else if (artistArg && planArg) {
    console.log();
    await setPlan(artistArg, planArg);
    console.log();
  } else if (artistArg || planArg) {
    err('Both --artist <slug> and --plan <free|pro> are required together.');
    process.exit(1);
  } else {
    await listArtists();
  }
}

main().catch(e => { err(e.message); process.exit(1); });
