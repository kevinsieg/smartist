const path = require('path');

function run(r) {
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

  test('missing req.user defaults to admin (bootstrap compat)', () => {
    assertEq(requireRole({}, mockRes(), 'admin'), true);
  });
  test('req.user.id=null (bootstrap) with role admin still passes', () => {
    assertEq(requireRole({ user: { id: null, role: 'admin' } }, mockRes(), 'admin'), true);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
