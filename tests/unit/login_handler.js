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

function makeHandler(rows, { rateLimited = false, locked = false, artists = [{ slug: 'a', name: 'A', role: 'admin' }] } = {}) {
  const dbPath     = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath     = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const authPath   = require.resolve(path.join(__dirname, '../../api/_auth'));
  const tokenPath  = require.resolve(path.join(__dirname, '../../api/_token'));
  const configPath = require.resolve(path.join(__dirname, '../../api/_config'));

  [dbPath, authPath, tokenPath, configPath].forEach(p => delete require.cache[p]);
  const domainDir = path.join(__dirname, '../../api/_domain');
  require('fs').readdirSync(domainDir).filter(f => f.endsWith('.js')).forEach(f => {
    try { delete require.cache[require.resolve(path.join(domainDir, f))]; } catch {}
  });

  const queries = [];
  const failures = [];
  const failureIps = [];
  const sql = (strings, ...values) => {
    const text = Array.isArray(strings) ? strings.join(' ').replace(/\s+/g, ' ').trim() : String(strings);
    queries.push({ text, values });
    // passwordLogin's one statement: IP count, lock, candidates and bands.
    if (/WITH ip_hit AS \( INSERT INTO rate_limits/.test(text))
      return Promise.resolve([{ ip_limited: rateLimited, locked, candidates: rows, artists }]);
    if (/FROM users/.test(text)) return Promise.resolve(rows);
    return Promise.resolve(artists);
  };

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: {
      loginFailKey: email => `login-fail:${email}`, loginFailPairKey: (email, ip) => `login-fail:${email}|${ip}`,
      LOGIN_FAIL_MAX: 10, LOGIN_FAIL_ADDRESS_MAX: 100, LOGIN_FAIL_WINDOW: 900,
      countLoginFailure: async (email, ip) => { failures.push(email); failureIps.push(ip); },
      checkRateLimit: async () => rateLimited, clientIp: () => '127.0.0.1',
    },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async slug => ({ id: 1, slug, name: 'Test', config: {} }),
      getSlug: req => (req.query && req.query.artist) || 'test',
    },
  };
  return { handler: require(path.join(__dirname, '../../api/_config')), queries, failures, failureIps };
}

function mockRes() {
  const res = { _status: 200 };
  res.status = s => { res._status = s; return res; };
  res.json = b => { res._body = b; return res; };
  res.setHeader = () => res;
  res.redirect = (c, u) => { res._status = c; res._redirected = u; return res; };
  return res;
}

