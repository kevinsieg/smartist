'use strict';

// Shared by db_backup.js and db_restore.js: running the Postgres client tools,
// the manifest written next to every dump, and the checks that tell a good
// restore from a bad one. The procedures are in docs/backup-restore.md.

const crypto            = require('crypto');
const fs                = require('fs');
const path              = require('path');
const { spawn }         = require('child_process');

// pg_dump / pg_restore / age from PG_BIN (or AGE_BIN), else from PATH.
function tool(name) {
  if (name === 'age') return process.env.AGE_BIN || 'age';
  return process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name;
}

// Runs a command, resolves with its stdout. Rejects with the tail of stderr —
// never with the command line, which may carry a file path worth hiding in a
// public log, and never with the environment, which carries the password.
function run(cmd, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => reject(new Error(`${path.basename(cmd)}: ${e.code === 'ENOENT' ? 'not found (install it or set PG_BIN / AGE_BIN)' : e.message}`)));
    child.on('close', code => {
      if (code === 0) return resolve(out);
      const tail = err.trim().split('\n').slice(-8).join('\n');
      reject(new Error(`${path.basename(cmd)} exited with ${code}${tail ? `:\n${tail}` : ''}`));
    });
  });
}

// "pg_dump (PostgreSQL) 17.6 (Ubuntu …)" → 17
function majorOf(versionText) {
  const m = String(versionText).match(/(\d+)(?:\.\d+)?/);
  return m ? Number(m[1]) : null;
}

function isLocalUrl(url) {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}

// Neon's pooled endpoint (PgBouncer, transaction mode) is the wrong door for
// pg_dump and pg_restore; the direct endpoint is the same host without
// "-pooler". Any other URL is returned unchanged.
function directUrl(url) {
  try {
    const u = new URL(url);
    if (!/-pooler\./.test(u.hostname)) return url;
    u.hostname = u.hostname.replace('-pooler.', '.');
    return u.toString();
  } catch { return url; }
}

// libpq environment for a connection URL, so the password never appears on a
// command line (visible in the process list). SSL is required except on
// localhost, matching scripts/_lib.js connect().
function libpqEnv(url) {
  const u = new URL(url);
  const env = {
    PGHOST:     u.hostname.replace(/^\[|\]$/g, ''),
    PGPORT:     u.port || '5432',
    PGUSER:     decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    PGSSLMODE:  u.searchParams.get('sslmode') || (isLocalUrl(url) ? 'disable' : 'require'),
  };
  const cb = u.searchParams.get('channel_binding');
  if (cb) env.PGCHANNELBINDING = cb;
  if (!env.PGPASSWORD) delete env.PGPASSWORD;
  return env;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// 2026-09-30T19:48:00.123Z → 20260930T194800Z (sorts, and is safe in a key).
function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// What a restore is checked against: tables and their row counts, sequence
// positions, and the schema version. One round-trip each for tables and
// sequences.
async function snapshot(sql) {
  const tables = (await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`).map(r => r.table_name);
  const counts = {};
  if (tables.length) {
    const q = tables.map(t => `SELECT ${quoteLiteral(t)} AS t, count(*)::bigint AS n FROM public.${quoteIdent(t)}`).join(' UNION ALL ');
    for (const r of await sql.unsafe(q)) counts[r.t] = Number(r.n);
  }
  const sequences = {};
  for (const r of await sql`SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public'`) {
    sequences[r.sequencename] = r.last_value == null ? null : Number(r.last_value);
  }
  const schemaVersion = tables.includes('schema_migrations')
    ? (await sql`SELECT max(id) AS v FROM schema_migrations`)[0].v
    : null;
  return { counts, sequences, schemaVersion };
}

function quoteIdent(s)   { return `"${String(s).replace(/"/g, '""')}"`; }
function quoteLiteral(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// pg_dump reads every table in one snapshot taken somewhere between the counts
// before and after it, so a restored count must lie between those two. On a
// quiet database they are equal and the check is exact.
function tableRanges(before, after) {
  const out = {};
  for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[t], b = after[t];
    if (a == null || b == null) continue;           // created or dropped mid-dump: not comparable
    out[t] = [Math.min(a, b), Math.max(a, b)];
  }
  return out;
}

// Everything wrong with a restored database, as readable lines; empty means
// the restore matches the manifest.
function compareRestore(manifest, restored) {
  const problems = [];
  for (const [t, [lo, hi]] of Object.entries(manifest.tables || {})) {
    const n = restored.counts[t];
    if (n == null) problems.push(`table ${t} is missing`);
    else if (n < lo || n > hi) problems.push(`table ${t}: ${n} rows, expected ${lo === hi ? lo : `${lo}–${hi}`}`);
  }
  for (const t of Object.keys(restored.counts)) {
    if (!(t in (manifest.tables || {}))) problems.push(`table ${t} is not in the manifest`);
  }
  // A sequence restored behind where it stood would hand out ids that exist.
  for (const [s, v] of Object.entries(manifest.sequences || {})) {
    if (v == null) continue;
    const r = restored.sequences[s];
    if (r == null) problems.push(`sequence ${s} is missing`);
    else if (r < v) problems.push(`sequence ${s} restored at ${r}, was at least ${v}`);
  }
  if ((manifest.schemaVersion || null) !== (restored.schemaVersion || null)) {
    problems.push(`schema version ${restored.schemaVersion}, expected ${manifest.schemaVersion}`);
  }
  return problems;
}

// Tables in any user schema: a restore goes only into an empty database, so
// it can never mix with or overwrite live data.
async function isEmptyDatabase(sql) {
  const [r] = await sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`;
  return r.n === 0;
}

// No owners or grants: the target's roles differ from the source's (Neon
// roles do not exist locally, a new Neon project has its own). One
// transaction, stop at the first error: a restore is all or nothing.
async function pgRestore(file, url) {
  await run(tool('pg_restore'), ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', libpqEnv(url).PGDATABASE, file], { env: libpqEnv(url) });
}

// Manifest next to the dump: <dump without .age/.dump>.manifest.json
function manifestPathFor(dumpFile) {
  return dumpFile.replace(/\.age$/, '').replace(/\.dump$/, '') + '.manifest.json';
}

module.exports = {
  tool, run, majorOf, isLocalUrl, directUrl, libpqEnv, sha256File, stamp,
  snapshot, tableRanges, compareRestore, isEmptyDatabase, pgRestore, manifestPathFor,
};
