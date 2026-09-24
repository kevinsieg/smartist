'use strict';

// Row ids are one sequence across every band. These tests pin the checks that
// keep one band's request from reaching another band's rows, the demo gate's
// session from being an admin one, and stored links from carrying script.

const path = require('path');
const crypto = require('crypto');
const { makeRunner, stubLogger } = require('./_runner');

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
  sql.begin = async fn => fn(sql);
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
      getSlug: () => 'test', insertAuditLog: async () => {},
      parsePage: () => ({ limit: 50, offset: 0 }),
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
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
  return { handler: require(handlerPath), sql };
}

// Songs 10 and 11 belong to this band; anything else belongs to someone else.
const OWN_SONGS = new Set([10, 11]);
function ownershipRoute(text, values) {
  if (text.startsWith('SELECT count(*)::int AS n FROM songs')) {
    const ids = values[1] || [];
    return [{ n: ids.filter(id => OWN_SONGS.has(id)).length }];
  }
  if (text.startsWith('SELECT 1 AS ok FROM gigs'))       return values[0] === 5 ? [{ ok: 1 }] : [];
  if (text.startsWith('SELECT 1 AS ok FROM venues'))     return values[0] === 7 ? [{ ok: 1 }] : [];
  if (text.startsWith('SELECT 1 AS ok FROM organizers')) return values[0] === 8 ? [{ ok: 1 }] : [];
  if (text.startsWith('INSERT INTO setlists'))           return [{ id: 99 }];
  if (text.startsWith('INSERT INTO gigs'))               return [{ id: 55 }];
  if (text.startsWith('SELECT s.*'))                     return [{ id: 99 }];
  return [];
}

