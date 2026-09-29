'use strict';
const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

function makeHandler({ emailFn } = {}) {
  const dbPath     = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath     = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const emailPath  = require.resolve(path.join(__dirname, '../../api/_email'));
  const configPath = require.resolve(path.join(__dirname, '../../api/config'));

  delete require.cache[dbPath];
  delete require.cache[configPath];
  // config.js delegates to api/_domain/* — bust them so the re-require rebuilds
  // the chain against the stubs below (the contact handler lives in _domain/subscribe).
  const domainDir = path.join(__dirname, '../../api/_domain');
  require('fs').readdirSync(domainDir).filter(f => f.endsWith('.js')).forEach(function(f) {
    try { delete require.cache[require.resolve(path.join(domainDir, f))]; } catch {}
  });

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { loginLocked: async () => false, countLoginFailure: async () => {}, checkRateLimit: async () => false, clientIp: () => '127.0.0.1', isMissingRateLimitTable: () => false },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => (async () => []),
      getArtist: async () => ({ id: 1, slug: 'test', name: 'Test', config: {} }),
    },
  };
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendEmail: emailFn || (async () => {}) },
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

  await testAsync('POST /api/config contact — missing name → 400', async () => {
    const handler = makeHandler();
    const res = mockRes();
    await handler({ method: 'POST', body: { source: 'contact', email: 'a@b.com', message: 'hello' } }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config contact — missing email → 400', async () => {
    const handler = makeHandler();
    const res = mockRes();
    await handler({ method: 'POST', body: { source: 'contact', name: 'Alice', message: 'hello' } }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config contact — invalid email → 400', async () => {
    const handler = makeHandler();
    const res = mockRes();
    await handler({ method: 'POST', body: { source: 'contact', name: 'Alice', email: 'notanemail', message: 'hello' } }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config contact — missing message → 400', async () => {
    const handler = makeHandler();
    const res = mockRes();
    await handler({ method: 'POST', body: { source: 'contact', name: 'Alice', email: 'a@b.com' } }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config contact — message too long → 400', async () => {
    const handler = makeHandler();
    const res = mockRes();
    await handler({ method: 'POST', body: { source: 'contact', name: 'Alice', email: 'a@b.com', message: 'x'.repeat(5001) } }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config contact — send failure → 500', async () => {
    const handler = makeHandler({ emailFn: async () => { throw new Error('smtp error'); } });
    const res = mockRes();
    await handler({ method: 'POST', body: { source: 'contact', name: 'Alice', email: 'a@b.com', message: 'hello' } }, res);
    assertEq(res._status, 500);
  });

  await testAsync('POST /api/config contact — success → 200', async () => {
    let sent = null;
    const handler = makeHandler({ emailFn: async (opts) => { sent = opts; } });
    const res = mockRes();
    await handler({ method: 'POST', body: { source: 'contact', name: 'Alice', email: 'a@b.com', message: 'hello world' } }, res);
    assertEq(res._status, 200);
    assertEq(res._body?.ok, true);
    assertEq(sent?.reply_to, 'a@b.com');
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
module.exports = run;
