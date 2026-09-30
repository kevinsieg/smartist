'use strict';

// Logging in without naming a band. `/api/:artist/auth` needs the slug in the
// URL; at the root of a multi-tenant deployment there is none, and the login
// form used to post to `/api//auth`. These cover the replacement path, which
// authenticates on email alone — so the enumeration and rate-limit behaviour
// matter as much as the happy path.

const path   = require('path');
const bcrypt = require('bcryptjs');
const { stubLogger } = require('./_runner');

stubLogger();

process.env.APP_SECRET = process.env.APP_SECRET || 'unit-test-secret-32-bytes-okayy!';

const HASH = bcrypt.hashSync('correct horse battery', 4);
const OTHER = bcrypt.hashSync('a different password', 4);

function makeHandler(rows, { rateLimited = false, artists = [{ slug: 'a', name: 'A', role: 'admin' }] } = {}) {
  const dbPath     = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath     = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const authPath   = require.resolve(path.join(__dirname, '../../api/_auth'));
  const tokenPath  = require.resolve(path.join(__dirname, '../../api/_token'));
  const configPath = require.resolve(path.join(__dirname, '../../api/config'));

  [dbPath, authPath, tokenPath, configPath].forEach(p => delete require.cache[p]);
  const domainDir = path.join(__dirname, '../../api/_domain');
  require('fs').readdirSync(domainDir).filter(f => f.endsWith('.js')).forEach(f => {
    try { delete require.cache[require.resolve(path.join(domainDir, f))]; } catch {}
  });

  const queries = [];
  const sql = (strings, ...values) => {
    const text = Array.isArray(strings) ? strings.join(' ').replace(/\s+/g, ' ').trim() : String(strings);
    queries.push({ text, values });
    if (/FROM users/.test(text)) return Promise.resolve(rows);
    if (/FROM users u JOIN artists/.test(text)) return Promise.resolve(artists);
    return Promise.resolve(artists);
  };

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { loginLocked: async () => false, countLoginFailure: async () => {}, checkRateLimit: async () => rateLimited, clientIp: () => '127.0.0.1' },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async slug => ({ id: 1, slug, name: 'Test', config: {} }),
      getSlug: req => (req.query && req.query.artist) || 'test',
    },
  };
  return { handler: require(path.join(__dirname, '../../api/config')), queries };
}

function mockRes() {
  const res = { _status: 200 };
  res.status = s => { res._status = s; return res; };
  res.json = b => { res._body = b; return res; };
  res.setHeader = () => res;
  res.redirect = (c, u) => { res._status = c; res._redirected = u; return res; };
  return res;
}

