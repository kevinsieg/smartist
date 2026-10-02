'use strict';

// Regression coverage for the postgres.js transaction API. The driver is
// postgres.js (api/_db.js), whose transaction primitive is sql.begin(fn) — it
// has NO sql.transaction([...]) (that is the Neon serverless driver). These
// tests drive the two handlers that run multi-statement writes through a sql
// stub exposing only .begin, so a regression back to sql.transaction() would
// throw (→ 500) and fail here.

const path = require('path');
const { makeRunner, stubLogger, viaRouter } = require('./_runner');

stubLogger();

const ARTIST = { id: 1, slug: 'test', name: 'Test Band' };

function mp(rel) { return require.resolve(path.join(__dirname, '../..', rel)); }

function mockRes() {
  const r = { statusCode: 200, headersSent: false };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; r.headersSent = true; return r; };
  r.setHeader = () => {};
  return r;
}

// Tagged-template sql stub with .begin(fn) — fn runs against the same stub so
// statements issued on the transaction handle route through the same matcher.
function makeSql(route) {
  const calls = [];
  const sql = async (strings) => {
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    calls.push(text);
    return route(text);
  };
  // Like postgres.js: a callback that returns an array of queries gets them
  // run in order, and begin resolves to their results.
  sql.begin = async fn => { const r = await fn(sql); return Array.isArray(r) ? Promise.all(r) : r; };
  sql.calls = calls;
  return sql;
}

function loadHandler(rel, route, user = { id: 1, role: 'member' }) {
  const dbPath = mp('api/_db'), authPath = mp('api/_auth'), r2Path = mp('api/_r2');
  const handlerPath = mp(rel);
  for (const p of [dbPath, authPath, handlerPath]) delete require.cache[p];
  const sql = makeSql(route);
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async () => ARTIST,
      getSlug: req => req.query?.artist || 'test',
      insertAuditLog: async () => {}, trimSongLogs: async () => {},
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { refuseDemo: (req, res) => { if (req.user && req.user.id === null) { res.status(403).json({ error: 'demo' }); return true; } return false; },
      requireAuth: async req => { req.user = user; return ARTIST; },
      getAccess: async () => ({ artist: ARTIST, user }),
      // Handlers ask these directly now; a stub that omits them throws.
      canBrowseCatalogue: () => false,
      canOpenStage: () => true,
      requireRole: () => true,
    },
  };
  require.cache[r2Path] = {
    id: r2Path, filename: r2Path, loaded: true,
    exports: {
      createPresignedUrl: async () => ({}), deleteFromR2: async () => {},
      verifyUpload: async () => ({}), keyFromUrl: () => 'k',
    },
  };
  return { handler: viaRouter(path.join(__dirname, '../..', rel)), sql };
}

async function run(r) {
  const { testAsync, assert, assertEq } = r;

  console.log(r.B('\ntransaction handlers (sql.begin)'));

  await testAsync('gig hard delete commits in a transaction → 200', async () => {
    const { handler } = loadHandler('api/_band/gigs.js',
      text => (text.startsWith('SELECT * FROM gigs') ? [{ id: 5, artist_id: 1 }] : []));
    const res = mockRes();
    await handler({ method: 'DELETE', url: '/api/test/gigs/5',
      body: { hard: true }, headers: { authorization: 'Bearer t' } }, res);
    assertEq(res.statusCode, 200);
    assertEq(res.body, { deleted: true, hard: true });
  });

  await testAsync('gig hard delete with cascade removes setlists then the gig', async () => {
    const { handler, sql } = loadHandler('api/_band/gigs.js',
      text => (text.startsWith('SELECT * FROM gigs') ? [{ id: 5 }] : []));
    const res = mockRes();
    await handler({ method: 'DELETE', url: '/api/test/gigs/5',
      body: { hard: true, cascade: ['setlists'] }, headers: { authorization: 'Bearer t' } }, res);
    assertEq(res.statusCode, 200);
    assert(sql.calls.some(t => t.startsWith('DELETE FROM setlists')), 'expected setlists delete');
    assert(sql.calls.some(t => t.startsWith('DELETE FROM gigs')), 'expected gig delete');
  });

  await testAsync('arrangement activate commits in a transaction → 200', async () => {
    const { handler, sql } = loadHandler('api/_band/songs/item.js', text => {
      if (text.startsWith('UPDATE song_arrangements SET is_active = true')) return [{ id: 3, is_active: true, rows: [] }];
      return [];
    });
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/songs/10/arrangements/3/activate',
      query: { artist: 'test' }, body: {}, headers: { authorization: 'Bearer t' } }, res);
    assertEq(res.statusCode, 200);
    assertEq(res.body.is_active, true);
    // At most one active version per song (unique index): the others are
    // switched off first, in the same transaction.
    const updates = sql.calls.filter(c => c.startsWith('UPDATE song_arrangements'));
    assertEq(updates.length, 2);
    assert(updates[0].includes('is_active = false'), 'deactivation must come first');
  });

  await testAsync('activating an unknown arrangement → 404', async () => {
    const { handler } = loadHandler('api/_band/songs/item.js', () => []);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/songs/10/arrangements/99/activate',
      query: { artist: 'test' }, body: {}, headers: { authorization: 'Bearer t' } }, res);
    assertEq(res.statusCode, 404);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