async function run(r) {
  const { testAsync, test, assert, assertEq, B } = r;

  console.log(B('\ntenant isolation — foreign ids in request bodies'));

  await testAsync("a setlist cannot include another band's song", async () => {
    const { handler, sql } = loadHandler('api/[artist]/setlists.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/setlists', query: {}, headers: {},
      body: { song_ids: [10, 12345] } }, res);
    assertEq(res.statusCode, 400);
    assert(!sql.calls.some(c => c.text.startsWith('INSERT INTO setlist')), 'nothing may be written');
  });

  await testAsync('a setlist of own songs is created', async () => {
    const { handler } = loadHandler('api/[artist]/setlists.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/setlists', query: {}, headers: {},
      body: { song_ids: [10, 11], gig_id: 5 } }, res);
    assertEq(res.statusCode, 201);
  });

  await testAsync("a setlist cannot hang off another band's gig", async () => {
    const { handler } = loadHandler('api/[artist]/setlists.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/setlists', query: {}, headers: {},
      body: { song_ids: [10], gig_id: 6 } }, res);
    assertEq(res.statusCode, 400);
  });

  await testAsync("updating a setlist cannot pull in another band's song", async () => {
    const { handler, sql } = loadHandler('api/[artist]/setlists/[...path].js', (text, values) => {
      if (text.startsWith('SELECT s.*, g.title AS gig_name')) return [{ id: 3 }];
      return ownershipRoute(text, values);
    });
    const res = mockRes();
    await handler({ method: 'PUT', url: '/api/test/setlists/3', query: { path: ['3'] }, headers: {},
      body: { song_ids: [11, 777] } }, res);
    assertEq(res.statusCode, 400);
    assert(!sql.calls.some(c => c.text.startsWith('DELETE FROM setlist_songs')), 'the old list must survive');
  });

  await testAsync('reading a setlist only joins this band\'s songs', async () => {
    const { handler, sql } = loadHandler('api/[artist]/setlists/[...path].js', text =>
      text.startsWith('SELECT s.*, g.title AS gig_name') ? [{ id: 3 }] : []);
    const res = mockRes();
    await handler({ method: 'GET', url: '/api/test/setlists/3', query: { path: ['3'] }, headers: {} }, res);
    const q = sql.calls.find(c => c.text.includes('FROM setlist_songs ss JOIN songs'));
    assert(q && q.text.includes('songs.artist_id ='), `song join is not scoped: ${q && q.text}`);
  });

  await testAsync("a gig cannot point at another band's venue or organizer", async () => {
    for (const body of [{ title: 'x', venue_id: 70 }, { title: 'x', organizer_id: 80 }]) {
      const { handler, sql } = loadHandler('api/[artist]/gigs.js', ownershipRoute);
      const res = mockRes();
      await handler({ method: 'POST', url: '/api/test/gigs', query: {}, headers: {}, body }, res);
      assertEq(res.statusCode, 400, JSON.stringify(body));
      assert(!sql.calls.some(c => c.text.startsWith('INSERT INTO gigs')), 'nothing may be written');
    }
  });

  await testAsync('a gig with own venue and organizer is created', async () => {
    const { handler } = loadHandler('api/[artist]/gigs.js', ownershipRoute);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/gigs', query: {}, headers: {},
      body: { title: 'x', venue_id: 7, organizer_id: 8 } }, res);
    assertEq(res.statusCode, 201);
  });

  console.log(B('\nsong links — no script, no foreign bucket objects'));

  const stored = { id: 10, title: 'Song', extra: { listenUrl: 'https://media.example.test/audio/1/a.mp3' } };
  const songRoute = text => (text.startsWith('SELECT * FROM songs') ? [stored] : text.startsWith('UPDATE songs') ? [stored] : []);

  for (const [label, extra, ok] of [
    ['a javascript: sheet link is refused', { sheetUrl: 'javascript:alert(1)' }, false],
    ['a data: reference link is refused', { referenceUrl: 'data:text/html,<script>1</script>' }, false],
    ["another band's bucket object is refused", { listenUrl: 'https://media.example.test/audio/2/b.mp3' }, false],
    ['the already-stored bucket URL is kept', { listenUrl: 'https://media.example.test/audio/1/a.mp3' }, true],
    ['an external https link is fine', { referenceUrl: 'https://youtube.com/watch?v=abcdefghijk' }, true],
    ['clearing a link is fine', { sheetUrl: '' }, true],
  ]) {
    await testAsync(label, async () => {
      const { handler } = loadHandler('api/[artist]/songs.js', songRoute);
      const res = mockRes();
      await handler({ method: 'PATCH', url: '/api/test/songs', query: {}, headers: {},
        body: [{ id: 10, extra }] }, res);
      assertEq(res.statusCode, 200);
      assertEq(res.body.rejected.length, ok ? 0 : 1, JSON.stringify(res.body));
    });
  }

  await testAsync('a new song cannot start with a script link', async () => {
    const { handler } = loadHandler('api/[artist]/songs.js', () => [{ count: 0 }]);
    const res = mockRes();
    await handler({ method: 'POST', url: '/api/test/songs', query: {}, headers: {},
      body: { title: 'x', extra: { songinfoUrl: 'JaVaScRiPt:alert(1)' } } }, res);
    assertEq(res.statusCode, 400);
  });

  console.log(B('\ndemo gate and band credentials'));

  const authPath = mp('api/_auth'), tokenPath = mp('api/_token'), dbPath = mp('api/_db');
  for (const p of [authPath, tokenPath, dbPath]) delete require.cache[p];
  const { generateMagicToken, verifyMagicToken, generateUserToken, verifyUserToken, passwordMatches } = require(tokenPath);
  const { checkCredentials } = require(authPath);
  const band = { password_hash: crypto.randomBytes(16).toString('hex') };

  await testAsync('a demo-gate token is a member session, never admin', async () => {
    assertEq(await checkCredentials(generateMagicToken(band.password_hash, 'demo'), band), 'member');
  });
  await testAsync('a login link is still an admin session for the band password', async () => {
    assertEq(await checkCredentials(generateMagicToken(band.password_hash, 'login'), band), 'admin');
  });
  test('a sign-in link cannot be redeemed as a reset link, and back', () => {
    assertEq(verifyMagicToken(generateMagicToken(band.password_hash, 'login'), band.password_hash, 'reset'), false);
    assertEq(verifyMagicToken(generateMagicToken(band.password_hash, 'reset'), band.password_hash, 'login'), false);
    assertEq(verifyMagicToken(generateMagicToken(band.password_hash, 'demo'),  band.password_hash, 'login'), false);
  });

  console.log(B('\nsessions end when the password changes'));

  test('a session verifies against the hash it was issued with', () => {
    const claim = verifyUserToken(generateUserToken(1, 'admin', 60_000, 'hash-A'));
    assertEq(passwordMatches(claim, { password_hash: 'hash-A' }), true);
  });
  test('after a password change the old session no longer matches', () => {
    const claim = verifyUserToken(generateUserToken(1, 'admin', 60_000, 'hash-A'));
    assertEq(passwordMatches(claim, { password_hash: 'hash-B' }), false);
  });
  test('setting a first password ends a password-less (OAuth) session', () => {
    const claim = verifyUserToken(generateUserToken(1, 'admin', 60_000, null));
    assertEq(passwordMatches(claim, { password_hash: null }), true);
    assertEq(passwordMatches(claim, { password_hash: 'hash-new' }), false);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