// The route table turns /api/login into action 'login' in the QUERY; an action
// in the body is not read at all.
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

  await testAsync('rows sharing a hash are compared once', async () => {
    const { handler, queries } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }]);
    await call(handler, { email: 'a@b.co', password: 'correct horse battery' });
    const q = queries.find(x => /FROM users/.test(x.text));
    assert(/DISTINCT ON \(password_hash\)/.test(q.text),
      'one password is written to every row of an address; a bcrypt round per band made sign-in seconds slow');
    assert(/ORDER BY password_hash, id \) first_per_hash ORDER BY id/.test(q.text),
      'the lowest row id of each hash, then by id, so the same row wins as before');
  });

  await testAsync('too many attempts from one IP → 429, no password checked', async () => {
    const { handler, queries, failures } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }], { rateLimited: true });
    const res = await call(handler, { email: 'a@b.co', password: 'correct horse battery' });
    assertEq(res._status, 429);
    assertEq(queries.length, 1, 'the gate statement only');
    assertEq(failures.length, 0, 'a refused attempt is not a failed password');
  });

  await testAsync('a locked address → 429, even with the right password', async () => {
    const { handler, failures } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }], { locked: true });
    const res = await call(handler, { email: 'a@b.co', password: 'correct horse battery' });
    assertEq(res._status, 429);
    assertEq(failures.length, 0);
  });

  await testAsync('the lock is read for the address and the attempt counted for the IP', async () => {
    const { handler, queries } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }]);
    await call(handler, { email: 'A@B.co', password: 'correct horse battery' });
    assert(queries[0].values.includes('auth:127.0.0.1'), 'the per-IP key');
    assert(queries[0].values.includes('login-fail:a@b.co'), 'the per-address lock key, normalised');
    assert(queries[0].values.includes('login-fail:a@b.co|127.0.0.1'), 'the per-address-and-IP lock key');
  });

  await testAsync('a successful sign-in is one statement', async () => {
    const { handler, queries } = makeHandler([{ id: 7, role: 'member', password_hash: HASH }]);
    const res = await call(handler, { email: 'a@b.co', password: 'correct horse battery' });
    assertEq(res._status, 200);
    assertEq(queries.length, 1, 'rate limit, lock, candidates and bands were four statements');
    assertEq(res._body.artists[0].slug, 'a', 'the bands come from that statement');
  });

  await testAsync('a wrong password is counted against the address and IP', async () => {
    const { handler, failures, failureIps } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }]);
    await call(handler, { email: 'a@b.co', password: 'not it' });
    assertEq(failures.length, 1);
    assertEq(failures[0], 'a@b.co');
    assertEq(failureIps[0], '127.0.0.1');
  });

  await testAsync('an absurd password is refused before bcrypt runs', async () => {
    const { handler, queries } = makeHandler([{ id: 1, role: 'admin', password_hash: HASH }]);
    const res = await call(handler, { email: 'a@b.co', password: 'x'.repeat(1001) });
    assertEq(res._status, 400);
    assertEq(queries.length, 0);
  });


  await testAsync('an action in the body is ignored: actions are URL paths', async () => {
    const { handler, queries } = makeHandler([{ id: 7, role: 'member', password_hash: HASH }]);
    const res = await call(handler, { email: 'a@b.co', password: 'correct horse battery' }, { via: 'body' });
    assertEq(res._status, 404);
    assertEq(queries.length, 0);
  });

  await testAsync('a rewritten login never reaches another action', async () => {
    // It reached subscribe once, which answered a login attempt with
    // "Already subscribed" — and wrote the address to the mailing list.
    const { handler } = makeHandler([]);
    const res = await call(handler, { email: 'nobody@example.com', password: 'wrong' });
    assertEq(res._status, 401);
    assertEq(res._body.error, 'Invalid email or password');
  });

  // ── mailed sign-in links ──────────────────────────────────────────────────
  console.log(B('\nsign-in link'));

  const { generateMagicToken } = require('../../api/_token');
  const hint = addr => Buffer.from(addr).toString('base64url');
  async function magic(handler, body) {
    const res = mockRes();
    await handler({ method: 'POST', body, headers: {}, query: { action: 'magic-login' } }, res);
    return res;
  }

  await testAsync('a link signed for the address logs in and lists the bands', async () => {
    const { handler } = makeHandler([{ id: 7, role: 'member', password_hash: HASH }]);
    const res = await magic(handler, { magic: generateMagicToken(HASH, 'login'), hint: hint('a@b.co') });
    assertEq(res._status, 200);
    assert(res._body.token, 'expected a session token');
    assertEq(res._body.email, 'a@b.co');
    assert(Array.isArray(res._body.artists), 'expected the list of bands');
  });

  await testAsync('a link signed with another row of the address still works', async () => {
    const { handler } = makeHandler([
      { id: 1, role: 'member', password_hash: OTHER },
      { id: 2, role: 'admin',  password_hash: HASH },
    ]);
    const res = await magic(handler, { magic: generateMagicToken(HASH, 'login'), hint: hint('a@b.co') });
    assertEq(res._status, 200);
    assertEq(res._body.role, 'admin');
  });

  await testAsync('a reset link does not log anyone in', async () => {
    const { handler } = makeHandler([{ id: 7, role: 'member', password_hash: HASH }]);
    const res = await magic(handler, { magic: generateMagicToken(HASH, 'reset'), hint: hint('a@b.co') });
    assertEq(res._status, 401);
  });

  await testAsync('a link for one account with another address in the hint is refused', async () => {
    const { handler } = makeHandler([{ id: 9, role: 'admin', password_hash: OTHER }]);
    const res = await magic(handler, { magic: generateMagicToken(HASH, 'login'), hint: hint('victim@b.co') });
    assertEq(res._status, 401);
  });

  await testAsync('no hint → 400, before any lookup', async () => {
    const { handler, queries } = makeHandler([{ id: 7, role: 'member', password_hash: HASH }]);
    const res = await magic(handler, { magic: generateMagicToken(HASH, 'login') });
    assertEq(res._status, 400);
    assertEq(queries.length, 0);
  });

  // ── log out everywhere ────────────────────────────────────────────────────
  console.log(B('\nlog out everywhere'));

  const { generateUserToken, TTL_8H } = require('../../api/_token');
  async function logoutAll(handler, token) {
    const res = mockRes();
    await handler({ method: 'POST', body: {}, query: { action: 'logout-everywhere' },
      headers: token ? { authorization: `Bearer ${token}` } : {} }, res);
    return res;
  }

  await testAsync('a valid session stamps every row of its address', async () => {
    const { handler, queries } = makeHandler([{ email: 'a@b.co', password_hash: HASH, sessions_valid_after: null }]);
    const res = await logoutAll(handler, generateUserToken(7, 'member', TTL_8H, HASH));
    assertEq(res._status, 200);
    const upd = queries.find(q => /UPDATE users SET sessions_valid_after/.test(q.text));
    assert(upd, 'expected the update');
    assert(/WHERE email =/.test(upd.text), 'every workspace of the address, not only this row');
    assertEq(upd.values[1], 'a@b.co');
  });

  await testAsync('no token → 401, nothing written', async () => {
    const { handler, queries } = makeHandler([]);
    assertEq((await logoutAll(handler, null))._status, 401);
    assertEq(queries.length, 0);
  });

  await testAsync('a session already ended by a password change → 401, nothing written', async () => {
    const { handler, queries } = makeHandler([{ email: 'a@b.co', password_hash: OTHER, sessions_valid_after: null }]);
    assertEq((await logoutAll(handler, generateUserToken(7, 'member', TTL_8H, HASH)))._status, 401);
    assertEq(queries.filter(q => /UPDATE/.test(q.text)).length, 0);
  });

  // ── the config read the login page makes on load ──────────────────────────
  console.log(B('\nconfig without a slug'));

  await testAsync('a plain read is 200, not 404, when no band is pinned', async () => {
    const saved = process.env.ARTIST_SLUG;
    delete process.env.ARTIST_SLUG;
    const { handler } = makeHandler([]);
    const res = mockRes();
    await handler({ method: 'GET', query: {}, headers: {}, url: '/api/_config' }, res);
    if (saved !== undefined) process.env.ARTIST_SLUG = saved;
    assertEq(res._status, 200, 'the multi-tenant root would log a 404 on every page load');
    assertEq(res._body.singleTenant, false);
  });

  await testAsync('asking for an action without a band is still 404', async () => {
    const saved = process.env.ARTIST_SLUG;
    delete process.env.ARTIST_SLUG;
    const { handler } = makeHandler([]);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'photo-url' }, headers: {}, url: '/api/_config' }, res);
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
