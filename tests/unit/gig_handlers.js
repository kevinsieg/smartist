'use strict';

// gigs.js serves both the collection and a single gig: the router sets `id` from
// /api/:artist/gigs/:id. These tests pin the routing and the id parsing.

const path = require('path');
const { makeRunner, stubLogger, viaRouter } = require('./_runner');

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

function loadHandler(route, r2 = {}) {
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
      insertAuditLog: async () => {}, trimSongLogs: async () => {},
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
      ...r2,
    },
  };
  const rlPath = mp('api/_ratelimit');
  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { ...require(rlPath), presignLimited: async () => false },
  };
  return { handler: viaRouter(path.join(__dirname, '../..', 'api/_band/gigs.js')), calls };
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
    const res = await call(handler, 'GET', '/api/test/gigs/7');
    assertEq(res.statusCode, 200);
    assertEq(res.body?.id, 7);
  });

  await testAsync('GET without an id still lists gigs', async () => {
    const { handler } = loadHandler(() => [{ ...GIG, total: 1 }]);
    const res = await call(handler, 'GET', '/api/test/gigs');
    assertEq(res.statusCode, 200);
    assert(Array.isArray(res.body?.rows), 'collection response should have rows');
  });

  await testAsync('a non-numeric id is rejected', async () => {
    const { handler } = loadHandler(() => []);
    const res = await call(handler, 'GET', '/api/test/gigs/abc');
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'Invalid gig id');
  });

  await testAsync('an unknown gig is a 404, not an empty 200', async () => {
    const { handler } = loadHandler(() => []);
    const res = await call(handler, 'GET', '/api/test/gigs/999');
    assertEq(res.statusCode, 404);
  });

  await testAsync('PUT updates the gig the id points at', async () => {
    const { handler, calls } = loadHandler(text =>
      (text.startsWith('SELECT * FROM gigs') ? [GIG] : [{ ...GIG, title: 'Renamed' }]));
    const res = await call(handler, 'PUT', '/api/test/gigs/7', { body: { title: 'Renamed' } });
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

  await testAsync('an unknown gig sub-resource is a 404, a wrong method a 405', async () => {
    const { handler, calls } = loadHandler(() => [GIG]);
    assertEq((await call(handler, 'GET', '/api/test/gigs/7/nothing')).statusCode, 404);
    assertEq((await call(handler, 'GET', '/api/test/gigs/7/poster')).statusCode, 405);
    assertEq((await call(handler, 'PUT', '/api/test/gigs/7/poster-url', { body: {} })).statusCode, 405);
    assertEq(calls.length, 0);
  });

  await testAsync('DELETE soft-deletes the gig', async () => {
    const { handler, calls } = loadHandler(text =>
      (text.startsWith('SELECT * FROM gigs') ? [GIG] : [{ id: 7 }]));
    const res = await call(handler, 'DELETE', '/api/test/gigs/7');
    assertEq(res.statusCode, 200);
    assert(calls.some(c => /UPDATE gigs SET deleted/.test(c.text)), 'no soft delete issued');
  });

  await testAsync('POST /gigs/:id/poster-url returns upload URLs', async () => {
    const { handler } = loadHandler(text => (text.startsWith('SELECT * FROM gigs') ? [GIG] : []));
    const res = await call(handler, 'POST', '/api/test/gigs/7/poster-url',
      { body: { contentType: 'image/jpeg', posterSize: 200000, thumbSize: 20000 } });
    assertEq(res.statusCode, 200);
    assert(res.body?.posterUploadUrl || res.body?.uploadUrl, 'no upload url returned');
  });

  // The sizes are signed into the URLs; without them one URL could park any
  // amount in the bucket (posters do not count towards the storage cap).
  await testAsync('poster upload URL needs both sizes, at most 5 MB', async () => {
    const { handler } = loadHandler(text => (text.startsWith('SELECT * FROM gigs') ? [GIG] : []));
    for (const body of [{ contentType: 'image/jpeg' }, { contentType: 'image/jpeg', posterSize: 6 * 1024 * 1024, thumbSize: 10 }]) {
      const res = await call(handler, 'POST', '/api/test/gigs/7/poster-url', { body });
      assertEq(res.statusCode, 400);
    }
  });

  // ── Posters: PUT confirms an upload, DELETE removes it ──────────────────────
  const OWN = 'https://cdn.example.test/gigs/test/7-a-poster.jpg';
  const OWN_THUMB = 'https://cdn.example.test/gigs/test/7-a-thumb.jpg';
  function posterR2(over = {}) {
    const seen = { verified: [], deleted: [] };
    const r2 = {
      keyFromUrl: u => String(u).replace('https://cdn.example.test/', ''),
      verifyUpload: async k => { seen.verified.push(k); return { size: 1, contentType: 'image/jpeg' }; },
      deleteFromR2: async u => { seen.deleted.push(u); },
      ...over,
    };
    return { r2, seen };
  }
  const gigRow = extra => text => (text.startsWith('SELECT * FROM gigs') ? [{ ...GIG, ...extra }] : []);

  await testAsync('PUT poster saves this gig\'s upload and removes the one it replaces', async () => {
    const { r2, seen } = posterR2();
    const { handler, calls } = loadHandler(gigRow({ poster_url: 'old-p', thumb_url: 'old-t' }), r2);
    const res = await call(handler, 'PUT', '/api/test/gigs/7/poster', { body: { posterUrl: OWN, thumbUrl: OWN_THUMB } });
    assertEq(res.statusCode, 200);
    const upd = calls.find(c => /UPDATE gigs SET poster_url/.test(c.text));
    assert(upd && upd.values.includes(OWN) && upd.values.includes(OWN_THUMB), 'poster not saved');
    assertEq(seen.deleted.sort(), ['old-p', 'old-t']);
  });

  await testAsync('PUT poster refuses another gig\'s or band\'s file before asking storage', async () => {
    for (const posterUrl of ['https://cdn.example.test/gigs/test/8-a-poster.jpg',
                             'https://cdn.example.test/gigs/other/7-a-poster.jpg',
                             'https://cdn.example.test/audio/1/x.mp3']) {
      const { r2, seen } = posterR2();
      const { handler, calls } = loadHandler(gigRow(), r2);
      const res = await call(handler, 'PUT', '/api/test/gigs/7/poster', { body: { posterUrl, thumbUrl: OWN_THUMB } });
      assertEq(res.statusCode, 400);
      assertEq(seen.verified, [], `storage asked about ${posterUrl}`);
      assert(!calls.some(c => c.text.startsWith('UPDATE')), 'wrote anyway');
    }
  });

  await testAsync('PUT poster needs both files, in storage, as JPEG', async () => {
    const cases = [
      [{ posterUrl: OWN }, {}],
      [{ posterUrl: OWN, thumbUrl: OWN_THUMB }, { verifyUpload: async () => null }],
      [{ posterUrl: OWN, thumbUrl: OWN_THUMB }, { verifyUpload: async () => ({ size: 1, contentType: 'image/png' }) }],
    ];
    for (const [body, over] of cases) {
      const { r2 } = posterR2(over);
      const { handler, calls } = loadHandler(gigRow(), r2);
      const res = await call(handler, 'PUT', '/api/test/gigs/7/poster', { body });
      assertEq(res.statusCode, 400);
      assert(!calls.some(c => c.text.startsWith('UPDATE')), 'wrote anyway');
    }
  });

  await testAsync('PUT poster on a deleted gig → 409', async () => {
    const { r2 } = posterR2();
    const { handler } = loadHandler(gigRow({ deleted: true }), r2);
    const res = await call(handler, 'PUT', '/api/test/gigs/7/poster', { body: { posterUrl: OWN, thumbUrl: OWN_THUMB } });
    assertEq(res.statusCode, 409);
  });

  await testAsync('DELETE poster removes both files and clears the columns', async () => {
    const { r2, seen } = posterR2();
    const { handler, calls } = loadHandler(gigRow({ poster_url: OWN, thumb_url: OWN_THUMB }), r2);
    const res = await call(handler, 'DELETE', '/api/test/gigs/7/poster');
    assertEq(res.statusCode, 200);
    assertEq(seen.deleted.sort(), [OWN, OWN_THUMB].sort());
    assert(calls.some(c => /SET poster_url = NULL, thumb_url = NULL/.test(c.text)), 'columns not cleared');
    assert(!calls.some(c => /SET deleted/.test(c.text)), 'deleted the gig');
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
