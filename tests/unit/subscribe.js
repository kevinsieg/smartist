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
  const configPath = require.resolve(path.join(__dirname, '../../api/_config'));

  delete require.cache[dbPath];
  delete require.cache[configPath];
  // config.js delegates to api/_domain/* — bust them so the re-require rebuilds
  // the chain against the stubs below (the subscribe handler lives in _domain/subscribe).
  const domainDir = path.join(__dirname, '../../api/_domain');
  require('fs').readdirSync(domainDir).filter(f => f.endsWith('.js')).forEach(function(f) {
    try { delete require.cache[require.resolve(path.join(domainDir, f))]; } catch {}
  });

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { loginLocked: async () => false, countLoginFailure: async () => {}, checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sqlFn,
      getArtist: async () => ({ id: 1, slug: 'test', name: 'Test', config: {} }),
    },
  };

  return require(path.join(__dirname, '../../api/_config'));
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

  await testAsync('POST /api/config subscribe demo — stores country only, no city, user agent or referrer', async () => {
    const values = [];
    const handler = makeHandler((s, ...v) => { values.push(...v); return Promise.resolve([]); });
    const res = mockRes();
    await handler({
      method: 'POST',
      headers: {
        'x-vercel-ip-country': 'FR', 'x-vercel-ip-country-region': 'IDF', 'x-vercel-ip-city': 'Paris',
        'user-agent': 'UA/1.0', referer: 'https://example.com/',
      },
      body: { email: 'demo@example.com', source: 'demo', name: 'Demo' },
    }, res);
    assertEq(res._status, 200);
    const meta = values.find(v => v && typeof v === 'object' && 'geo_country' in v);
    assertEq(meta.geo_country, 'FR');
    for (const k of ['geo_city', 'geo_region', 'ua', 'ref']) assertEq(k in meta, false);
  });

  await testAsync('POST /api/config subscribe demo — form fields are bounded strings', async () => {
    const values = [];
    const handler = makeHandler((s, ...v) => { values.push(...v); return Promise.resolve([]); });
    const res = mockRes();
    await handler({
      method: 'POST', headers: {},
      body: {
        email: 'demo@example.com', source: 'demo',
        name: 'x'.repeat(5000), genres: ['Folk', { big: 'x'.repeat(5000) }, 'Jazz'], perform_country: { nested: true },
      },
    }, res);
    assertEq(res._status, 200);
    const meta = values.find(v => v && typeof v === 'object' && 'geo_country' in v);
    assertEq(meta.name, null);
    assertEq(meta.genres, ['Folk', 'Jazz']);
    assertEq(meta.perform_country, null);
  });

  await testAsync('sweepSubscribers — deletes rows past 24 months and strips dropped meta keys', async () => {
    const queries = [];
    const { sweepSubscribers } = require(path.join(__dirname, '../../api/_domain/subscribe'));
    const random = Math.random;
    Math.random = () => 0;
    try { await sweepSubscribers((s, ...v) => { queries.push(s.join('?')); return Promise.resolve([]); }); }
    finally { Math.random = random; }
    assertEq(queries.length, 1);
    assertEq(/DELETE FROM subscribers WHERE created_at < now\(\) - interval '24 months'/.test(queries[0]), true);
    assertEq(/meta - \?::text\[\]/.test(queries[0]), true);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
module.exports = run;
