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
// It worked on the single-band deployments because those took the
// ARTIST_ADMIN_EMAIL fallback (since removed), which minted a real magic token. Only the
// multi-workspace branch was broken, and nobody had a public account until the
// day this was found.

const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

process.env.APP_SECRET           = process.env.APP_SECRET           || 'unit-test-secret-32-bytes-okayy!';
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';

const EMAIL = 'player@example.com';

const logged = [];

function load({ user = { id: 7, role: 'admin' }, artists = [{ slug: 'band', name: 'Band' }], provider = 'google', invites = [] } = {}) {
  logged.length = 0;
  const logPath = require.resolve(path.join(__dirname, '../../api/_logger'));
  require.cache[logPath] = {
    id: logPath, filename: logPath, loaded: true,
    exports: {
      info:  async (event, data) => { logged.push({ level: 'info',  event, data }); },
      warn:  async (event, data) => { logged.push({ level: 'warn',  event, data }); },
      error: async (event, data) => { logged.push({ level: 'error', event, data }); },
    },
  };

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

  const updates = [];
  const sql = (strings) => {
    const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
    // Order matters: the workspace lookup also selects FROM users.
    // Accepting the open invites of an address with no account yet.
    if (/^\s*UPDATE\s+users/i.test(text)) { updates.push(text); return Promise.resolve(invites); }
    if (/JOIN\s+artists/i.test(text)) return Promise.resolve(artists);
    if (/FROM\s+users/i.test(text))   return Promise.resolve(user ? [user] : []);
    return Promise.resolve(artists);
  };

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { loginLocked: async () => false, countLoginFailure: async () => {}, checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async slug => ({ id: 1, slug, name: 'Test', config: {} }),
      insertAuditLog: async () => {}, trimSongLogs: async () => {},
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
    // Driven the way api/_config.js drives it: plain input through the adapter.
    oauth: { oauthCallback: require(path.join(__dirname, '../../api/_domain/http'))
      .handle(require(path.join(__dirname, '../../api/_domain/oauth')).oauthCallback) },
    state: realIdentity.generateState(provider, 'login', NONCE),
    token: require(tokenPath),   // the real one, loaded after the eviction above
    updates,
  };
}

// The nonce the OAuth start would have set as a cookie in this browser.
const NONCE = 'a'.repeat(32);

function mockRes() {
  const r = {};
  r.status   = () => r;
  r.json     = (b) => { r._body = b; return r; };
  r.redirect = (code, url) => { r._code = code; r._url = url; return r; };
  r.setHeader = (k, v) => { r._headers = { ...(r._headers || {}), [k]: v }; };
  return r;
}

function fragment(url) {
  return new URLSearchParams(String(url).split('#')[1] || '');
}

// The session the callback left in its oauth_session cookie, or null.
function sessionCookie(res) {
  const set = [].concat((res._headers || {})['Set-Cookie'] || []);
  const c = set.find(v => /^oauth_session=[^;]+/.test(v));
  return c ? c.slice('oauth_session='.length, c.indexOf(';')) : null;
}

