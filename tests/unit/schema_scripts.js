'use strict';

// The scripts every deploy runs on its database: scripts/deploy_migrate.js
// (postinstall in a Vercel build) and the statement splitter it shares with
// scripts/apply_schema.js. A wrong decision here migrates no database, or the
// wrong one; a wrong split runs half a statement.

const path = require('path');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');

// A raw runner like apply_schema's connect(): sql([text]). `have` is the
// schema_migrations ledger (null: no ledger table yet); an INSERT INTO
// schema_migrations statement adds its id, as running it would, unless that id
// is `lost` (a block whose INSERT did not take).
function fakeDb(have, lost = null) {
  const ran = [];
  const sql = async ([text]) => {
    if (text === 'SELECT id FROM schema_migrations') {
      if (have === null) throw new Error('relation "schema_migrations" does not exist');
      return have.map(id => ({ id }));
    }
    ran.push(text);
    const m = /INSERT INTO schema_migrations \(id\) VALUES \('([^']+)'\)/.exec(text);
    if (m && m[1] !== lost) { have = have || []; have.push(m[1]); }
    if (/already there/.test(text)) throw new Error('relation "x" already exists');
    return [];
  };
  return { sql, ran };
}

const SRC = `
-- header: INSERT INTO schema_migrations (id) VALUES ('example') in a comment does not count
CREATE TABLE IF NOT EXISTS t (id int);
CREATE INDEX already there;
INSERT INTO schema_migrations (id) VALUES ('2026-01-01') ON CONFLICT DO NOTHING;
ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;
INSERT INTO schema_migrations (id) VALUES ('2026-01-02') ON CONFLICT DO NOTHING;
`;

async function run(r) {
  const { test, testAsync, assert, assertEq, B } = r;
  const { decide, migrate } = require(path.join(ROOT, 'scripts/deploy_migrate'));
  const { splitStatements, migrationIds } = require(path.join(ROOT, 'scripts/apply_schema'));

  console.log(B('\ndeploy_migrate: which builds migrate'));

  const cases = [
    [{},                                                                    'skip',    'a local or CI npm install'],
    [{ VERCEL: '1', VERCEL_ENV: 'development', DATABASE_URL: 'x' },         'skip',    'vercel dev'],
    [{ VERCEL: '1', VERCEL_ENV: 'preview' },                                'skip',    'a preview with no database'],
    [{ VERCEL: '1', VERCEL_ENV: 'production' },                             'fail',    'production with no database'],
    [{ VERCEL: '1', VERCEL_ENV: 'preview', DATABASE_URL: 'x' },             'migrate', 'a preview with its database'],
    [{ VERCEL: '1', VERCEL_ENV: 'production', DATABASE_URL: 'x' },          'migrate', 'production'],
    [{ VERCEL: '0', VERCEL_ENV: 'production', DATABASE_URL: 'x' },          'skip',    'not a Vercel build, whatever VERCEL_ENV says'],
  ];
  for (const [env, want, label] of cases)
    test(`${label} → ${want}`, () => assertEq(decide(env), want));

  console.log(B('\ndeploy_migrate: migrate()'));

  await testAsync('nothing pending → no statement runs', async () => {
    const db = fakeDb(['2026-01-01', '2026-01-02']);
    const out = await migrate(db.sql, SRC);
    assertEq(out.pending, []);
    assertEq(out.latest, '2026-01-02');
    assertEq(db.ran, []);
  });

  await testAsync('one pending → every statement runs, "already exists" is skipped', async () => {
    const db = fakeDb(['2026-01-01']);
    const out = await migrate(db.sql, SRC);
    assertEq(out.pending, ['2026-01-02']);
    assertEq(db.ran.length, 5);
    assertEq(out.skipped, 1);
  });

  await testAsync('a database without the ledger table is migrated from scratch', async () => {
    const db = fakeDb(null);
    const out = await migrate(db.sql, SRC);
    assertEq(out.pending, ['2026-01-01', '2026-01-02']);
  });

  await testAsync('a migration still missing after the run fails the build', async () => {
    const db = fakeDb([], '2026-01-02');
    let err = null;
    try { await migrate(db.sql, SRC); } catch (e) { err = e; }
    assert(err && /still pending after apply: 2026-01-02/.test(err.message), `got ${err && err.message}`);
  });

  await testAsync('any other error is the build\'s failure, with the statement', async () => {
    const sql = async ([text]) => {
      if (text === 'SELECT id FROM schema_migrations') return [];
      throw new Error('column "c" of relation "t" contains null values');
    };
    let err = null;
    try { await migrate(sql, SRC); } catch (e) { err = e; }
    assert(err && /contains null values/.test(err.message), 'error lost');
    assert(/CREATE TABLE/.test(err.statement || ''), 'the failing statement is not named');
  });

  console.log(B('\napply_schema: splitStatements'));

  test('a ; inside a comment does not split a statement', () => {
    assertEq(splitStatements("CREATE TABLE a (x int); -- one; two\nSELECT 1;"),
      ['CREATE TABLE a (x int)', 'SELECT 1']);
  });

  test('-- inside a string literal is not a comment', () => {
    assertEq(splitStatements("INSERT INTO t VALUES ('a--b');"), ["INSERT INTO t VALUES ('a--b')"]);
  });

  test('whole-line comments and blank statements disappear', () => {
    assertEq(splitStatements('-- only a comment\n;\n\nSELECT 1;\n'), ['SELECT 1']);
  });

  test('migration ids come from statements, not from comments', () => {
    assertEq(migrationIds(SRC), ['2026-01-01', '2026-01-02']);
  });
}

module.exports = run;

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
