'use strict';

// artists.storage_used_bytes must track the bytes actually held in R2:
// never counted twice when the same upload is confirmed again (a retried or
// double-submitted confirm), and never credited back when the storage delete
// failed — deleteFromR2 reports whether the object really went away.

const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

const SECRET  = 'storage-accounting-secret-32-bytes!';
const BASE    = 'https://cdn.example.test';
const NEW_URL = `${BASE}/audio/1/new.mp3`;
const OLD_URL = `${BASE}/audio/1/old.mp3`;
const SIZES   = { 'audio/1/new.mp3': 100, 'audio/1/old.mp3': 40 };

// Pro plan: unlimited storage, so the cap never interferes with these tests.
const ARTIST = { id: 1, slug: 'testband', name: 'Test Band', config: { plan: 'pro' }, storage_used_bytes: 1000 };

function modulePath(rel) { return require.resolve(path.join(__dirname, '../..', rel)); }

function mockRes() {
  const res = { statusCode: 200, headersSent: false };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.headersSent = true; return res; };
  res.setHeader = () => {};
  return res;
}

// storedUrl — what song.extra.listenUrl already holds; deleteOk — whether the
// storage delete succeeds. Returns the handler plus the recorded byte deltas.
function loadSongs({ storedUrl = null, deleteOk = true } = {}) {
  process.env.APP_SECRET     = SECRET;
  process.env.R2_PUBLIC_URL  = BASE;

  const dbPath      = modulePath('api/_db');
  const authPath    = modulePath('api/_auth');
  const tokenPath   = modulePath('api/_token');
  const handlerPath = modulePath('api/[artist]/songs.js');
  const r2Path      = modulePath('api/_r2');
  const rlPath      = modulePath('api/_ratelimit');
  const emailPath   = modulePath('api/_email');
  const aiPath      = modulePath('api/_ai');

  for (const p of [dbPath, authPath, tokenPath, handlerPath]) delete require.cache[p];

  const deltas  = [];
  const deleted = [];
  const extra   = storedUrl ? { listenUrl: storedUrl } : {};

  const sql = async (strings, ...values) => {
    const text = strings.join(' ').replace(/\s+/g, ' ');
    if (text.includes('JOIN users u2'))                             return [{ id: 7, role: 'member' }];
    if (text.includes('SELECT * FROM songs'))                       return [{ id: 5, extra }];
    if (text.includes('SELECT extra FROM songs'))                   return [{ extra }];
    if (text.includes('UPDATE songs SET extra'))                    return [{ id: 5, extra }];
    // Counter writes in either shape: "storage_used_bytes + $n" or "... - $n",
    // with or without a GREATEST(0, ...) wrapper.
    if (text.includes('UPDATE artists') && text.includes('storage_used_bytes')) {
      deltas.push(text.includes('storage_used_bytes -') ? -Number(values[0]) : Number(values[0]));
      return [];
    }
    return [];
  };

  require.cache[rlPath]    = { id: rlPath, filename: rlPath, loaded: true,
    exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1', isMissingRateLimitTable: () => false } };
  require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: { sendEmail: async () => {} } };
  require.cache[aiPath]    = { id: aiPath, filename: aiPath, loaded: true,
    exports: { suggestLyricsWithAI: async () => ({ lyrics: null, skipped: true }) } };
  require.cache[r2Path]    = { id: r2Path, filename: r2Path, loaded: true,
    exports: {
      createPresignedUrl: async () => ({ uploadUrl: 'https://upload.example.test', publicUrl: NEW_URL }),
      deleteFromR2: async url => { deleted.push(url); return deleteOk; },
      filenameFromUrl: url => String(url).split('/').pop(),
      keyFromUrl: url => (String(url).startsWith(BASE) ? String(url).slice(BASE.length + 1) : null),
      verifyUpload: async key => (SIZES[key] == null ? null : { size: SIZES[key], contentType: 'audio/mpeg' }),
    } };
  require.cache[dbPath]    = { id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async slug => (slug === ARTIST.slug ? ARTIST : null),
      getSlug: req => req.query?.artist || ARTIST.slug,
      insertAuditLog: async () => {},
      parsePage: () => ({ limit: 50, offset: 0 }),
    } };

  const tokenApi = require(path.join(__dirname, '../../api/_token'));
  return {
    handler: require(path.join(__dirname, '../../api/[artist]/songs.js')),
    token:   tokenApi.generateUserToken(7, 'member', tokenApi.TTL_8H),
    deltas,
    deleted,
  };
}

async function call(handler, token, body) {
  const res = mockRes();
  await handler({
    method: 'POST',
    url: `/api/${ARTIST.slug}/songs`,
    query: { artist: ARTIST.slug },
    headers: { authorization: `Bearer ${token}` },
    body,
  }, res);
  return res;
}

const confirmAudio = { media_confirm_id: 5, media_type: 'audio', publicUrl: NEW_URL };
const deleteAudio  = { media_delete_id: 5, media_type: 'audio' };

async function run(r) {
  const { testAsync, assert, assertEq } = r;

  console.log(r.B('\nsong media storage accounting'));

  await testAsync('first upload adds the uploaded size', async () => {
    const { handler, token, deltas } = loadSongs();
    const res = await call(handler, token, confirmAudio);
    assertEq(res.statusCode, 200);
    assertEq(deltas, [100]);
  });

  // One round-trip, carrying the net change (+100 new − 40 old): two statements
  // would double the latency and leave the count briefly overstated in between.
  await testAsync('replacing a file settles the counter in a single statement', async () => {
    const { handler, token, deltas } = loadSongs({ storedUrl: OLD_URL });
    const res = await call(handler, token, confirmAudio);
    assertEq(res.statusCode, 200);
    assertEq(deltas, [60]);
  });

  // A retried or double-submitted confirm re-sends the URL already stored: the
  // bytes are counted already, so the counter must not move at all.
  await testAsync('confirming the stored url again does not count the bytes twice', async () => {
    const { handler, token, deltas } = loadSongs({ storedUrl: NEW_URL });
    const res = await call(handler, token, confirmAudio);
    assertEq(res.statusCode, 200);
    assertEq(deltas, []);
  });

  await testAsync('deleting media subtracts the stored size', async () => {
    const { handler, token, deltas, deleted } = loadSongs({ storedUrl: OLD_URL });
    const res = await call(handler, token, deleteAudio);
    assertEq(res.statusCode, 200);
    assertEq(deltas, [-40]);
    assertEq(deleted, [OLD_URL]);
  });

  // deleteFromR2 swallows storage errors, so the counter may only drop when the
  // object actually went away — otherwise usage silently understates reality.
  await testAsync('a failed storage delete does not credit the bytes back', async () => {
    const { handler, token, deltas } = loadSongs({ storedUrl: OLD_URL, deleteOk: false });
    const res = await call(handler, token, deleteAudio);
    assertEq(res.statusCode, 200);
    assertEq(deltas, []);
  });

  await testAsync('a failed delete during replace keeps the old bytes counted', async () => {
    const { handler, token, deltas } = loadSongs({ storedUrl: OLD_URL, deleteOk: false });
    const res = await call(handler, token, confirmAudio);
    assertEq(res.statusCode, 200);
    assert(!deltas.includes(-40), 'must not subtract bytes for a file that is still stored');
    assertEq(deltas, [100]);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
