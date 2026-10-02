const path = require('path');
const bk = require(path.join(__dirname, '../../scripts/_backup'));

function run(r) {
  const { test, assertEq, assert, B } = r;

  console.log(B('\nBackups (scripts/_backup.js)'));

  test('directUrl drops -pooler from a Neon host and nothing else', () => {
    assertEq(
      bk.directUrl('postgresql://u:p@ep-x-123-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'),
      'postgresql://u:p@ep-x-123.eu-central-1.aws.neon.tech/db?sslmode=require');
    assertEq(bk.directUrl('postgres://postgres@localhost:5433/db'), 'postgres://postgres@localhost:5433/db');
  });

  test('libpqEnv carries the password in the environment, SSL required unless local', () => {
    const env = bk.libpqEnv('postgresql://owner:p%40ss@db.example.test/app?channel_binding=require');
    assertEq(env.PGHOST, 'db.example.test');
    assertEq(env.PGPORT, '5432');
    assertEq(env.PGUSER, 'owner');
    assertEq(env.PGPASSWORD, 'p@ss');
    assertEq(env.PGDATABASE, 'app');
    assertEq(env.PGSSLMODE, 'require');
    assertEq(env.PGCHANNELBINDING, 'require');
    const local = bk.libpqEnv('postgres://postgres@localhost:5433/scratch');
    assertEq(local.PGSSLMODE, 'disable');
    assert(!('PGPASSWORD' in local), 'no empty PGPASSWORD');
  });

  test('isLocalUrl accepts only the loopback host', () => {
    assert(bk.isLocalUrl('postgres://postgres@localhost:5432/x'));
    assert(bk.isLocalUrl('postgres://postgres@127.0.0.1/x'));
    assert(!bk.isLocalUrl('postgres://u@localhost.example.test/x'));
    assert(!bk.isLocalUrl('not a url'));
  });

  test('majorOf reads the tool and server versions', () => {
    assertEq(bk.majorOf('pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)'), 17);
    assertEq(bk.majorOf('16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)'), 16);
  });

  test('stamp sorts and fits an object key', () => {
    assertEq(bk.stamp(new Date('2026-09-30T19:48:05.123Z')), '20260930T194805Z');
  });

  test('manifestPathFor strips .age and .dump', () => {
    assertEq(bk.manifestPathFor('/b/app-20260930T194805Z.dump.age'), '/b/app-20260930T194805Z.manifest.json');
    assertEq(bk.manifestPathFor('/b/app-20260930T194805Z.dump'), '/b/app-20260930T194805Z.manifest.json');
  });

  test('tableRanges brackets counts taken before and after the dump', () => {
    const r2 = bk.tableRanges({ songs: 10, gigs: 5, gone: 1 }, { songs: 12, gigs: 4, added: 3 });
    assertEq(JSON.stringify(r2), JSON.stringify({ songs: [10, 12], gigs: [4, 5] }));
  });

  const manifest = {
    tables: { songs: [10, 12], users: [2, 2] },
    sequences: { artists_id_seq: 40 },
    schemaVersion: '2026-10-04',
  };
  const good = { counts: { songs: 11, users: 2 }, sequences: { artists_id_seq: 41 }, schemaVersion: '2026-10-04' };

  test('compareRestore passes a restore inside the ranges', () => {
    assertEq(bk.compareRestore(manifest, good).length, 0);
  });

  test('compareRestore names every mismatch', () => {
    const problems = bk.compareRestore(manifest, {
      counts: { songs: 9, extra: 1 },
      sequences: { artists_id_seq: 39 },
      schemaVersion: '2026-10-03',
    });
    assertEq(problems.length, 5, problems.join(' | '));
    assert(problems.some(p => p.startsWith('table songs: 9 rows')), 'row count');
    assert(problems.some(p => p === 'table users is missing'), 'missing table');
    assert(problems.some(p => p === 'table extra is not in the manifest'), 'extra table');
    assert(problems.some(p => p.startsWith('sequence artists_id_seq restored at 39')), 'sequence behind');
    assert(problems.some(p => p.startsWith('schema version 2026-10-03')), 'schema version');
  });
}

module.exports = run;
if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}
