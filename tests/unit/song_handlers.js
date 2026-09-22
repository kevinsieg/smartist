'use strict';

// Songs PATCH (bulk edit + song panel): rows that fail validation must be reported,
// not silently skipped — a skipped row looks to the user like "saving does nothing".

const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

const ARTIST = { id: 1, slug: 'test', name: 'Test Band', config: { plan: 'pro' } };

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
  const handlerPath = mp('api/[artist]/songs.js');
  for (const p of [dbPath, authPath, handlerPath]) delete require.cache[p];
  const calls = [];
  const sql = (strings, ...values) => {
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
      getSlug: () => 'test',
      insertAuditLog: async () => {},
      parsePage: () => ({ limit: 50, offset: 0 }),
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
      requireAuth: async req => { req.user = { id: 1, role: 'member' }; return ARTIST; },
      getAccess: async () => ({ artist: ARTIST, user: { id: 1, role: 'member' } }),
      // Handlers ask these directly now; a stub that omits them throws.
      canBrowseCatalogue: () => false,
      canOpenStage: () => true,
    },
  };
  require.cache[r2Path] = {
    id: r2Path, filename: r2Path, loaded: true,
    exports: { createPresignedUrl: async () => ({}), deleteFromR2: async () => {},
      verifyUpload: async () => ({}), keyFromUrl: () => 'k', filenameFromUrl: () => 'f' },
  };
  return { handler: require(path.join(__dirname, '../..', 'api/[artist]/songs.js')), calls };
}

async function patch(handler, body) {
  const res = mockRes();
  await handler({ method: 'PATCH', url: '/api/test/songs', query: { artist: 'test' }, headers: {}, body }, res);
  return res;
}

const UPDATED = { id: 5, title: 'Song', heart: true };

async function run(r) {
  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\nsong handlers (bulk edit PATCH)'));

  await testAsync('favourite flag is written', async () => {
    const { handler, calls } = loadHandler(() => [UPDATED]);
    const res = await patch(handler, [{ id: 5, title: 'Song', heart: true }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 1);
    const update = calls.find(c => c.text.startsWith('UPDATE songs'));
    assert(update.text.includes('heart'), 'heart missing from UPDATE');
    assert(update.values.includes(true), 'heart value not passed');
  });

  await testAsync('fields that are not sent keep their stored value', async () => {
    const stored = { id: 5, artist_id: 1, title: 'Wonderwall', key: 'Em', genre: 'Pop',
      energy: '7', bpm: 92, length_min: 4.2, interpret: 'Oasis', reference_interpret: null,
      comment: 'note', time_signature: '4/4', active: true, heart: false, extra: { gitCapo: 2 } };
    const { handler, calls } = loadHandler(text =>
      (text.startsWith('SELECT') ? [stored] : [{ ...stored, heart: true }]));
    const res = await patch(handler, [{ id: 5, title: 'Wonderwall', heart: true }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 1);
    const update = calls.find(c => c.text.startsWith('UPDATE songs'));
    const sent = JSON.stringify(update.values);
    assert(sent.includes('Em'), 'key must be kept when not sent');
    assert(sent.includes('Pop'), 'genre must be kept when not sent');
    assert(sent.includes('Oasis'), 'interpret must be kept when not sent');
    assert(update.values.includes(true), 'heart must be written');
  });

  await testAsync('an explicit null clears a field', async () => {
    const stored = { id: 5, artist_id: 1, title: 'Song', key: 'Em', genre: 'Pop', active: true, heart: false, extra: {} };
    const { handler, calls } = loadHandler(text => (text.startsWith('SELECT') ? [stored] : [stored]));
    const res = await patch(handler, [{ id: 5, title: 'Song', genre: null }]);
    assertEq(res.body?.count, 1);
    const update = calls.find(c => c.text.startsWith('UPDATE songs'));
    assert(JSON.stringify(update.values).includes('Em'), 'untouched key kept');
    assert(update.values.includes(null), 'cleared genre must be null');
  });

  await testAsync('active is not silently switched on by a partial update', async () => {
    const stored = { id: 5, artist_id: 1, title: 'Song', active: false, heart: false, extra: {} };
    const { handler, calls } = loadHandler(text => (text.startsWith('SELECT') ? [stored] : [stored]));
    await patch(handler, [{ id: 5, title: 'Song', heart: true }]);
    const update = calls.find(c => c.text.startsWith('UPDATE songs'));
    assert(update.values.includes(false), 'stored active=false must survive');
  });

  await testAsync('a row without a title is reported, not skipped silently', async () => {
    const { handler } = loadHandler(() => [UPDATED]);
    const res = await patch(handler, [{ id: 5, title: '', heart: true }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 0);
    assertEq(res.body?.rejected?.length, 1);
    assertEq(res.body.rejected[0].id, 5);
    assert(/title/i.test(res.body.rejected[0].error), 'reason should name the field: ' + res.body.rejected[0].error);
  });

  await testAsync('an over-long value is reported with the field name', async () => {
    const { handler } = loadHandler(() => [UPDATED]);
    const res = await patch(handler, [{ id: 5, title: 'Song', comment: 'x'.repeat(2001) }]);
    assertEq(res.body?.count, 0);
    assertEq(res.body?.rejected?.length, 1);
    assert(/comment/i.test(res.body.rejected[0].error), 'reason should name comment: ' + res.body.rejected[0].error);
  });

  await testAsync('a bad number is reported', async () => {
    const { handler } = loadHandler(() => [UPDATED]);
    const res = await patch(handler, [{ id: 5, title: 'Song', bpm: 'fast' }]);
    assertEq(res.body?.count, 0);
    assert(/bpm/i.test(res.body?.rejected?.[0]?.error || ''), 'reason should name bpm');
  });

  await testAsync('good rows still save when another row is rejected', async () => {
    const { handler } = loadHandler(() => [UPDATED]);
    const res = await patch(handler, [
      { id: 5, title: 'Song', heart: true },
      { id: 6, title: '' },
    ]);
    assertEq(res.body?.count, 1);
    assertEq(res.body?.rejected?.length, 1);
    assertEq(res.body.rejected[0].id, 6);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
