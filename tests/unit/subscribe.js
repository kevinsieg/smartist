'use strict';
const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

// Re-require config.js backed by a given sql tagged-template stub.
// Always overrides _ratelimit so the real DB-backed rate limiter is never called,
// regardless of what's in require.cache from earlier suites.
function makeHandler(sqlFn) {
  const dbPath = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const configPath = require.resolve(path.join(__dirname, '../../api/config'));

  delete require.cache[dbPath];
  delete require.cache[configPath];

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1', isMissingRateLimitTable: () => false },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sqlFn,
      getBand: async () => ({ id: 1, slug: 'test', name: 'Test', config: {} }),
    },
  };

  return require(path.join(__dirname, '../../api/config'));
}

function mockRes() {
  const r = { _status: 200 };
  r.status = (s) => { r._status = s; return r; };
  r.json   = (b) => { r._body  = b; return r; };
  return r;
}

async function run(r) {
  const { testAsync, assertEq } = r;

  await testAsync('POST /api/config subscribe — missing email → 400', async () => {
    const handler = makeHandler((s, ...v) => Promise.resolve([]));
    const res = mockRes();
    await handler({ method: 'POST', body: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config subscribe — invalid email → 400', async () => {
    const handler = makeHandler((s, ...v) => Promise.resolve([]));
    const res = mockRes();
    await handler({ method: 'POST', body: { email: 'notanemail' } }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config subscribe — duplicate email → 409', async () => {
    const dupErr = Object.assign(new Error('unique violation'), { code: '23505' });
    const handler = makeHandler((s, ...v) => Promise.reject(dupErr));
    const res = mockRes();
    await handler({ method: 'POST', body: { email: 'a@b.com' } }, res);
    assertEq(res._status, 409);
  });

  await testAsync('POST /api/config subscribe — valid email → 200', async () => {
    const handler = makeHandler((s, ...v) => Promise.resolve([]));
    const res = mockRes();
    await handler({ method: 'POST', body: { email: 'hello@example.com' } }, res);
    assertEq(res._status, 200);
    assertEq(res._body?.ok, true);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
module.exports = run;
