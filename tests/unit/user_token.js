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

  // Several deployments may share APP_SECRET; ids are per database, so a token
  // must not open the same user id in another deployment's database.
  test('a token minted for one database does not verify against another', () => {
    const saved = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = 'postgres://u:p@db-one.example/app';
      const tok = generateUserToken(5, 'admin', 60_000, null);
      assert(verifyUserToken(tok), 'verifies on its own database');
      process.env.DATABASE_URL = 'postgres://other:creds@db-one.example/app';
      assert(verifyUserToken(tok), 'rotated credentials keep sessions');
      process.env.DATABASE_URL = 'postgres://u:p@db-two.example/app';
      assertEq(verifyUserToken(tok), null, 'another database rejects it');
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    }
  });

  // The module loads without APP_SECRET (so the health check can report it);
  // signing throws, verifying fails closed.
  test('missing APP_SECRET: signing throws, verifying returns null', () => {
    const saved = process.env.APP_SECRET;
    const good = require(path.join(__dirname, '../../api/_token')).generateUserToken(1, 'admin', 60000);
    delete process.env.APP_SECRET;
    delete require.cache[require.resolve(path.join(__dirname, '../../api/_token'))];
    try {
      const tok = require(path.join(__dirname, '../../api/_token'));
      let threw = null;
      try { tok.generateUserToken(1, 'admin', 60000); } catch (e) { threw = e; }
      assert(threw && /APP_SECRET/.test(threw.message), `expected APP_SECRET error, got: ${threw && threw.message}`);
      assert(tok.verifyUserToken(good) === null, 'verify must fail closed');
    } finally {
      process.env.APP_SECRET = saved;
      delete require.cache[require.resolve(path.join(__dirname, '../../api/_token'))];
    }
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
