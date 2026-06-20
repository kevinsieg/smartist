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

  // Build a minimal res mock: status() returns this, json() captures body
  function mockRes() {
    let code = null;
    const res = {
      _body: null,
      statusCode: () => code,
      status(c) { code = c; return this; },
      json(body) { this._body = body; },
      setHeader() { return this; },
    };
    return res;
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

  // memberRows: what the membership query returns — defaults to a row matching
  // the token claim (user belongs to the artist with that role).
  function stubAuthDeps(tokenClaim, memberRows) {
    const rows = memberRows !== undefined ? memberRows
      : (tokenClaim ? [{ id: tokenClaim.userId, role: tokenClaim.role }] : []);
    require.cache[dbPath2] = {
      id: dbPath2, filename: dbPath2, loaded: true,
      exports: { getArtist: async () => FAKE_ARTIST, getDb: () => async () => rows },
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
    return require(path.join(__dirname, '../../api/_auth'));
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

  await r.testAsync('valid token but no membership in this workspace → null + 401', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 99, role: 'admin' }, []);
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband');
    assertEq(result, null);
    assertEq(res.statusCode(), 401);
  });

  await r.testAsync('role comes from the membership row, not the token', async () => {
    // Token claims admin, but the user is only a viewer in this workspace.
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'admin' }, [{ id: 1, role: 'viewer' }]);
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'member');
    assertEq(result, null);
    assertEq(res.statusCode(), 403);
  });

  // ── bootstrap auth disablement ───────────────────────────────────────────
  // Legacy ARTIST_ADMIN_EMAIL / artist-password auth must work only while the
  // workspace has no accepted named user, and survive a missing users table.
  function stubBootstrapDeps({ acceptedUsers = 0, magicOk = true, missingUsersTable = false } = {}) {
    const sqlFn = async (strings) => {
      const query = strings.join(' ');
      if (missingUsersTable && query.includes('FROM users')) {
        const err = new Error('relation "users" does not exist');
        err.code = '42P01';
        throw err;
      }
      if (query.includes('COUNT(*)')) return [{ count: acceptedUsers }];
      return [];
    };
    require.cache[dbPath2] = {
      id: dbPath2, filename: dbPath2, loaded: true,
      exports: { getArtist: async () => FAKE_ARTIST, getDb: () => sqlFn },
    };
    require.cache[tokenPath2] = {
      id: tokenPath2, filename: tokenPath2, loaded: true,
      exports: {
        verifyUserToken: () => null,
        verifyMagicToken: () => magicOk,
        generateMagicToken: () => '',
        generateUserToken: () => '',
        TTL_8H: 28800000, TTL_30D: 2592000000,
      },
    };
    delete require.cache[authPath];
    return require(path.join(__dirname, '../../api/_auth'));
  }

  console.log(B('\nbootstrap auth disablement'));

  await r.testAsync('bootstrap credential passes before any named user exists', async () => {
    const { requireAuth } = stubBootstrapDeps({ acceptedUsers: 0 });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer bootstrap-magic' } };
    const result = await requireAuth(req, res, 'testband', 'admin');
    assert(result !== null, 'expected artist object');
    assertEq(req.user, { id: null, role: 'admin' });
  });

  await r.testAsync('bootstrap credential denied once a named user exists → 401', async () => {
    const { requireAuth } = stubBootstrapDeps({ acceptedUsers: 1 });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer bootstrap-magic' } };
    const result = await requireAuth(req, res, 'testband', 'admin');
    assertEq(result, null);
    assertEq(res.statusCode(), 401);
  });

  await r.testAsync('missing users table keeps bootstrap credential available', async () => {
    const { requireAuth } = stubBootstrapDeps({ missingUsersTable: true });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer bootstrap-magic' } };
    const result = await requireAuth(req, res, 'testband', 'admin');
    assert(result !== null, 'expected artist object');
    assertEq(req.user, { id: null, role: 'admin' });
  });

  // ── login response includes artists list ─────────────────────────────────

  const FAKE_ARTISTS = [{ slug: 'testband', name: 'Test Band', role: 'admin' }];

  console.log(B('\n[artist]/auth — artists list in login response'));

  function stubAuthWithArtists() {
    const dbPath2    = require.resolve(path.join(__dirname, '../../api/_db'));
    const tokenPath2 = require.resolve(path.join(__dirname, '../../api/_token'));
    const authPath   = require.resolve(path.join(__dirname, '../../api/_auth'));
    const artistDomainPath = require.resolve(path.join(__dirname, '../../api/_domain/artist'));

    require.cache[dbPath2] = {
      id: dbPath2, filename: dbPath2, loaded: true,
      exports: {
        getArtist: async () => FAKE_ARTIST,
        getDb: () => {
          const sqlFn = async () => FAKE_ARTISTS;
          sqlFn.begin = async fn => fn(sqlFn);
          return sqlFn;
        },
        getSlug: (req) => (req.query && req.query.artist) || 'testband',
      },
    };
    require.cache[tokenPath2] = {
      id: tokenPath2, filename: tokenPath2, loaded: true,
      exports: {
        verifyUserToken: () => ({ userId: 1, role: 'admin' }),
        verifyMagicToken: () => false,
        generateMagicToken: () => '',
        generateUserToken: () => 'stub-session-token',
        TTL_8H: 28800000, TTL_30D: 2592000000,
      },
    };
    require.cache[artistDomainPath] = {
      id: artistDomainPath, filename: artistDomainPath, loaded: true,
      exports: {
        resolveArtist:     async () => FAKE_ARTIST,
        isSlugAvailable:   async () => true,
        getArtistsForUser: async () => FAKE_ARTISTS,
      },
    };
    delete require.cache[authPath];
    const handlerPath = require.resolve(path.join(__dirname, '../../api/[artist]/auth'));
    delete require.cache[handlerPath];
    return require(path.join(__dirname, '../../api/[artist]/auth'));
  }

  await r.testAsync('email+password login response includes artists array', async () => {
    const bcryptPath       = require.resolve('bcryptjs');
    const origBcrypt       = require.cache[bcryptPath];
    const artistDomPath    = require.resolve(path.join(__dirname, '../../api/_domain/artist'));
    const origArtistDomain = require.cache[artistDomPath];
    require.cache[bcryptPath] = {
      id: bcryptPath, filename: bcryptPath, loaded: true,
      exports: { compare: async () => true, hash: async () => '$2b$12$stubhash' },
    };
    const h = stubAuthWithArtists();
    const res = mockRes();
    const req = {
      method: 'POST',
      url: '/api/testband/auth',
      headers: { 'content-type': 'application/json' },
      body: { email: 'admin@example.com', password: 'correct-password' },
      query: { artist: 'testband' },
    };
    await h(req, res);
    require.cache[bcryptPath] = origBcrypt;
    // Restore domain module so subsequent tests in the suite get the real implementation
    if (origArtistDomain) require.cache[artistDomPath] = origArtistDomain;
    else delete require.cache[artistDomPath];
    assert(res._body && Array.isArray(res._body.artists), 'expected artists array in login response');
    assertEq(res._body.artists.length, 1);
    assertEq(res._body.artists[0].slug, 'testband');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
