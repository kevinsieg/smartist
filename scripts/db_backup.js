#!/usr/bin/env node
// Logical backup of one database: pg_dump (custom format), optionally proven
// restorable and encrypted, with a manifest to check a restore against.
// Read-only on the database it backs up. Nightly for every production
// database via .github/workflows/backup.yml; by hand before anything risky.
// The whole procedure: docs/backup-restore.md.
//
// Usage:
//   node scripts/db_backup.js                         # DATABASE_URL from .env, into ./backups
//   DATABASE_URL=<url> node scripts/db_backup.js --label <name> --out <dir>
//   node scripts/db_backup.js --verify <empty local db url>   # restore it there and compare
//   node scripts/db_backup.js --recipient age1…               # encrypt (or BACKUP_AGE_RECIPIENT)
//   node scripts/db_backup.js --yes                           # no prompt (unattended)
//
// Writes <label>-<UTC stamp>.dump (or .dump.age) and <label>-<stamp>.manifest.json.
// Needs pg_dump of the server's major version or newer (PG_BIN=<dir> to pick
// one), pg_restore for --verify, and age for --recipient.

'use strict';

const fs   = require('fs');
const path = require('path');
const lib  = require('./_lib');
const bk   = require('./_backup');

lib.loadEnv();

const args = process.argv.slice(2);
const opt  = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const YES       = args.includes('--yes');
const LABEL     = opt('--label') || 'db';
const OUT       = path.resolve(opt('--out') || path.join(lib.ROOT, 'backups'));
const VERIFY    = opt('--verify');
const RECIPIENT = opt('--recipient') || process.env.BACKUP_AGE_RECIPIENT || null;

// Throws, so every finally (scratch files, connections) runs before the exit.
function fail(msg) { throw new Error(msg); }

async function main() {
  const source = process.env.DATABASE_URL;
  if (!source) fail('DATABASE_URL is not set.');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(LABEL)) fail('--label: lowercase letters, digits and dashes only.');
  if (VERIFY && !bk.isLocalUrl(VERIFY)) fail('--verify takes a local database only (localhost): it is a scratch copy.');
  if (RECIPIENT && !/^age1[0-9a-z]+$/.test(RECIPIENT)) fail('--recipient is not an age public key (age1…).');

  await lib.confirmDb(source, { question: 'Back up this database? Nothing is changed on it. (y/n): ', yes: YES });

  // pg_dump through Neon's pooler is unreliable; take the direct endpoint.
  const url = bk.directUrl(source);
  const db  = lib.connect(url);
  let before, after, serverVersion;
  const base = `${LABEL}-${bk.stamp()}`;
  const dumpFile = path.join(OUT, `${base}.dump`);
  try {
    serverVersion = (await db`SHOW server_version`)[0].server_version;
    const dumpMajor = bk.majorOf(await bk.run(bk.tool('pg_dump'), ['--version']));
    if (dumpMajor < bk.majorOf(serverVersion)) {
      fail(`pg_dump ${dumpMajor} cannot dump a Postgres ${bk.majorOf(serverVersion)} server: install a newer client or set PG_BIN.`);
    }
    fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
    before = await bk.snapshot(db);
    console.log(`  dumping (Postgres ${serverVersion}, schema ${before.schemaVersion || 'unknown'}) …`);
    await bk.run(bk.tool('pg_dump'), ['--format=custom', '--compress=9', '--file', dumpFile], { env: bk.libpqEnv(url) });
    after = await bk.snapshot(db);
  } finally {
    await db.end();
  }
  fs.chmodSync(dumpFile, 0o600);

  const manifest = {
    label:         LABEL,
    createdAt:     new Date().toISOString(),
    serverVersion,
    schemaVersion: after.schemaVersion,
    tables:        bk.tableRanges(before.counts, after.counts),
    sequences:     before.sequences,
    rows:          Object.values(after.counts).reduce((a, b) => a + b, 0),
  };

  if (VERIFY) {
    console.log('  restoring into the scratch database …');
    const scratch = lib.connect(VERIFY);
    try {
      if (!(await bk.isEmptyDatabase(scratch))) fail('--verify: the scratch database is not empty.');
      await bk.pgRestore(dumpFile, VERIFY);
      const problems = bk.compareRestore(manifest, await bk.snapshot(scratch));
      if (problems.length) fail(`the restore does not match:\n    ${problems.join('\n    ')}`);
    } finally {
      await scratch.end();
    }
    manifest.verifiedAt = new Date().toISOString();
    console.log(`  ✓ restored and checked: ${Object.keys(manifest.tables).length} tables, ${manifest.rows} rows`);
  }

  let file = dumpFile;
  if (RECIPIENT) {
    file = `${dumpFile}.age`;
    await bk.run(bk.tool('age'), ['--encrypt', '--recipient', RECIPIENT, '--output', file, dumpFile]);
    fs.chmodSync(file, 0o600);
    fs.unlinkSync(dumpFile);
    manifest.encryptedFor = RECIPIENT;
  }
  manifest.file   = path.basename(file);
  manifest.bytes  = fs.statSync(file).size;
  manifest.sha256 = await bk.sha256File(file);

  const manifestFile = bk.manifestPathFor(file);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log(`  ✓ ${path.relative(process.cwd(), file)} (${(manifest.bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  ✓ ${path.relative(process.cwd(), manifestFile)}`);
}

main().catch(e => { console.error(`  ✗ ${e.message}`); process.exit(1); });
