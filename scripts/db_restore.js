#!/usr/bin/env node
// Restore a dump written by db_backup.js into an EMPTY database, then check
// it against the dump's manifest (tables, row counts, sequences, schema
// version). Refuses a database that already has tables: a restore never
// overwrites or mixes with live data. Used for the restore drill (into a
// local database) and for disaster recovery (into a new Neon project); see
// docs/backup-restore.md.
//
// Usage:
//   DATABASE_URL=<empty db> node scripts/db_restore.js --dump <file.dump>
//   DATABASE_URL=<empty db> node scripts/db_restore.js --dump <file.dump.age> --identity <age key file>
//   … --manifest <file>   # default: the .manifest.json next to the dump
//   … --yes               # no prompt
//
// Needs pg_restore of the dump's pg_dump version or newer (PG_BIN=<dir>) and,
// for an encrypted dump, age.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const lib  = require('./_lib');
const bk   = require('./_backup');

lib.loadEnv();

const args = process.argv.slice(2);
const opt  = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const YES      = args.includes('--yes');
const DUMP     = opt('--dump');
const IDENTITY = opt('--identity');

// Throws, so every finally (scratch files, connections) runs before the exit.
function fail(msg) { throw new Error(msg); }

async function main() {
  if (!DUMP) fail('--dump <file> is required.');
  if (!fs.existsSync(DUMP)) fail(`${DUMP}: no such file.`);
  const encrypted = DUMP.endsWith('.age');
  if (encrypted && !IDENTITY) fail('the dump is encrypted: pass --identity <age key file>.');

  const manifestFile = opt('--manifest') || bk.manifestPathFor(DUMP);
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  if (!manifest) console.log(`  ! no manifest (${path.basename(manifestFile)}): the restore cannot be checked, only applied.`);

  if (manifest?.sha256) {
    if ((await bk.sha256File(DUMP)) !== manifest.sha256) fail('the dump does not match its manifest checksum: corrupt or not the same file.');
    console.log('  ✓ checksum matches the manifest');
  }

  const target = process.env.DATABASE_URL;
  if (!target) fail('DATABASE_URL (the empty database to restore into) is not set.');
  const url = bk.directUrl(target);
  await lib.confirmDb(url, { question: `Restore ${path.basename(DUMP)} into this database? (y/n): `, yes: YES });

  const db = lib.connect(url);
  let plain = DUMP, tmp = null;
  try {
    if (!(await bk.isEmptyDatabase(db))) fail('this database already has tables. Restore into a new, empty one.');

    if (encrypted) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smartist-restore-'));
      plain = path.join(tmp, 'dump');
      await bk.run(bk.tool('age'), ['--decrypt', '--identity', IDENTITY, '--output', plain, DUMP]);
    }

    console.log('  restoring …');
    await bk.pgRestore(plain, url);
    const restored = await bk.snapshot(db);
    console.log(`  ✓ restored: ${Object.keys(restored.counts).length} tables, schema ${restored.schemaVersion || 'unknown'}`);

    if (manifest) {
      const problems = bk.compareRestore(manifest, restored);
      if (problems.length) fail(`the restore does not match the manifest:\n    ${problems.join('\n    ')}`);
      console.log(`  ✓ matches the manifest of ${manifest.createdAt}`);
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    await db.end();
  }
}

main().catch(e => { console.error(`  ✗ ${e.message}`); process.exit(1); });
