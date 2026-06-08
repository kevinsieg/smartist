'use strict';

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
  return {
    method,
    url,
    query: { artist: ARTIST.slug, ...query },
    headers,
    body,
  };
}

function loadHandler(relPath, { sqlFn = async () => [] } = {}) {
  process.env.APP_SECRET = SECRET;
  process.env.ARTIST_SLUG = ARTIST.slug;

  const dbPath = modulePath('api/_db');
  const authPath = modulePath('api/_auth');
  const tokenPath = modulePath('api/_token');
  const handlerPath = modulePath(relPath);
  const rlPath = modulePath('api/_ratelimit');
  const emailPath = modulePath('api/_email');
  const aiPath = modulePath('api/_ai');
  const r2Path = modulePath('api/_r2');

  for (const p of [dbPath, authPath, tokenPath, handlerPath]) delete require.cache[p];

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1', isMissingRateLimitTable: () => false },
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
      getDb: () => sqlFn,
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
    tokenFor: role => tokenApi.generateUserToken(7, role, tokenApi.TTL_8H),
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

  await testAsync('viewer token is blocked before member song creation validation', async () => {
    const { handler, tokenFor } = loadHandler('api/[artist]/songs.js');
    const res = await call(handler, mockReq('POST', `/api/${ARTIST.slug}/songs`, {
      token: tokenFor('viewer'),
      body: {},
    }));
    assertEq(res.statusCode, 403);
    assertEq(res.body?.error, 'Forbidden');
  });

  await testAsync('member token passes member song gate and reaches validation', async () => {
    const { handler, tokenFor } = loadHandler('api/[artist]/songs.js');
    const res = await call(handler, mockReq('POST', `/api/${ARTIST.slug}/songs`, {
      token: tokenFor('member'),
      body: {},
    }));
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'title required');
  });

  await testAsync('signed token with unknown role is denied on member song route', async () => {
    const { handler, tokenFor } = loadHandler('api/[artist]/songs.js');
    const res = await call(handler, mockReq('POST', `/api/${ARTIST.slug}/songs`, {
      token: tokenFor('owner'),
      body: {},
    }));
    assertEq(res.statusCode, 403);
    assertEq(res.body?.error, 'Forbidden');
  });

  await testAsync('member token is blocked from admin user listing', async () => {
    const { handler, tokenFor } = loadHandler('api/[artist]/auth.js');
    const res = await call(handler, mockReq('GET', `/api/${ARTIST.slug}/auth`, {
      token: tokenFor('member'),
    }));
    assertEq(res.statusCode, 403);
    assertEq(res.body?.error, 'Forbidden');
  });

  await testAsync('admin token can list users through auth handler', async () => {
    const { handler, tokenFor } = loadHandler('api/[artist]/auth.js', {
      sqlFn: async () => [{ id: 7, email: 'admin@example.com', role: 'admin' }],
    });
    const res = await call(handler, mockReq('GET', `/api/${ARTIST.slug}/auth`, {
      token: tokenFor('admin'),
    }));
    assertEq(res.statusCode, 200);
    assertEq(res.body?.users?.[0]?.role, 'admin');
  });

  await testAsync('member token is blocked from admin config patch', async () => {
    const { handler, tokenFor } = loadHandler('api/config.js');
    const res = await call(handler, mockReq('PATCH', '/api/config', {
      token: tokenFor('member'),
      body: { name: 'Blocked' },
    }));
    assertEq(res.statusCode, 403);
    assertEq(res.body?.error, 'Forbidden');
  });

  await testAsync('admin token can patch config handler', async () => {
    const { handler, tokenFor } = loadHandler('api/config.js');
    const res = await call(handler, mockReq('PATCH', '/api/config', {
      token: tokenFor('admin'),
      body: {},
    }));
    assertEq(res.statusCode, 200);
    assertEq(res.body?.ok, true);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
