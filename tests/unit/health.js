'use strict';

// GET /api/config?action=health — what the uptime monitors and the post-deploy
// check read. CI only ever sees it healthy; these are the answers that page
// someone: a schema behind, a database without the ledger, a database that
// does not answer, a required variable missing. Always 503, never a value.

const path = require('path');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();
  const { SCHEMA_VERSION } = require(path.join(ROOT, 'api/_env'));

  // _config with getDb answering `db`, and only these variables set.
  async function health(db, env) {
    const dbPath = require.resolve(path.join(ROOT, 'api/_db'));
    const configPath = require.resolve(path.join(ROOT, 'api/_config'));
    const saved = { ...process.env };
    for (const k of ['DATABASE_URL', 'APP_SECRET', 'VERCEL_ENV']) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[configPath];
    const realDb = require.cache[dbPath];
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: { getDb: () => db, getArtist: async () => null, getSlug: () => null },
    };
    const res = { _status: 200, _headers: {} };
    res.status = s => { res._status = s; return res; };
    res.json = b => { res._body = b; return res; };
    res.setHeader = (k, v) => { res._headers[k] = v; return res; };
    try {
      await require(configPath)({ method: 'GET', query: { action: 'health' }, headers: {} }, res);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      delete require.cache[configPath];
      if (realDb) require.cache[dbPath] = realDb; else delete require.cache[dbPath];
    }
    return res;
  }

  const ENV = { DATABASE_URL: 'postgres://u:secret-password@db.example.test/x', APP_SECRET: 'super-secret-value' };
  const answers = current => async () => [{ current }];

  console.log(B('\nhealth check'));

  await testAsync('an invalid index is a warning, not an outage', async () => {
    const res = await health(async () => [{ current: true, invalid: ['idx_x'] }], ENV);
    assertEq(res._status, 200);
    assert(res._body.warnings.some(w => /invalid index: idx_x/.test(w)), JSON.stringify(res._body.warnings));
  });

  await testAsync('database on the newest migration → 200 "current"', async () => {
    const res = await health(answers(true), ENV);
    assertEq(res._status, 200);
    assertEq(res._body.schema, 'current');
    assertEq(res._body.database, 'ok');
    assertEq(res._body.schemaVersion, SCHEMA_VERSION);
    assertEq(res._headers['Cache-Control'], 'no-store');
  });

  await testAsync('database behind → 503 "behind"', async () => {
    const res = await health(answers(false), ENV);
    assertEq(res._status, 503);
    assertEq(res._body.ok, false);
    assertEq(res._body.schema, 'behind');
  });

  await testAsync('no ledger table yet → 503 "behind", the database still "ok"', async () => {
    const res = await health(async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); }, ENV);
    assertEq(res._status, 503);
    assertEq(res._body.database, 'ok');
    assertEq(res._body.schema, 'behind');
  });

  await testAsync('database not answering → 503 "error", no error text', async () => {
    const res = await health(async () => { throw Object.assign(new Error('connect ECONNREFUSED db.example.test'), { code: 'ECONNREFUSED' }); }, ENV);
    assertEq(res._status, 503);
    assertEq(res._body.database, 'error');
    assert(!JSON.stringify(res._body).includes('ECONNREFUSED'), 'the error leaks into the answer');
  });

  await testAsync('missing APP_SECRET → 503 naming it, never a value', async () => {
    const res = await health(answers(true), { DATABASE_URL: ENV.DATABASE_URL });
    assertEq(res._status, 503);
    assertEq(res._body.missing, ['APP_SECRET']);
    const text = JSON.stringify(res._body);
    assert(!text.includes('secret-password') && !text.includes('db.example.test'), 'a value leaks into the answer');
  });

  await testAsync('no DATABASE_URL → 503 "not configured", no query', async () => {
    let queried = false;
    const res = await health(async () => { queried = true; return [{ current: true }]; }, { APP_SECRET: ENV.APP_SECRET });
    assertEq(res._status, 503);
    assertEq(res._body.database, 'not configured');
    assertEq(res._body.missing, ['DATABASE_URL']);
    assert(!queried, 'queried a database it has no URL for');
  });
}

module.exports = run;

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
