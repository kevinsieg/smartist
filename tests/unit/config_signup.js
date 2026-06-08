const path = require('path');
const crypto = require('crypto');

process.env.APP_SECRET           = process.env.APP_SECRET           || 'unit-test-secret-32-bytes-okayy!';
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
process.env.FACEBOOK_APP_ID      = process.env.FACEBOOK_APP_ID      || 'test-fb-id';
process.env.FACEBOOK_APP_SECRET  = process.env.FACEBOOK_APP_SECRET  || 'test-fb-secret';

const { generateUserToken, TTL_8H } = require(path.join(__dirname, '../../api/_token'));

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  function makeHandler(sqlFn, emailFn) {
    const dbPath     = require.resolve(path.join(__dirname, '../../api/_db'));
    const rlPath     = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
    const emailPath  = require.resolve(path.join(__dirname, '../../api/_email'));
    const configPath = require.resolve(path.join(__dirname, '../../api/config'));

    const tokenPath = require.resolve(path.join(__dirname, '../../api/_token'));
    delete require.cache[dbPath];
    delete require.cache[configPath];
    delete require.cache[tokenPath];
    ['identity', 'artist', 'registration'].forEach(function(m) {
      try { delete require.cache[require.resolve(path.join(__dirname, '../../api/_domain/' + m))]; } catch {}
    });

    require.cache[rlPath] = {
      id: rlPath, filename: rlPath, loaded: true,
      exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
    };
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: {
        getDb:     () => sqlFn,
        getArtist: async (slug) => ({ id: 1, slug, name: 'Test', config: {}, password_hash: 'hash' }),
        getSlug:   (req) => (req.query && req.query.artist) || 'test',
      },
    };
    require.cache[emailPath] = {
      id: emailPath, filename: emailPath, loaded: true,
      exports: { sendEmail: emailFn || (async () => {}) },
    };

    return require(path.join(__dirname, '../../api/config'));
  }

  function mockRes() {
    const res = { _status: 200, _redirected: null };
    res.status    = (s) => { res._status = s; return res; };
    res.json      = (b) => { res._body = b; return res; };
    res.setHeader = () => res;
    res.redirect  = (code, url) => { res._status = code; res._redirected = url; return res; };
    return res;
  }

  // ── POST ?action=signup-link ────────────────────────────────────────────────
  console.log(B('\nPOST ?action=signup-link'));

  await testAsync('missing email → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup-link' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('invalid email → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup-link', email: 'notvalid' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('valid email → 200 + ok:true + email sent', async () => {
    let emailSent = false;
    const handler = makeHandler(async () => [], async () => { emailSent = true; });
    const res = mockRes();
    await handler({
      method: 'POST',
      body: { action: 'signup-link', email: 'test@example.com' },
      headers: { host: 'localhost:3000' },
    }, res);
    assertEq(res._status, 200);
    assertEq(res._body && res._body.ok, true);
    assert(emailSent, 'expected signup email to be sent');
  });

  // ── POST ?action=verify-signup-token ────────────────────────────────────────
  console.log(B('\nPOST ?action=verify-signup-token'));

  await testAsync('missing token → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'verify-signup-token' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('unknown token → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'verify-signup-token', token: 'deadbeef' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('valid token → 200 + { ok:true, email }', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sql = async function(strings) {
      if (String(strings[0]).includes('SELECT email')) {
        return [{ email: 'user@test.com', signup_token_hash: hash, signup_token_expires: expires }];
      }
      return [];
    };
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'verify-signup-token', token: rawToken }, headers: {} }, res);
    assertEq(res._status, 200);
    assertEq(res._body && res._body.ok, true);
    assertEq(res._body && res._body.email, 'user@test.com');
  });

  // ── POST ?action=signup ─────────────────────────────────────────────────────
  console.log(B('\nPOST ?action=signup'));

  await testAsync('missing token → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', name: 'My Band', slug: 'my-band' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('invalid slug format → 400', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sql = async function(strings) {
      if (String(strings[0]).includes('SELECT email')) {
        return [{ email: 'u@t.com', signup_token_hash: hash, signup_token_expires: expires }];
      }
      return [];
    };
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', token: rawToken, name: 'My Band', slug: 'MY BAND!!' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('taken slug → 409', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sql = async function(strings) {
      const q = String(strings[0]);
      if (q.includes('SELECT email'))  return [{ email: 'u@t.com', signup_token_hash: hash, signup_token_expires: expires }];
      if (q.includes('EXISTS'))        return [{ exists: true }];  // slug taken
      return [];
    };
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', token: rawToken, name: 'My Band', slug: 'taken-slug' }, headers: {} }, res);
    assertEq(res._status, 409);
  });

  await testAsync('valid signup → 201 + { ok, token, slug }', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sql = async function(strings) {
      const q = String(strings[0]);
      if (q.includes('SELECT email'))       return [{ email: 'u@t.com', signup_token_hash: hash, signup_token_expires: expires }];
      if (q.includes('EXISTS'))             return [{ exists: false }];  // slug available
      if (q.includes('INSERT INTO artists')) return [{ id: 10 }];
      if (q.includes('INSERT INTO users'))   return [{ id: 20 }];
      return [];
    };
    sql.begin = async fn => fn(sql);
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', token: rawToken, name: 'My Band', slug: 'my-band' }, headers: {} }, res);
    assertEq(res._status, 201);
    assertEq(res._body && res._body.ok, true);
    assertEq(res._body && res._body.slug, 'my-band');
    assert(typeof (res._body && res._body.token) === 'string', 'expected session token string');
  });

  // ── GET ?action=check-slug ──────────────────────────────────────────────────
  console.log(B('\nGET ?action=check-slug'));

  await testAsync('available slug → { available: true }', async () => {
    const sql = async () => [{ exists: false }];
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'new-band' }, headers: {} }, res);
    assertEq(res._body && res._body.available, true);
  });

  await testAsync('taken slug → { available: false }', async () => {
    const sql = async () => [{ exists: true }];
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'taken-band' }, headers: {} }, res);
    assertEq(res._body && res._body.available, false);
  });

  await testAsync('reserved slug "login" → { available: false }', async () => {
    const sql = async () => [{ exists: false }];
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'login' }, headers: {} }, res);
    assertEq(res._body && res._body.available, false);
  });

  // ── GET ?action=my-artists ──────────────────────────────────────────────────
  console.log(B('\nGET ?action=my-artists'));

  await testAsync('no token → 401', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'my-artists' }, headers: {} }, res);
    assertEq(res._status, 401);
  });

  await testAsync('valid token → 200 + artists array', async () => {
    const token   = generateUserToken(42, 'admin', TTL_8H);
    const artists = [{ slug: 'my-band', name: 'My Band', role: 'admin' }];
    const handler = makeHandler(async () => artists);
    const res = mockRes();
    await handler({
      method: 'GET',
      query:  { action: 'my-artists' },
      headers: { authorization: 'Bearer ' + token },
    }, res);
    assertEq(res._status, 200);
    assert(Array.isArray(res._body && res._body.artists), 'expected artists array');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