async function callback(opts = {}, query, cookie = `oauth_nonce=${NONCE}`) {
  const { oauth, state, token, updates } = load(opts);
  const res = mockRes();
  await oauth.oauthCallback(
    {
      query: query ? query(state) : { code: 'auth-code', state },
      headers: { host: 'app.smartist.studio', ...(cookie ? { cookie } : {}) },
      url: '/auth/callback',
    },
    res,
  );
  res._token = token;
  res._updates = updates;
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
    assert(sessionCookie(res), `no session cookie set: ${JSON.stringify(res._headers)}`);
  });

  // Login CSRF: a URL carrying a session is a login link anyone can forward.
  await testAsync('no session token travels in the redirect URL', async () => {
    const res = await callback();
    const token = sessionCookie(res);
    assert(!String(res._url).includes(token), `the session is in the URL: ${res._url}`);
    assert(!fragment(res._url).get('session'), 'a #session= slot is back');
    assertEq(fragment(res._url).get('oauth'), '1');
  });

  await testAsync('the session cookie is HttpOnly, Strict, short-lived and API-only', async () => {
    const res = await callback();
    const c = [].concat(res._headers['Set-Cookie']).find(v => v.startsWith('oauth_session='));
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api', 'Max-Age=120'])
      assert(c.includes(attr), `missing ${attr}: ${c}`);
    assert([].concat(res._headers['Set-Cookie']).some(v => /^oauth_nonce=;.*Max-Age=0/.test(v)),
      'the nonce cookie is no longer cleared');
  });

  await testAsync('oauth-session hands the cookie\'s token over once and clears it', async () => {
    load();
    const { oauthSession } = require(path.join(__dirname, '../../api/_domain/oauth'));
    const got = await oauthSession({ headers: { cookie: 'a=b; oauth_session=tok.en-1_x; c=d' } });
    assertEq(got.status, 200);
    assertEq(got.body.token, 'tok.en-1_x');
    assert(/^oauth_session=;.*Max-Age=0/.test(got.headers['Set-Cookie']), 'cookie not cleared');
    const none = await oauthSession({ headers: {} });
    assertEq(none.status, 401);
    assert(!none.body.token, 'a token without a cookie');
  });

  await testAsync('that token verifies as a user token', async () => {
    const res = await callback();
    const claims = res._token.verifyUserToken(sessionCookie(res));
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
    assert(sessionCookie(res), 'no session token for a multi-workspace user');
    assertEq(f.get('next'), '/workspaces');
  });

  // "Continue with Google" on the login page, with an address that has no
  // account yet: it used to end on "Sign-in failed". The provider has shown
  // the visitor owns the address, so there is nothing to hide from them.
  await testAsync('a new address from the login page goes on to set up a workspace', async () => {
    const res = await callback({ user: null });
    assert(String(res._url).startsWith('https://app.smartist.studio/onboarding#token='),
      `expected onboarding, got ${res._url}`);
    assert(!sessionCookie(res), 'a session for an account that does not exist');
    assert(logged.some(l => l.event === 'oauth_signup_started'), 'signup start not logged');
  });

  // An address invited to a band but with no account yet: the provider has
  // shown it is theirs, so signing in accepts the invites, as the invite link
  // would. An existing account's invites stay open (see the next test).
  await testAsync('an invited address with no account signs in and joins its bands', async () => {
    const res = await callback({ user: null, invites: [{ id: 9, role: 'member', password_hash: null }] });
    assert(sessionCookie(res), 'no session for the invited address');
    assertEq(fragment(res._url).get('next'), '/band/dashboard');
    assertEq(res._updates.length, 1, 'invites accepted');
  });

  await testAsync('an existing account\'s open invites are not accepted by signing in', async () => {
    const res = await callback();
    assertEq(res._updates.length, 0);
  });

  await testAsync('an untrusted Facebook address accepts no invites', async () => {
    const saved = process.env.FACEBOOK_TRUST_EMAIL;
    delete process.env.FACEBOOK_TRUST_EMAIL;
    try {
      const res = await callback({ user: null, provider: 'facebook', invites: [{ id: 9, role: 'member', password_hash: null }] });
      assertEq(res._updates.length, 0);
      assertEq(res._url, 'https://app.smartist.studio/signup?error=verify_email');
    } finally { if (saved !== undefined) process.env.FACEBOOK_TRUST_EMAIL = saved; }
  });

  // Facebook does not say whether an address is verified. A workspace set up
  // under an address someone merely typed into Facebook would later reach every
  // band that invites the real owner, since memberships join on email.
  await testAsync('a new Facebook address is sent to the emailed signup instead', async () => {
    const saved = process.env.FACEBOOK_TRUST_EMAIL;
    delete process.env.FACEBOOK_TRUST_EMAIL;
    try {
      const res = await callback({ user: null, provider: 'facebook' });
      assertEq(res._url, 'https://app.smartist.studio/signup?error=verify_email');
      assert(!logged.some(l => l.event === 'oauth_signup_started'), 'a signup token was issued');
    } finally { if (saved !== undefined) process.env.FACEBOOK_TRUST_EMAIL = saved; }
  });

  await testAsync('with FACEBOOK_TRUST_EMAIL a new Facebook address sets up a workspace', async () => {
    const saved = process.env.FACEBOOK_TRUST_EMAIL;
    process.env.FACEBOOK_TRUST_EMAIL = 'true';
    try {
      const res = await callback({ user: null, provider: 'facebook' });
      assert(String(res._url).startsWith('https://app.smartist.studio/onboarding#token='), `got ${res._url}`);
    } finally { if (saved === undefined) delete process.env.FACEBOOK_TRUST_EMAIL; else process.env.FACEBOOK_TRUST_EMAIL = saved; }
  });

  console.log(B('\nOAuth callback — what the visitor is told, and what the log is told'));

  // Telling "no account for that address" apart from "your link expired" would
  // answer, to anyone who asks, whether an address has an account here. Both
  // answer identically; only the log distinguishes them.
  const failures = [
    ['an expired or forged state',  {},             () => ({ code: 'c', state: 'nonsense' }), 'invalid_or_expired_state'],
    ['a provider-side refusal',     {},             (s) => ({ error: 'access_denied', state: s }), 'provider_error:access_denied'],
    ['no code at all',              {},             (s) => ({ state: s }), 'missing_code_or_state'],
  ];

  for (const [label, opts, query, reason] of failures) {
    await testAsync(`${label} is answered with the same generic error`, async () => {
      const res = await callback(opts, query);
      assertEq(res._url, 'https://app.smartist.studio/login?oauth_error=1');
      assert(!/reason|email|account/i.test(res._url), `the URL leaks why: ${res._url}`);
    });

    await testAsync(`${label} is written to the log as "${reason}"`, async () => {
      await callback(opts, query);
      const entry = logged.find(l => l.event === 'oauth_callback_failed');
      assert(entry, `nothing logged; events were: ${logged.map(l => l.event).join(', ') || 'none'}`);
      assertEq(entry.data.reason, reason);
    });
  }

  console.log(B('\nOAuth callback — state belongs to this browser'));

  // Login CSRF: a callback URL minted for someone else's account, opened in a
  // browser that never started the flow, must not sign that browser in.
  await testAsync('a callback without the oauth_nonce cookie is refused', async () => {
    const res = await callback({}, undefined, null);
    assert(!sessionCookie(res), `signed in without the cookie: ${res._url}`);
    assert(String(res._url).includes('oauth_error=1'), `expected the error redirect, got ${res._url}`);
  });

  await testAsync('a callback with another flow\'s nonce is refused', async () => {
    const res = await callback({}, undefined, `oauth_nonce=${'b'.repeat(32)}`);
    assert(!sessionCookie(res), `signed in with a foreign nonce: ${res._url}`);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