// The rewrite /api/login → /api/config?action=login delivers the action in the
// QUERY. Exercising only the body shape is exactly what let a rewritten login
// fall through to the subscribe handler in production.
async function call(handler, body, { via = 'query' } = {}) {
  const res = mockRes();
  const req = via === 'query'
    ? { method: 'POST', body, headers: {}, query: { action: 'login' } }
    : { method: 'POST', body: { action: 'login', ...body }, headers: {}, query: {} };
  await handler(req, res);
  return res;
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  console.log(B('\nslug-less login'));

  await testAsync('missing password → 400', async () => {
    const { handler } = makeHandler([]);
    assertEq((await call(handler, { email: 'a@b.co' }))._status, 400);
  });

  await testAsync('missing email → 400', async () => {
    const { handler } = makeHandler([]);
    assertEq((await call(handler, { password: 'x' }))._status, 400);
  });

  await testAsync('an unknown address is rejected without saying so', async () => {
    const { handler } = makeHandler([]);
    const res = await call(handler, { email: 'nobody@example.com', password: 'whatever' });
    assertEq(res._status, 401);
    assertEq(res._body.error, 'Invalid email or password',
      'the message must not distinguish an unknown address from a wrong password');
  });

  await testAsync('a wrong password gets the same message as an unknown address', async () => {
    const { handler } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }]);
    const res = await call(handler, { email: 'a@b.co', password: 'not it' });
    assertEq(res._status, 401);
    assertEq(res._body.error, 'Invalid email or password');
  });

  await testAsync('the right password returns a token and the bands', async () => {
    const { handler } = makeHandler([{ id: 7, role: 'member', password_hash: HASH }]);
    const res = await call(handler, { email: 'A@B.co', password: 'correct horse battery' });
    assertEq(res._status, 200);
    assert(res._body.token, 'expected a session token');
    assertEq(res._body.email, 'a@b.co', 'the address should be normalised');
    assert(Array.isArray(res._body.artists), 'expected the list of bands');
  });

  await testAsync('with several bands on one address, the matching row wins', async () => {
    // Same email, different passwords per band — the second row is the match.
    const { handler } = makeHandler([
      { id: 1, role: 'member', password_hash: OTHER },
      { id: 2, role: 'admin',  password_hash: HASH },
    ]);
    const res = await call(handler, { email: 'a@b.co', password: 'correct horse battery' });
    assertEq(res._status, 200);
    assertEq(res._body.role, 'admin', 'should authenticate as the row whose hash matched');
  });

  await testAsync('rows without a password are never candidates', async () => {
    const { handler, queries } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }]);
    await call(handler, { email: 'a@b.co', password: 'correct horse battery' });
    const q = queries.find(x => /FROM users/.test(x.text));
    assert(/password_hash IS NOT NULL/.test(q.text),
      'an invited-but-not-accepted row has a null hash and must be excluded');
  });

  await testAsync('too many attempts → 429, before any lookup', async () => {
    const { handler, queries } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }], { rateLimited: true });
    const res = await call(handler, { email: 'a@b.co', password: 'correct horse battery' });
    assertEq(res._status, 429);
    assertEq(queries.filter(q => /FROM users/.test(q.text)).length, 0, 'must not query while rate limited');
  });

  await testAsync('an absurd password is refused before bcrypt runs', async () => {
    const { handler, queries } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }]);
    const res = await call(handler, { email: 'a@b.co', password: 'x'.repeat(1001) });
    assertEq(res._status, 400);
    assertEq(queries.length, 0);
  });


  await testAsync('the action is honoured in the body too, as the app sends it', async () => {
    const { handler } = makeHandler([{ id: 7, role: 'member', password_hash: HASH }]);
    const res = await call(handler, { email: 'a@b.co', password: 'correct horse battery' }, { via: 'body' });
    assertEq(res._status, 200);
  });

  await testAsync('a rewritten login never reaches another action', async () => {
    // It reached subscribe once, which answered a login attempt with
    // "Already subscribed" — and wrote the address to the mailing list.
    const { handler } = makeHandler([]);
    const res = await call(handler, { email: 'nobody@example.com', password: 'wrong' });
    assertEq(res._status, 401);
    assertEq(res._body.error, 'Invalid email or password');
  });

  // ── the config read the login page makes on load ──────────────────────────
  console.log(B('\nconfig without a slug'));

  await testAsync('a plain read is 200, not 404, when no band is pinned', async () => {
    const saved = process.env.ARTIST_SLUG;
    delete process.env.ARTIST_SLUG;
    const { handler } = makeHandler([]);
    const res = mockRes();
    await handler({ method: 'GET', query: {}, headers: {}, url: '/api/config' }, res);
    if (saved !== undefined) process.env.ARTIST_SLUG = saved;
    assertEq(res._status, 200, 'the multi-tenant root would log a 404 on every page load');
    assertEq(res._body.singleTenant, false);
  });

  await testAsync('asking for an action without a band is still 404', async () => {
    const saved = process.env.ARTIST_SLUG;
    delete process.env.ARTIST_SLUG;
    const { handler } = makeHandler([]);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'photo-url' }, headers: {}, url: '/api/config' }, res);
    if (saved !== undefined) process.env.ARTIST_SLUG = saved;
    assertEq(res._status, 404);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
