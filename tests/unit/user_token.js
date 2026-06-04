const path = require('path');

function run(r) {
  const { test, assert, assertEq, B } = r;

  // Reload _token with test secret isolated to this suite
  process.env.APP_SECRET = 'test-secret-exactly-32-bytes-ok!';
  delete require.cache[require.resolve(path.join(__dirname, '../../api/_token'))];
  const { generateUserToken, verifyUserToken } =
    require(path.join(__dirname, '../../api/_token'));

  console.log(B('\ngenerateUserToken / verifyUserToken'));

  // Round-trip
  test('produces a base64url string', () => {
    const tok = generateUserToken(42, 'admin', 8 * 60 * 60 * 1000);
    assert(typeof tok === 'string' && tok.length > 10, 'expected a non-empty string');
  });
  test('valid token verifies and returns claims', () => {
    const tok = generateUserToken(42, 'admin', 8 * 60 * 60 * 1000);
    const claim = verifyUserToken(tok);
    assert(claim !== null, 'expected non-null claim');
    assertEq(claim.userId, 42, 'userId preserved');
    assertEq(claim.role, 'admin', 'role preserved');
  });

  // Expired
  test('expired token (negative ttl) is rejected', () => {
    const tok = generateUserToken(1, 'member', -1000);
    assertEq(verifyUserToken(tok), null, 'expected null for expired token');
  });

  // Tampered
  test('tampered token (last 4 chars replaced) is rejected', () => {
    const tok = generateUserToken(1, 'viewer', 8 * 60 * 60 * 1000);
    assertEq(verifyUserToken(tok.slice(0, -4) + 'ZZZZ'), null, 'expected null for tampered token');
  });

  // Null / garbage
  test('null input is rejected', () => {
    assertEq(verifyUserToken(null), null, 'expected null for null input');
  });
  test('garbage string is rejected', () => {
    assertEq(verifyUserToken('notatoken'), null, 'expected null for garbage string');
  });

  // Wrong secret — reload module with different secret
  test('token from different secret is rejected', () => {
    const tok = generateUserToken(1, 'admin', 8 * 60 * 60 * 1000);
    process.env.APP_SECRET = 'different-secret-32-bytes-here!!';
    delete require.cache[require.resolve(path.join(__dirname, '../../api/_token'))];
    const { verifyUserToken: verifyWrong } =
      require(path.join(__dirname, '../../api/_token'));
    assertEq(verifyWrong(tok), null, 'expected null for wrong secret');
    // Restore
    process.env.APP_SECRET = 'test-secret-exactly-32-bytes-ok!';
    delete require.cache[require.resolve(path.join(__dirname, '../../api/_token'))];
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
