const path = require('path');

async function run(r) {
  const { test, assert, assertEq, B } = r;

  // requireRole is the only thing we need from _auth.js
  // We must stub _db and _token before requiring _auth to avoid DB connection
  const dbPath     = require.resolve(path.join(__dirname, '../../api/_db'));
  const tokenPath  = require.resolve(path.join(__dirname, '../../api/_token'));
  if (!require.cache[dbPath]) {
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
      exports: { getArtist: async () => null, getDb: () => null } };
  }
  // Ensure APP_SECRET is set so _token imports cleanly
  process.env.APP_SECRET = process.env.APP_SECRET || 'unit-test-placeholder-secret!!';
  const { requireRole } = require(path.join(__dirname, '../../api/_auth'));

  // Build a minimal res mock: status() returns this, json() is a no-op
  function mockRes() {
    let code = null;
    return {
      statusCode: () => code,
      status(c) { code = c; return this; },
      json() {},
    };
  }

  console.log(B('\nrequireRole'));

  test('admin passes viewer', () => {
    assertEq(requireRole({ user: { id: 1, role: 'admin' } }, mockRes(), 'viewer'), true);
  });
  test('admin passes member', () => {
    assertEq(requireRole({ user: { id: 1, role: 'admin' } }, mockRes(), 'member'), true);
  });
  test('admin passes admin', () => {
    assertEq(requireRole({ user: { id: 1, role: 'admin' } }, mockRes(), 'admin'), true);
  });

  test('member passes viewer', () => {
    assertEq(requireRole({ user: { id: 1, role: 'member' } }, mockRes(), 'viewer'), true);
  });
  test('member passes member', () => {
    assertEq(requireRole({ user: { id: 1, role: 'member' } }, mockRes(), 'member'), true);
  });
  test('member fails admin → false + 403', () => {
    const res = mockRes();
    assertEq(requireRole({ user: { id: 1, role: 'member' } }, res, 'admin'), false);
    assertEq(res.statusCode(), 403);
  });

  test('viewer passes viewer', () => {
    assertEq(requireRole({ user: { id: 1, role: 'viewer' } }, mockRes(), 'viewer'), true);
  });
  test('viewer fails member → false + 403', () => {
    const res = mockRes();
    assertEq(requireRole({ user: { id: 1, role: 'viewer' } }, res, 'member'), false);
    assertEq(res.statusCode(), 403);
  });
  test('viewer fails admin → false + 403', () => {
    const res = mockRes();
    assertEq(requireRole({ user: { id: 1, role: 'viewer' } }, res, 'admin'), false);
    assertEq(res.statusCode(), 403);
  });

  test('missing req.user defaults to viewer → denied on admin route', () => {
    const res = mockRes();
    assertEq(requireRole({}, res, 'admin'), false);
    assertEq(res.statusCode(), 403);
  });
  test('req.user.id=null (bootstrap) with role admin still passes', () => {
    assertEq(requireRole({ user: { id: null, role: 'admin' } }, mockRes(), 'admin'), true);
  });

  // ── requireAuth with minRole ─────────────────────────────────────────────────
  const { stubLogger } = require('./_runner');
  stubLogger();

  const dbPath2    = require.resolve(path.join(__dirname, '../../api/_db'));
  const tokenPath2 = require.resolve(path.join(__dirname, '../../api/_token'));
  const authPath   = require.resolve(path.join(__dirname, '../../api/_auth'));

  const FAKE_ARTIST = { id: 1, slug: 'testband', name: 'Test Band', password_hash: '$2b$12$fakehash' };

  function makeSql(rows) {
    const sql = async (strings, ...values) => {
      sql.calls.push({ strings, values });
      return rows;
    };
    sql.calls = [];
    return sql;
  }

  function stubAuthDeps(tokenClaim, userRows) {
    const rows = userRows === undefined && tokenClaim
      ? [{ id: Number(tokenClaim.userId), role: tokenClaim.role }]
      : (userRows || []);
    const sql = makeSql(rows);
    require.cache[dbPath2] = {
      id: dbPath2, filename: dbPath2, loaded: true,
      exports: { getArtist: async () => FAKE_ARTIST, getDb: () => sql },
    };
    require.cache[tokenPath2] = {
      id: tokenPath2, filename: tokenPath2, loaded: true,
      exports: {
        verifyUserToken: () => tokenClaim,
        verifyMagicToken: () => false,
        generateMagicToken: () => '',
        generateUserToken: () => '',
        TTL_8H: 28800000, TTL_30D: 2592000000,
      },
    };
    delete require.cache[authPath];
    return { ...require(path.join(__dirname, '../../api/_auth')), sql };
  }

  console.log(B('\nrequireAuth minRole'));

  await r.testAsync('viewer blocked from member-gated route → null + 403', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'viewer' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'member');
    assertEq(result, null);
    assertEq(res.statusCode(), 403);
  });

  await r.testAsync('member passes member-gated route → artist returned', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'member' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'member');
    assert(result !== null, 'expected artist object');
    assertEq(result.slug, 'testband');
  });

  await r.testAsync('admin passes admin-gated route → artist returned', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'admin' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'admin');
    assert(result !== null, 'expected artist object');
  });

  await r.testAsync('member blocked from admin-gated route → null + 403', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'member' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'admin');
    assertEq(result, null);
    assertEq(res.statusCode(), 403);
  });

  await r.testAsync('no minRole: viewer passes (backward compat) → artist returned', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'viewer' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband');
    assert(result !== null, 'expected artist');
  });

  await r.testAsync('user token without current-artist user row is rejected', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 99, role: 'admin' }, []);
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'admin');
    assertEq(result, null);
    assertEq(res.statusCode(), 401);
  });

  await r.testAsync('current DB role overrides signed role claim', async () => {
    const { requireAuth } = stubAuthDeps(
      { userId: 1, role: 'admin' },
      [{ id: 1, role: 'viewer' }],
    );
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'member');
    assertEq(result, null);
    assertEq(res.statusCode(), 403);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
