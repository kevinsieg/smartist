'use strict';

// Row ids are one sequence across every band. These tests pin the checks that
// keep one band's request from reaching another band's rows, the demo gate's
// session from being an admin one, and stored links from carrying script.

const path = require('path');
const crypto = require('crypto');
const { makeRunner, stubLogger, viaRouter } = require('./_runner');

stubLogger();
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-exactly-32-bytes-ok!';

const ARTIST = { id: 1, slug: 'test', name: 'Test Band', config: {} };

function mp(rel) { return require.resolve(path.join(__dirname, '../..', rel)); }

function mockRes() {
  const r = { statusCode: 200, headersSent: false };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; r.headersSent = true; return r; };
  r.setHeader = () => {};
  return r;
}

function makeSql(route) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    return route(text, values);
  };
  // Like postgres.js: begin resolves an array of queries to their results.
  sql.begin = async fn => { const r = await fn(sql); return Array.isArray(r) ? Promise.all(r) : r; };
  sql.json = v => ({ json: v });
  sql.calls = calls;
  return sql;
}

function loadHandler(rel, route, user = { id: 1, role: 'member' }) {
  const dbPath = mp('api/_db'), authPath = mp('api/_auth'), r2Path = mp('api/_r2');
  const handlerPath = mp(rel), ownPath = mp('api/_ownership');
  for (const p of [dbPath, authPath, r2Path, handlerPath, ownPath]) delete require.cache[p];
  const sql = makeSql(route);
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql, getArtist: async () => ARTIST,
      getSlug: () => 'test', insertAuditLog: async () => {}, trimSongLogs: async () => {},
      parsePage: () => ({ limit: 50, offset: 0 }),
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { refuseDemo: (req, res) => { if (req.user && req.user.id === null) { res.status(403).json({ error: 'demo' }); return true; } return false; },
      requireAuth: async req => { req.user = user; return ARTIST; },
      getAccess: async () => ({ artist: ARTIST, user }),
      canBrowseCatalogue: () => false, canOpenStage: () => true, requireRole: () => true,
    },
  };
  process.env.R2_PUBLIC_URL = 'https://media.example.test';
  require.cache[r2Path] = {
    id: r2Path, filename: r2Path, loaded: true,
    exports: {
      createPresignedUrl: async () => ({}), deleteFromR2: async () => true,
      verifyUpload: async () => ({ size: 1, contentType: 'audio/mpeg' }),
      filenameFromUrl: u => u,
      keyFromUrl: u => (String(u).startsWith('https://media.example.test/') ? String(u).slice(27) : null),
    },
  };
  return { handler: viaRouter(handlerPath), sql };
}

// Songs 10 and 11 belong to this band; anything else belongs to someone else.
const OWN_SONGS = new Set([10, 11]);
function ownershipRoute(text, values) {
  // ownsRefs: one statement. Values: artist, song ids, their count, then
  // (id, id, artist) for the gig, the venue and the organizer.
  if (text.startsWith('SELECT (SELECT count(*)::int FROM songs')) {
    const [, ids, n, gig, , , venue, , , organizer] = values;
    return [{
      songs: ids.filter(id => OWN_SONGS.has(id)).length === n,
      gig: gig == null || gig === 5,
      venue: venue == null || venue === 7,
      organizer: organizer == null || organizer === 8,
    }];
  }
  // Setlist create is one WITH s AS (INSERT INTO setlists …) statement.
  if (text.startsWith('WITH s AS ( INSERT INTO setlists')) return [{ id: 99 }];
  if (text.startsWith('INSERT INTO gigs'))               return [{ id: 55 }];
  if (text.startsWith('SELECT s.*'))                     return [{ id: 99 }];
  return [];
}

