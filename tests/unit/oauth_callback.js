'use strict';

// Signing in with Google on a multi-workspace deployment.
//
// The callback holds a session token by the time it redirects, but it used to
// hand that token to the browser in the `#magic=` slot. home.js then posted it
// to /api/:artist/auth as a magic token, where the handler looks the user up
// WITH `password_hash IS NOT NULL` and checks it with verifyMagicToken — an
// HMAC keyed on that password hash. A Google account has no password, and a
// user token is a different shape keyed on APP_SECRET, so the check could never
// pass. Every attempt ended on "Invalid or expired login link".
//
// It worked on the single-band deployments because those take the
// ARTIST_ADMIN_EMAIL fallback, which mints a real magic token. Only the
// multi-workspace branch was broken, and nobody had a public account until the
// day this was found.

const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

process.env.APP_SECRET           = process.env.APP_SECRET           || 'unit-test-secret-32-bytes-okayy!';
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';

const EMAIL = 'player@example.com';

function load({ user = { id: 7, role: 'admin' }, artists = [{ slug: 'band', name: 'Band' }] } = {}) {
  const dbPath    = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath    = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const idPath    = require.resolve(path.join(__dirname, '../../api/_domain/identity'));
  const tokenPath = require.resolve(path.join(__dirname, '../../api/_token'));

  const domainDir = path.join(__dirname, '../../api/_domain');
  require('fs').readdirSync(domainDir).filter(f => f.endsWith('.js')).forEach(f => {
    try { delete require.cache[require.resolve(path.join(domainDir, f))]; } catch {}
  });
  delete require.cache[dbPath];
  // Earlier files in the suite leave a stub of _token in the cache whose
  // generateUserToken returns a fixed string. Without evicting it, the handler
  // mints that string and these assertions check the stub instead of the real
  // token, which is exactly the kind of green-but-meaningless test this file
  // exists to prevent.
  delete require.cache[tokenPath];

  const sql = (strings) => {
    const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
    // Order matters: the workspace lookup also selects FROM users.
    if (/JOIN\s+artists/i.test(text)) return Promise.resolve(artists);
    if (/FROM\s+users/i.test(text))   return Promise.resolve(user ? [user] : []);
    return Promise.resolve(artists);
  };

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async slug => ({ id: 1, slug, name: 'Test', config: {} }),
      insertAuditLog: async () => {},
    },
  };

  // The real identity module would try to reach Google.
  const realIdentity = require(idPath);
  require.cache[idPath] = {
    id: idPath, filename: idPath, loaded: true,
    exports: {
      generateState:    realIdentity.generateState,
      verifyState:      realIdentity.verifyState,
      resolveOAuthEmail: async () => EMAIL,
    },
  };

  return {
    oauth: require(path.join(__dirname, '../../api/_domain/oauth')),
    state: realIdentity.generateState('google', 'login'),
    token: require(tokenPath),   // the real one, loaded after the eviction above
  };
}

function mockRes() {
  const r = {};
  r.status   = () => r;
  r.json     = (b) => { r._body = b; return r; };
  r.redirect = (code, url) => { r._code = code; r._url = url; return r; };
  return r;
}

function fragment(url) {
  return new URLSearchParams(String(url).split('#')[1] || '');
}

async function callback(opts) {
  const { oauth, state, token } = load(opts);
  const res = mockRes();
  await oauth.oauthCallback(
    { query: { code: 'auth-code', state }, headers: { host: 'app.smartist.studio' }, url: '/auth/callback' },
    res,
  );
  res._token = token;
  return res;
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nOAuth callback — the token handed to the browser'));

  // The bug in one assertion: a user token in the magic slot.
  await testAsync('an existing account is sent back with a session token, not a magic one', async () => {
    const res = await callback();
    const f = fragment(res._url);
    assert(!f.get('magic'),
      'the session token is in the #magic= slot, where home.js posts it to the ' +
      'password-based magic endpoint and it is rejected');
    assert(f.get('session'), `no session token in the redirect: ${res._url}`);
  });

  await testAsync('that token verifies as a user token', async () => {
    const res = await callback();
    const claims = res._token.verifyUserToken(fragment(res._url).get('session'));
    assert(claims, 'the emitted token does not verify with verifyUserToken');
    assertEq(claims.userId, 7);
    assertEq(claims.role, 'admin');
  });

  // Why the two slots must not be confused. This is the check auth.js runs on
  // anything arriving as `magic`, and it cannot pass for a user token whatever
  // the password hash is — which is what made the failure total rather than
  // occasional.
  await testAsync('a user token can never satisfy the magic-token check', async () => {
    const { token } = load();
    const userToken = token.generateUserToken(7, 'admin', 60_000);
    assertEq(token.verifyMagicToken(userToken, 'any-bcrypt-hash'), false);
  });

  await testAsync('the redirect keeps the destination workspace', async () => {
    const res = await callback();
    assertEq(fragment(res._url).get('next'), '/band/dashboard');
  });

  // Several workspaces: no single dashboard to land on, so the chooser. The old
  // code sent next=/home, and home.js derived artistSlug="home" from it and
  // called /api/home/auth — a workspace that does not exist.
  await testAsync('several workspaces send the visitor to the chooser', async () => {
    const res = await callback({ artists: [{ slug: 'one' }, { slug: 'two' }] });
    const f = fragment(res._url);
    assert(f.get('session'), 'no session token for a multi-workspace user');
    assertEq(f.get('next'), '/workspaces');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
