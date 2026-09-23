const path = require('path');

// Stub env vars before anything loads
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
process.env.FACEBOOK_APP_ID      = process.env.FACEBOOK_APP_ID      || 'test-fb-id';
process.env.FACEBOOK_APP_SECRET  = process.env.FACEBOOK_APP_SECRET  || 'test-fb-secret';
// oauth.js pulls in _token transitively, which demands APP_SECRET at load.
process.env.APP_SECRET           = process.env.APP_SECRET           || 'test-app-secret';

async function run(r) {
  const { test, testAsync, assert, assertEq, B } = r;

  const { generateState, verifyState, resolveOAuthEmail } = require(path.join(__dirname, '../../api/_domain/identity'));

  // Stubs Google's token + v2 userinfo endpoints (full real response shapes).
  async function withGoogleUserinfo(userinfo, fn) {
    const realFetch = global.fetch;
    global.fetch = async (url) => ({
      json: async () => (String(url).includes('oauth2.googleapis.com/token')
        ? { access_token: 'at', expires_in: 3599, token_type: 'Bearer', scope: 'openid email', id_token: 'id' }
        : userinfo),
    });
    try { return await fn(); } finally { global.fetch = realFetch; }
  }

  console.log(B('\nresolveOAuthEmail (google)'));

  // OAuth login maps the email to existing users rows, so an unverified address
  // on a Google account would log its holder into someone else's account.
  await testAsync('google: unverified email is not trusted', async () => {
    const email = await withGoogleUserinfo(
      { id: '1', email: 'victim@example.com', verified_email: false, picture: 'https://x/p.png' },
      () => resolveOAuthEmail('google', 'code', 'https://app/auth/callback'));
    assertEq(email, null);
  });

  await testAsync('google: verified email is returned', async () => {
    const email = await withGoogleUserinfo(
      { id: '1', email: 'owner@example.com', verified_email: true, picture: 'https://x/p.png' },
      () => resolveOAuthEmail('google', 'code', 'https://app/auth/callback'));
    assertEq(email, 'owner@example.com');
  });

  console.log(B('\ngenerateState / verifyState'));

  test('generateState returns base64url string', () => {
    const s = generateState('google', 'login');
    assert(typeof s === 'string' && s.length > 0, 'not a string');
    assert(!/[+=/]/.test(s), 'not base64url');
  });

  test('verifyState returns { provider, mode } for fresh valid state', () => {
    const s = generateState('google', 'login');
    const result = verifyState(s);
    assert(result !== null, 'expected non-null');
    assertEq(result.provider, 'google');
    assertEq(result.mode, 'login');
  });

  test('verifyState returns mode=signup when generated with signup', () => {
    const s = generateState('facebook', 'signup');
    const result = verifyState(s);
    assertEq(result.provider, 'facebook');
    assertEq(result.mode, 'signup');
  });

  test('verifyState returns null for tampered state', () => {
    const s = generateState('google', 'login');
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString());
    parsed.mode = 'signup'; // tamper without re-signing
    const tampered = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    assertEq(verifyState(tampered), null);
  });

  test('verifyState returns null for expired token (valid sig, past expiry)', () => {
    // Build a validly-signed token with an already-expired timestamp.
    // We must sign it ourselves because generateState always uses Date.now() + TTL.
    const nonce   = 'aabbccddee1122334455';
    const expires = Date.now() - 1000; // 1 second in the past
    const mode    = 'login';
    const provider = 'google';
    const secret  = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
    const crypto  = require('crypto');
    const msg = `${provider}:${nonce}:${expires}:${mode}`;
    const sig = crypto.createHmac('sha256', secret).update(msg).digest('hex');
    const expired = Buffer.from(JSON.stringify({ provider, nonce, expires, mode, sig })).toString('base64url');
    assertEq(verifyState(expired), null);
  });

  test('verifyState returns null for garbage string', () => {
    assertEq(verifyState('not-valid'), null);
  });

  test('verifyState returns null for null/empty', () => {
    assertEq(verifyState(null), null);
    assertEq(verifyState(''), null);
  });

  test('mode defaults to login when not provided', () => {
    const s = generateState('google');
    const result = verifyState(s);
    assertEq(result.mode, 'login');
  });

  console.log(B('\nresolveOAuthEmail (facebook)'));

  // Captures every URL the facebook branch requests, so the tests can assert on
  // what we actually send rather than on what we meant to send.
  async function withFacebookGraph(meBody, fn) {
    const realFetch = global.fetch;
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      return {
        json: async () => (String(url).includes('/oauth/access_token')
          ? { access_token: 'fb-token', token_type: 'bearer', expires_in: 5183944 }
          : meBody),
      };
    };
    try { return { result: await fn(), urls }; } finally { global.fetch = realFetch; }
  }

  const meUrl = (urls) => urls.find(u => u.includes('/me'));

  await testAsync('facebook: the email is returned', async () => {
    const { result } = await withFacebookGraph(
      { id: '77', email: 'player@example.com' },
      () => resolveOAuthEmail('facebook', 'code', 'https://app/auth/callback'));
    assertEq(result, 'player@example.com');
  });

  // Facebook omits the field entirely when it has no confirmed address, so a
  // missing email is the documented "do not trust this" signal.
  await testAsync('facebook: a missing email yields null', async () => {
    const { result } = await withFacebookGraph(
      { id: '77' },
      () => resolveOAuthEmail('facebook', 'code', 'https://app/auth/callback'));
    assertEq(result, null);
  });

  // Meta's security checklist: "Sign all server-to-server Graph API calls with
  // your App Secret." The proof is a sha256 HMAC of `<token>|<unix seconds>`.
  await testAsync('facebook: the /me call is signed with appsecret_proof', async () => {
    const crypto = require('crypto');
    const { urls } = await withFacebookGraph(
      { id: '77', email: 'player@example.com' },
      () => resolveOAuthEmail('facebook', 'code', 'https://app/auth/callback'));

    const url = new URL(meUrl(urls));
    const time = url.searchParams.get('appsecret_time');
    assert(/^\d+$/.test(time || ''), `appsecret_time missing or not an integer: ${time}`);

    const expected = crypto
      .createHmac('sha256', process.env.FACEBOOK_APP_SECRET)
      .update(`fb-token|${time}`)
      .digest('hex');
    assertEq(url.searchParams.get('appsecret_proof'), expected);
  });

  // An unversioned Graph call resolves to the oldest version still live and
  // changes behaviour under us without any code change.
  await testAsync('facebook: both Graph calls name an explicit API version', async () => {
    const { urls } = await withFacebookGraph(
      { id: '77', email: 'player@example.com' },
      () => resolveOAuthEmail('facebook', 'code', 'https://app/auth/callback'));
    for (const u of urls) {
      assert(/graph\.facebook\.com\/v\d+\.\d+\//.test(u), `unversioned Graph call: ${u}`);
    }
  });

  console.log(B('\nfacebookUrl (login dialog)'));

  function mockRes() {
    const r = { _status: 200 };
    r.status = (s) => { r._status = s; return r; };
    r.json   = (b) => { r._body  = b; return r; };
    return r;
  }

  async function dialogUrl() {
    const { facebookUrl } = require(path.join(__dirname, '../../api/_domain/oauth'));
    const res = mockRes();
    await facebookUrl({ query: {}, headers: {}, url: '/api/config' }, res);
    return res._body && res._body.url;
  }

  // email is the ONLY permission we ask for and the whole login depends on it.
  // Meta will not re-ask for a permission someone has declined unless told to,
  // so without this one untick locks that person out of Facebook login for good.
  await testAsync('facebook: the dialog re-asks for a declined email permission', async () => {
    const url = new URL(await dialogUrl());
    assertEq(url.searchParams.get('auth_type'), 'rerequest');
  });

  await testAsync('facebook: the dialog names an explicit API version', async () => {
    const url = await dialogUrl();
    assert(/facebook\.com\/v\d+\.\d+\//.test(url), `unversioned dialog URL: ${url}`);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
