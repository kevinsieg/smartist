'use strict';

// gigs.js serves both the collection and a single gig: /api/:artist/gigs/:id is rewritten
// to /api/:artist/gigs?id=:id so the two handlers fit in one serverless function
// (Hobby plan caps at 12). These tests pin the routing and the id parsing, including the
// vercel dev case where req.query is not populated.

const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

const ARTIST = { id: 1, slug: 'test', name: 'Test Band', config: { plan: 'pro' } };
const GIG = { id: 7, artist_id: 1, title: 'Open Stage', date: '2026-05-01', deleted: false };

// The columns an INSERT/UPDATE writes through sql({ … }).
const written = c => (c.values.find(v => v && v.helper) || {}).helper || {};

function mp(rel) { return require.resolve(path.join(__dirname, '../..', rel)); }

function mockRes() {
  const r = { statusCode: 200, headersSent: false };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; r.headersSent = true; return r; };
  r.setHeader = () => {};
  return r;
}

function loadHandler(route) {
  const dbPath = mp('api/_db'), authPath = mp('api/_auth'), r2Path = mp('api/_r2');
  const handlerPath = mp('api/_band/gigs.js');
  for (const p of [dbPath, authPath, handlerPath]) delete require.cache[p];
  const calls = [];
  const sql = (strings, ...values) => {
    // sql({ col: value }) — the insert/update helper: keep the object.
    if (strings && typeof strings === 'object' && !Array.isArray(strings)) return { helper: strings };
    if (!Array.isArray(strings)) return { fragment: String(strings) };
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    return Promise.resolve(route(text));
  };
  sql.begin = async fn => fn(sql);
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async () => ARTIST,
      getSlug: req => req.query?.artist || req.url.split('?')[0].split('/')[2],
      insertAuditLog: async () => {},
      parsePage: () => ({ limit: 50, offset: 0 }),
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { refuseDemo: (req, res) => { if (req.user && req.user.id === null) { res.status(403).json({ error: 'demo' }); return true; } return false; },
      requireAuth: async req => { req.user = { id: 1, role: 'member' }; return ARTIST; },
      getAccess: async () => ({ artist: ARTIST, user: { id: 1, role: 'member' } }),
      // Handlers ask these directly now; a stub that omits them throws.
      canBrowseCatalogue: () => false,
      canOpenStage: () => true,
    },
  };
  require.cache[r2Path] = {
    id: r2Path, filename: r2Path, loaded: true,
    exports: {
      createPresignedUrl: async () => ({ uploadUrl: 'u', publicUrl: 'p' }),
      deleteFromR2: async () => {}, verifyUpload: async () => ({ size: 1, contentType: 'image/jpeg' }),
      keyFromUrl: () => 'k', filenameFromUrl: () => 'f',
    },
  };
  return { handler: require(path.join(__dirname, '../..', 'api/_band/gigs.js')), calls };
}

async function call(handler, method, url, { query = {}, body } = {}) {
  const res = mockRes();
  await handler({ method, url, query: { artist: 'test', ...query }, headers: {}, body }, res);
  return res;
}

async function run(r) {
  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\ngig handlers (collection + single gig in one function)'));

  await testAsync('GET with an id returns that gig', async () => {
    const { handler } = loadHandler(text => (text.includes('FROM gigs g') ? [GIG] : []));
    const res = await call(handler, 'GET', '/api/test/gigs?id=7', { query: { id: '7' } });
    assertEq(res.statusCode, 200);
    assertEq(res.body?.id, 7);
  });

  await testAsync('GET without an id still lists gigs', async () => {
    const { handler } = loadHandler(() => [{ ...GIG, total: 1 }]);
    const res = await call(handler, 'GET', '/api/test/gigs');
    assertEq(res.statusCode, 200);
    assert(Array.isArray(res.body?.rows), 'collection response should have rows');
  });

  await testAsync('id is taken from the URL when req.query is not populated (vercel dev)', async () => {
    const { handler } = loadHandler(text => (text.includes('FROM gigs g') ? [GIG] : []));
    const res = await call(handler, 'GET', '/api/test/gigs/7');
    assertEq(res.statusCode, 200);
    assertEq(res.body?.id, 7);
  });

  await testAsync('a non-numeric id is rejected', async () => {
    const { handler } = loadHandler(() => []);
    const res = await call(handler, 'GET', '/api/test/gigs/abc', { query: { id: 'abc' } });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'Invalid gig id');
  });

  await testAsync('an unknown gig is a 404, not an empty 200', async () => {
    const { handler } = loadHandler(() => []);
    const res = await call(handler, 'GET', '/api/test/gigs?id=999', { query: { id: '999' } });
    assertEq(res.statusCode, 404);
  });

  await testAsync('PUT updates the gig the id points at', async () => {
    const { handler, calls } = loadHandler(text =>
      (text.startsWith('SELECT * FROM gigs') ? [GIG] : [{ ...GIG, title: 'Renamed' }]));
    const res = await call(handler, 'PUT', '/api/test/gigs?id=7', { query: { id: '7' }, body: { title: 'Renamed' } });
    assertEq(res.statusCode, 200);
    const update = calls.find(c => c.text.startsWith('UPDATE gigs'));
    assert(update, 'no UPDATE issued');
    assertEq(written(update), { title: 'Renamed' }, 'only the title is written');
  });

  await testAsync('POST without an id creates a gig', async () => {
    const { handler, calls } = loadHandler(() => [GIG]);
    const res = await call(handler, 'POST', '/api/test/gigs', { body: { title: 'New gig' } });
    assertEq(res.statusCode, 201);
    assert(calls.some(c => c.text.startsWith('INSERT INTO gigs')), 'no INSERT issued');
  });

  await testAsync('DELETE soft-deletes the gig', async () => {
    const { handler, calls } = loadHandler(text =>
      (text.startsWith('SELECT * FROM gigs') ? [GIG] : [{ id: 7 }]));
    const res = await call(handler, 'DELETE', '/api/test/gigs?id=7', { query: { id: '7' } });
    assertEq(res.statusCode, 200);
    assert(calls.some(c => /UPDATE gigs SET deleted/.test(c.text)), 'no soft delete issued');
  });

  await testAsync('poster upload URL is still reachable on the merged route', async () => {
    const { handler } = loadHandler(text => (text.startsWith('SELECT * FROM gigs') ? [GIG] : []));
    const res = await call(handler, 'POST', '/api/test/gigs?id=7&action=poster-url',
      { query: { id: '7', action: 'poster-url' }, body: { contentType: 'image/jpeg', posterSize: 200000, thumbSize: 20000 } });
    assertEq(res.statusCode, 200);
    assert(res.body?.posterUploadUrl || res.body?.uploadUrl, 'no upload url returned');
  });

  // The sizes are signed into the URLs; without them one URL could park any
  // amount in the bucket (posters do not count towards the storage cap).
  await testAsync('poster upload URL needs both sizes, at most 5 MB', async () => {
    const { handler } = loadHandler(text => (text.startsWith('SELECT * FROM gigs') ? [GIG] : []));
    for (const body of [{ contentType: 'image/jpeg' }, { contentType: 'image/jpeg', posterSize: 6 * 1024 * 1024, thumbSize: 10 }]) {
      const res = await call(handler, 'POST', '/api/test/gigs?id=7&action=poster-url',
        { query: { id: '7', action: 'poster-url' }, body });
      assertEq(res.statusCode, 400);
    }
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
