'use strict';

// Handler-level RBAC gates, exercised against the REAL _auth.js. The effective
// role is resolved from the workspace `users` row (per-workspace, revocable),
// NOT from the signed token claim — so role is driven through the stubbed
// membership query, and the token only proves identity (userId 7).

const fs = require('fs');
const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

const SECRET = 'rbac-handler-test-secret-32-bytes';
const ARTIST = { id: 1, slug: 'testband', name: 'Test Band', password_hash: '$2b$12$fakehash', config: {} };

function modulePath(rel) {
  return require.resolve(path.join(__dirname, '../..', rel));
}

function mockRes() {
  const res = { statusCode: 200, headers: {}, headersSent: false };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.headersSent = true; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  return res;
}

function mockReq(method, url, { token, body, query = {} } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return { method, url, query: { artist: ARTIST.slug, ...query }, headers, body };
}

// role → the role returned by the membership query in resolveUser (null = no
// row, i.e. token identity has no membership in this workspace). `rows` answers
// any other query the handler runs after auth passes.
function loadHandler(relPath, { role = 'admin', rows } = {}) {
  process.env.APP_SECRET = SECRET;
  process.env.ARTIST_SLUG = ARTIST.slug;

  const dbPath      = modulePath('api/_db');
  const authPath    = modulePath('api/_auth');
  const tokenPath   = modulePath('api/_token');
  const handlerPath = modulePath(relPath);
  const rlPath      = modulePath('api/_ratelimit');
  const emailPath   = modulePath('api/_email');
  const aiPath      = modulePath('api/_ai');
  const r2Path      = modulePath('api/_r2');

  // Re-require the handler and _auth fresh so the stubbed _db is picked up.
  for (const p of [dbPath, authPath, tokenPath, handlerPath]) delete require.cache[p];
  // Domain modules hold the _db they were first loaded with, too.
  for (const f of fs.readdirSync(path.join(__dirname, '../../api/_domain')))
    delete require.cache[modulePath(`api/_domain/${f}`)];

  // requireAuth reads the band and the caller's membership in one statement.
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (text.includes('JOIN users u2')) {
      if (!values.includes(ARTIST.slug)) return [];
      return [{ ...ARTIST, member_id: role ? 7 : null, member_role: role || null, member_password_hash: null }];
    }
    return rows ? rows(text, values) : [];
  };

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { loginLocked: async () => false, countLoginFailure: async () => {}, checkRateLimit: async () => false, clientIp: () => '127.0.0.1', isMissingRateLimitTable: () => false },
  };
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendEmail: async () => {} },
  };
  require.cache[aiPath] = {
    id: aiPath, filename: aiPath, loaded: true,
    exports: { suggestLyricsWithAI: async () => ({ lyrics: null, skipped: true }) },
  };
  require.cache[r2Path] = {
    id: r2Path, filename: r2Path, loaded: true,
    exports: {
      createPresignedUrl: async () => ({ uploadUrl: 'https://upload.example.test', publicUrl: 'https://cdn.example.test/file' }),
      deleteFromR2: async () => {},
      filenameFromUrl: url => String(url).split('/').pop(),
      keyFromUrl: () => 'key',
      verifyUpload: async () => ({ size: 1, contentType: 'audio/mpeg' }),
    },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async slug => (slug === ARTIST.slug ? ARTIST : null),
      getSlug: req => req.query?.artist || req.url.split('?')[0].split('/')[2],
      insertAuditLog: async () => {},
      parsePage: req => ({
        limit: Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200),
        offset: Math.max(parseInt(req.query?.offset, 10) || 0, 0),
      }),
    },
  };

  const tokenApi = require(path.join(__dirname, '../../api/_token'));
  return {
    handler: require(path.join(__dirname, '../..', relPath)),
    // Token only proves identity (userId 7); its role claim is intentionally ignored.
    token: tokenApi.generateUserToken(7, 'viewer', tokenApi.TTL_8H),
  };
}

async function call(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return res;
}

async function run(r) {
  const { testAsync, assertEq } = r;

  console.log(r.B('\nRBAC handler gates'));

  await testAsync('viewer is blocked before member song creation validation', async () => {
    const { handler, token } = loadHandler('api/_band/songs.js', { role: 'viewer' });
    const res = await call(handler, mockReq('POST', `/api/${ARTIST.slug}/songs`, { token, body: {} }));
    assertEq(res.statusCode, 403);
    assertEq(res.body?.error, 'Forbidden');
  });

  await testAsync('member passes the song gate and reaches validation', async () => {
    const { handler, token } = loadHandler('api/_band/songs.js', {
      role: 'member',
      rows: (text) => text.includes('count(*)') ? [{ count: 0 }] : [],
    });
    const res = await call(handler, mockReq('POST', `/api/${ARTIST.slug}/songs`, { token, body: {} }));
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'title required');
  });

  await testAsync('membership with an unknown role is denied on the member route', async () => {
    const { handler, token } = loadHandler('api/_band/songs.js', { role: 'owner' });
    const res = await call(handler, mockReq('POST', `/api/${ARTIST.slug}/songs`, { token, body: {} }));
    assertEq(res.statusCode, 403);
    assertEq(res.body?.error, 'Forbidden');
  });

  await testAsync('identity with no membership in this workspace is rejected → 401', async () => {
    const { handler, token } = loadHandler('api/_band/songs.js', { role: null });
    const res = await call(handler, mockReq('POST', `/api/${ARTIST.slug}/songs`, { token, body: {} }));
    assertEq(res.statusCode, 401);
  });

  await testAsync('member is blocked from admin user listing', async () => {
    const { handler, token } = loadHandler('api/_band/members.js', { role: 'member' });
    const res = await call(handler, mockReq('GET', `/api/${ARTIST.slug}/members`, { token }));
    assertEq(res.statusCode, 403);
    assertEq(res.body?.error, 'Forbidden');
  });

  await testAsync('admin can list users through the members handler', async () => {
    const { handler, token } = loadHandler('api/_band/members.js', {
      role: 'admin',
      rows: text => (text.includes('FROM users WHERE artist_id') ? [{ id: 7, email: 'admin@example.com', role: 'admin' }] : []),
    });
    const res = await call(handler, mockReq('GET', `/api/${ARTIST.slug}/members`, { token }));
    assertEq(res.statusCode, 200);
    assertEq(res.body?.users?.[0]?.role, 'admin');
  });

  await testAsync('member is blocked from admin config patch', async () => {
    const { handler, token } = loadHandler('api/_config.js', { role: 'member' });
    const res = await call(handler, mockReq('PATCH', '/api/_config', { token, body: { name: 'Blocked' } }));
    assertEq(res.statusCode, 403);
    assertEq(res.body?.error, 'Forbidden');
  });

  await testAsync('admin can patch the config handler', async () => {
    const { handler, token } = loadHandler('api/_config.js', { role: 'admin' });
    const res = await call(handler, mockReq('PATCH', '/api/_config', { token, body: {} }));
    assertEq(res.statusCode, 200);
    assertEq(res.body?.ok, true);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