async function run(r) {
  const { testAsync, test, assert, assertEq, B } = r;

  console.log(B('\ntenant isolation — foreign ids in request bodies'));

  await testAsync("a setlist cannot include another band's song", async () => {
    const { handler, sql } = loadHandler('api/_band/setlists.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/setlists', query: {}, headers: {},
      body: { song_ids: [10, 12345] } }, res);
    assertEq(res.statusCode, 400);
    assert(!sql.calls.some(c => c.text.includes('INSERT INTO setlist')), 'nothing may be written');
  });

  await testAsync('a setlist of own songs is created', async () => {
    const { handler } = loadHandler('api/_band/setlists.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/setlists', query: {}, headers: {},
      body: { song_ids: [10, 11], gig_id: 5 } }, res);
    assertEq(res.statusCode, 201);
  });

  await testAsync('songs and gig of a new setlist are checked in one statement', async () => {
    const { handler, sql } = loadHandler('api/_band/setlists.js', ownershipRoute);
    await handler({ method: 'POST', url: '/api/test/setlists', query: {}, headers: {},
      body: { song_ids: [10, 11], gig_id: 5 } }, mockRes());
    assertEq(sql.calls.length, 2, sql.calls.map(c => c.text.slice(0, 40)).join(' | '));
  });

  await testAsync('a gig without venue or organizer sends no ownership query', async () => {
    const { handler, sql } = loadHandler('api/_band/gigs.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/gigs', query: {}, headers: {}, body: { title: 'x' } }, res);
    assertEq(res.statusCode, 201);
    assertEq(sql.calls.map(c => c.text.split(' ').slice(0, 3).join(' ')), ['INSERT INTO gigs']);
  });

  await testAsync("a setlist cannot hang off another band's gig", async () => {
    const { handler } = loadHandler('api/_band/setlists.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/setlists', query: {}, headers: {},
      body: { song_ids: [10], gig_id: 6 } }, res);
    assertEq(res.statusCode, 400);
  });

  await testAsync("updating a setlist cannot pull in another band's song", async () => {
    const { handler, sql } = loadHandler('api/_band/setlists/item.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'PUT', url: '/api/test/setlists/3', query: { path: ['3'] }, headers: {},
      body: { song_ids: [11, 777] } }, res);
    assertEq(res.statusCode, 400);
    assert(!sql.calls.some(c => c.text.includes('setlist_songs')), 'the old list must survive');
  });

  await testAsync('updating a setlist rewrites it and its songs in one statement', async () => {
    const { handler, sql } = loadHandler('api/_band/setlists/item.js', (text, values) => {
      if (text.startsWith('WITH s AS ( UPDATE setlists')) return [{ id: 3, song_count: 2 }];
      return ownershipRoute(text, values);
    });
    const res = mockRes();
    await handler({ method: 'PUT', url: '/api/test/setlists/3', query: { path: ['3'] }, headers: {},
      body: { song_ids: [10, 11] } }, res);
    assertEq(res.statusCode, 200);
    assertEq(res.body.song_count, 2);
    const writes = sql.calls.filter(c => /UPDATE setlists|setlist_songs/.test(c.text));
    assertEq(writes.length, 1);
    const q = writes[0].text;
    assert(/UPDATE setlists SET .* WHERE id = AND artist_id = RETURNING/.test(q), 'scoped to the band');
    assert(q.includes('ON CONFLICT (setlist_id, position) DO UPDATE'), 'positions upserted');
    assert(/DELETE FROM setlist_songs WHERE setlist_id IN \(SELECT id FROM s\) AND position >=/.test(q),
      'the tail is cut, and only for a setlist the update found');
  });

  await testAsync("updating another band's setlist → 404, nothing written", async () => {
    const { handler } = loadHandler('api/_band/setlists/item.js', (text, values) =>
      text.startsWith('WITH s AS ( UPDATE setlists') ? [] : ownershipRoute(text, values));
    const res = mockRes();
    await handler({ method: 'PUT', url: '/api/test/setlists/3', query: { path: ['3'] }, headers: {},
      body: { song_ids: [10] } }, res);
    assertEq(res.statusCode, 404);
  });

  await testAsync('reading a setlist only joins this band\'s songs', async () => {
    const { handler, sql } = loadHandler('api/_band/setlists/item.js', text =>
      text.startsWith('SELECT s.*, g.title AS gig_name') ? [{ id: 3 }] : []);
    const res = mockRes();
    await handler({ method: 'GET', url: '/api/test/setlists/3', query: { path: ['3'] }, headers: {} }, res);
    const q = sql.calls.find(c => c.text.includes('FROM setlist_songs ss JOIN songs'));
    assert(q && q.text.includes('songs.artist_id ='), `song join is not scoped: ${q && q.text}`);
  });

  await testAsync("a gig cannot point at another band's venue or organizer", async () => {
    for (const body of [{ title: 'x', venue_id: 70 }, { title: 'x', organizer_id: 80 }]) {
      const { handler, sql } = loadHandler('api/_band/gigs.js', ownershipRoute);
      const res = mockRes();
      await handler({ method: 'POST', url: '/api/test/gigs', query: {}, headers: {}, body }, res);
      assertEq(res.statusCode, 400, JSON.stringify(body));
      assert(!sql.calls.some(c => c.text.startsWith('INSERT INTO gigs')), 'nothing may be written');
    }
  });

  await testAsync('a gig with own venue and organizer is created', async () => {
    const { handler } = loadHandler('api/_band/gigs.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/gigs', query: {}, headers: {},
      body: { title: 'x', venue_id: 7, organizer_id: 8 } }, res);
    assertEq(res.statusCode, 201);
  });

  console.log(B('\nsong links — no script, no foreign bucket objects'));

  const stored = { id: 10, title: 'Song', extra: { listenUrl: 'https://media.example.test/audio/1/a.mp3' } };
  // The PATCH batch is one WITH … UPDATE … RETURNING statement.
  const songRoute = text => (text.startsWith('SELECT s.*') && text.includes('FROM songs s') ? [stored] : text.startsWith('WITH u AS') ? [stored] : []);

  for (const [label, extra, ok] of [
    ['a javascript: sheet link is refused', { sheetUrl: 'javascript:alert(1)' }, false],
    ['a data: reference link is refused', { referenceUrl: 'data:text/html,<script>1</script>' }, false],
    ["another band's bucket object is refused", { listenUrl: 'https://media.example.test/audio/2/b.mp3' }, false],
    ['the already-stored bucket URL is kept', { listenUrl: 'https://media.example.test/audio/1/a.mp3' }, true],
    ['an external https link is fine', { referenceUrl: 'https://youtube.com/watch?v=abcdefghijk' }, true],
    ['clearing a link is fine', { sheetUrl: '' }, true],
  ]) {
    await testAsync(label, async () => {
      const { handler } = loadHandler('api/_band/songs.js', songRoute);
      const res = mockRes();
      await handler({ method: 'PATCH', url: '/api/test/songs', query: {}, headers: {},
        body: [{ id: 10, extra }] }, res);
      assertEq(res.statusCode, 200);
      assertEq(res.body.rejected.length, ok ? 0 : 1, JSON.stringify(res.body));
    });
  }

  await testAsync('a new song cannot start with a script link', async () => {
    const { handler } = loadHandler('api/_band/songs.js', () => [{ count: 0 }]);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/songs', query: {}, headers: {},
      body: { title: 'x', extra: { songinfoUrl: 'JaVaScRiPt:alert(1)' } } }, res);
    assertEq(res.statusCode, 400);
  });

  console.log(B('\ndemo gate and band credentials'));

  const authPath = mp('api/_auth'), tokenPath = mp('api/_token'), dbPath = mp('api/_db');
  for (const p of [authPath, tokenPath, dbPath]) delete require.cache[p];
  const { generateMagicToken, verifyMagicToken, generateUserToken, verifyUserToken, sessionValid } = require(tokenPath);
  const band = { id: 42, slug: 'band', password_hash: crypto.randomBytes(16).toString('hex') };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
    exports: { getArtist: async () => band, getDb: () => { throw new Error('no db'); } } };
  const { getAccess } = require(authPath);
  const roleFor = async token => (await getAccess({ headers: { authorization: `Bearer ${token}` } }, 'band')).user?.role ?? null;

  await testAsync('a demo-gate token is a member session, never admin', async () => {
    const { demoSeed } = require(tokenPath);
    assertEq(await roleFor(generateMagicToken(demoSeed(band.id), 'demo')), 'member');
  });
  await testAsync('a demo token for another band opens nothing here', async () => {
    const { demoSeed } = require(tokenPath);
    assertEq(await roleFor(generateMagicToken(demoSeed(band.id + 1), 'demo')), null);
  });
  await testAsync('the retired band password is no session', async () => {
    assertEq(await roleFor('the-band-password'), null);
    assertEq(await roleFor(generateMagicToken(band.password_hash, 'login')), null);
    assertEq(await roleFor(generateMagicToken(band.password_hash, 'demo')), null);
  });
  delete require.cache[dbPath]; delete require.cache[authPath];
  test('a sign-in link cannot be redeemed as a reset link, and back', () => {
    assertEq(verifyMagicToken(generateMagicToken(band.password_hash, 'login'), band.password_hash, 'reset'), false);
    assertEq(verifyMagicToken(generateMagicToken(band.password_hash, 'reset'), band.password_hash, 'login'), false);
    assertEq(verifyMagicToken(generateMagicToken(band.password_hash, 'demo'),  band.password_hash, 'login'), false);
  });

  console.log(B('\nsessions end when the password changes'));

  test('a session verifies against the hash it was issued with', () => {
    const claim = verifyUserToken(generateUserToken(1, 'admin', 60_000, 'hash-A'));
    assertEq(sessionValid(claim, { password_hash: 'hash-A' }), true);
  });
  test('after a password change the old session no longer matches', () => {
    const claim = verifyUserToken(generateUserToken(1, 'admin', 60_000, 'hash-A'));
    assertEq(sessionValid(claim, { password_hash: 'hash-B' }), false);
  });
  test('setting a first password ends a password-less (OAuth) session', () => {
    const claim = verifyUserToken(generateUserToken(1, 'admin', 60_000, null));
    assertEq(sessionValid(claim, { password_hash: null }), true);
    assertEq(sessionValid(claim, { password_hash: 'hash-new' }), false);
  });
  test('"log out everywhere" ends sessions issued before it, not after', () => {
    const before = verifyUserToken(generateUserToken(1, 'admin', 60_000, 'hash-A'));
    const cut = new Date(before.iat + 1);
    const after = { ...before, iat: before.iat + 2 };
    assertEq(sessionValid(before, { password_hash: 'hash-A', sessions_valid_after: cut }), false);
    assertEq(sessionValid(after,  { password_hash: 'hash-A', sessions_valid_after: cut }), true);
    assertEq(sessionValid(before, { password_hash: 'hash-A', sessions_valid_after: null }), true);
  });
  test('a token from before issue times were recorded counts as issued at 0', () => {
    const claim = { ...verifyUserToken(generateUserToken(1, 'admin', 60_000, 'hash-A')), iat: 0 };
    assertEq(sessionValid(claim, { password_hash: 'hash-A' }), true);
    assertEq(sessionValid(claim, { password_hash: 'hash-A', sessions_valid_after: new Date(1) }), false);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
