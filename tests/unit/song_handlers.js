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
    return Promise.resolve(route(text, values));
  };
  sql.begin = async fn => fn(sql);
  sql.json = v => ({ json: v });
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

// The batch is one statement: WITH u AS (UPDATE songs … FROM jsonb_to_recordset($rows)).
const isBatch = text => text.startsWith('WITH u AS ( UPDATE songs');
// Answers the stored-row SELECT with `stored` and the batch with the ids it was given.
function routeFor(stored) {
  return (text, values) => {
    if (isBatch(text)) return values[0].json.map(r => ({ id: r.id }));
    return text.startsWith('SELECT') ? [].concat(stored) : [];
  };
}
function batchRows(calls) {
  const batch = calls.filter(c => isBatch(c.text));
  if (batch.length !== 1) throw new Error(`expected one batch statement, got ${batch.length}`);
  return batch[0].values[0].json;
}

async function run(r) {
  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\nsong handlers (bulk edit PATCH)'));

  await testAsync('favourite flag is written', async () => {
    const { handler, calls } = loadHandler(routeFor(UPDATED));
    const res = await patch(handler, [{ id: 5, title: 'Song', heart: true }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 1);
    assertEq(batchRows(calls)[0].heart, true);
  });

  await testAsync('fields that are not sent keep their stored value', async () => {
    const stored = { id: 5, artist_id: 1, title: 'Wonderwall', key: 'Em', genre: 'Pop',
      energy: '7', bpm: 92, length_min: 4.2, interpret: 'Oasis', reference_interpret: null,
      comment: 'note', time_signature: '4/4', active: true, heart: false, language: 'EN', extra: { gitCapo: 2 } };
    const { handler, calls } = loadHandler(routeFor(stored));
    const res = await patch(handler, [{ id: 5, title: 'Wonderwall', heart: true }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 1);
    const row = batchRows(calls)[0];
    assertEq(row.key, 'Em', 'key must be kept when not sent');
    assertEq(row.genre, 'Pop', 'genre must be kept when not sent');
    assertEq(row.interpret, 'Oasis', 'interpret must be kept when not sent');
    assertEq(row.language, 'EN', 'language must be kept when not sent');
    assertEq(row.heart, true, 'heart must be written');
  });

  await testAsync('an explicit null clears a field', async () => {
    const stored = { id: 5, artist_id: 1, title: 'Song', key: 'Em', genre: 'Pop', active: true, heart: false, extra: {} };
    const { handler, calls } = loadHandler(routeFor(stored));
    const res = await patch(handler, [{ id: 5, title: 'Song', genre: null }]);
    assertEq(res.body?.count, 1);
    const row = batchRows(calls)[0];
    assertEq(row.key, 'Em', 'untouched key kept');
    assertEq(row.genre, null, 'cleared genre must be null');
  });

  await testAsync('active is not silently switched on by a partial update', async () => {
    const stored = { id: 5, artist_id: 1, title: 'Song', active: false, heart: false, extra: {} };
    const { handler, calls } = loadHandler(routeFor(stored));
    await patch(handler, [{ id: 5, title: 'Song', heart: true }]);
    assertEq(batchRows(calls)[0].active, false, 'stored active=false must survive');
  });

  await testAsync('the whole batch and its audit entries are one statement', async () => {
    const stored = [5, 6, 7].map(id => ({ id, artist_id: 1, title: 'S' + id, active: true, heart: false, extra: {} }));
    const { handler, calls } = loadHandler(routeFor(stored));
    const res = await patch(handler, stored.map(s => ({ id: s.id, heart: true })));
    assertEq(res.body?.count, 3);
    assertEq(batchRows(calls).length, 3);
    const batch = calls.find(c => isBatch(c.text));
    assert(batch.text.includes('INSERT INTO song_logs'), 'audit entries belong to the same statement');
    assertEq(calls.filter(c => c.text.includes('UPDATE songs')).length, 1, 'one UPDATE for all rows');
  });

  await testAsync('language is a column; an older client may still send it in extra', async () => {
    const stored = { id: 5, artist_id: 1, title: 'Song', active: true, heart: false, language: null, extra: { gitCapo: 1 } };
    const { handler, calls } = loadHandler(routeFor(stored));
    await patch(handler, [{ id: 5, extra: { language: 'fr', lyrics: 'stale copy', gitCapo: 3 } }]);
    const row = batchRows(calls)[0];
    assertEq(row.language, 'FR');
    assertEq(row.extra, { gitCapo: 3 }, 'language and lyrics never land in extra');
  });

  await testAsync('an over-long language is reported', async () => {
    const stored = { id: 5, artist_id: 1, title: 'Song', active: true, heart: false, extra: {} };
    const { handler } = loadHandler(routeFor(stored));
    const res = await patch(handler, [{ id: 5, language: 'x'.repeat(11) }]);
    assertEq(res.body?.count, 0);
    assert(/language/.test(res.body?.rejected?.[0]?.error || ''), 'reason should name language');
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
    const { handler } = loadHandler(routeFor(UPDATED));
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
