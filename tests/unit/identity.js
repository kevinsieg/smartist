const path = require('path');

// Stub env vars before anything loads
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
process.env.FACEBOOK_APP_ID      = process.env.FACEBOOK_APP_ID      || 'test-fb-id';
process.env.FACEBOOK_APP_SECRET  = process.env.FACEBOOK_APP_SECRET  || 'test-fb-secret';

async function run(r) {
  const { test, assert, assertEq, B } = r;

  const { generateState, verifyState } = require(path.join(__dirname, '../../api/_domain/identity'));

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

  test('verifyState returns null for expired state', () => {
    const s = generateState('google', 'login');
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString());
    parsed.expires = Date.now() - 1;
    const expired = Buffer.from(JSON.stringify(parsed)).toString('base64url');
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
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
