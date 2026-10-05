'use strict';

// Organizers had no unit tests. They hold private CRM data (contact people, emails,
// notes), they are a paid feature, and the hard delete has to remove rows in FK order —
// all three are easy to break without noticing.

const path = require('path');
const { makeRunner, stubLogger, viaRouter } = require('./_runner');

stubLogger();

const ARTIST = { id: 1, slug: 'test', name: 'Test Band', config: { plan: 'pro' } };
const FREE_ARTIST = { id: 1, slug: 'test', name: 'Test Band', config: { plan: 'free' } };
const ORG = { id: 5, artist_id: 1, name: 'Giesserei', city: 'Konstanz', deleted: false, social_links: {} };

// The columns an INSERT/UPDATE writes through sql({ … }).
// INSERTs pass sql({ … }); record updates nest one `col = $n` fragment per
// column (api/_domain/records.js updateSet).
const written = c => {
  const out = {};
  const find = vs => {
    for (const v of vs || []) {
      if (v && v.helper) return Object.assign(out, v.helper);
      // updateSet: one `col = $n` fragment per column, nested.
      if (v && v.values && v.values[0] && 'fragment' in v.values[0] && !v.values[0].values
          && /^= ,/.test(v.fragment || '')) out[v.values[0].fragment] = v.values[1];
      if (v && v.values) find(v.values);
    }
  };
  find(c.values);
  return out;
};
// The patch a JSONB column is merged with in SQL (`col = col || $patch`).
const mergedInto = (c, col) => {
  const find = vs => {
    for (const v of vs || []) {
      if (v && v.values && v.values[0] && v.values[0].fragment === col && /\|\|/.test(v.fragment)) return v.values[2];
      const inner = v && v.values && find(v.values);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return find(c.values);
};

function mp(rel) { return require.resolve(path.join(__dirname, '../..', rel)); }

function mockRes() {
  const r = { statusCode: 200, headersSent: false };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; r.headersSent = true; return r; };
  r.setHeader = () => {};
  return r;
}

// authFails mirrors the real requireAuth: writes 401 and returns null.
function loadHandler(rel, route, { artist = ARTIST, authFails = false } = {}) {
  const dbPath = mp('api/_db'), authPath = mp('api/_auth'), handlerPath = mp(rel);
  // The item handler is built by api/_band/record_item.js: rebuilt too, so it
  // picks up these stubs.
  for (const p of [dbPath, authPath, handlerPath, mp('api/_band/record_item')]) delete require.cache[p];
  const calls = [];
  const sql = (strings, ...values) => {
    // sql({ col: value }) — the insert/update helper: keep the object.
    if (strings && typeof strings === 'object' && !Array.isArray(strings)) return { helper: strings };
    if (!Array.isArray(strings)) return { fragment: String(strings) };
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    // sql`…` nested in another statement (a SET list) is a fragment, not a query.
    if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(text)) return { fragment: text, values };
    // A statement's text with its identifiers (sql('organizers')) in place.
    const named = strings.reduce((t, str, i) => t + (i ? ` ${values[i - 1]?.fragment !== undefined && !values[i - 1].values ? values[i - 1].fragment : ''} ` : '') + str, '')
      .replace(/\s+/g, ' ').trim();
    calls.push({ text: named, values });
    return Promise.resolve(route(text));
  };
  // postgres.js awaits an array of queries returned from begin().
  sql.begin = async fn => { const r = await fn(sql); return Array.isArray(r) ? Promise.all(r) : r; };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async () => artist,
      getSlug: req => req.query?.artist || 'test',
      insertAuditLog: async () => {}, trimSongLogs: async () => {},
      parsePage: () => ({ limit: 50, offset: 0 }),
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { refuseDemo: (req, res) => { if (req.user && req.user.id === null) { res.status(403).json({ error: 'demo' }); return true; } return false; },
      requireAuth: async (req, res) => {
        if (authFails) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        req.user = { id: 1, role: 'member' };
        return artist;
      },
      getAccess: async () => ({ artist, user: { id: 1, role: 'member' } }),
      // Handlers ask these directly now; a stub that omits them throws.
      canBrowseCatalogue: () => false,
      canOpenStage: () => true,
    },
  };
  return { handler: viaRouter(path.join(__dirname, '../..', rel)), calls };
}

async function call(handler, method, url, { query = {}, body } = {}) {
  const res = mockRes();
  await handler({ method, url, query: { artist: 'test', ...query }, headers: {}, body }, res);
  return res;
}

const LIST = 'api/_band/organizers.js';
const ITEM = 'api/_band/organizers/item.js';

async function run(r) {
  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\norganizer handlers'));

  // ── reads are private ──────────────────────────────────────────────────────
  await testAsync('GET list requires a session — organizers are private CRM data', async () => {
    const { handler, calls } = loadHandler(LIST, () => [], { authFails: true });
    const res = await call(handler, 'GET', '/api/test/organizers');
    assertEq(res.statusCode, 401);
    assertEq(calls.length, 0, 'must not query before the auth gate');
  });

  await testAsync('GET one requires a session', async () => {
    const { handler } = loadHandler(ITEM, () => [ORG], { authFails: true });
    const res = await call(handler, 'GET', '/api/test/organizers/5');
    assertEq(res.statusCode, 401);
  });

  // ── plan gate ──────────────────────────────────────────────────────────────
  await testAsync('a free plan gets 402 upgrade_required, not data', async () => {
    const { handler } = loadHandler(LIST, () => [], { artist: FREE_ARTIST });
    const res = await call(handler, 'GET', '/api/test/organizers');
    assertEq(res.statusCode, 402);
    assertEq(res.body?.error, 'upgrade_required');
    assertEq(res.body?.feature, 'organizers');
  });

  await testAsync('POST is gated by the plan as well', async () => {
    const { handler } = loadHandler(LIST, () => [ORG], { artist: FREE_ARTIST });
    const res = await call(handler, 'POST', '/api/test/organizers', { body: { name: 'New' } });
    assertEq(res.statusCode, 402);
  });

  // ── list ───────────────────────────────────────────────────────────────────
  await testAsync('?slim returns only id, name and city', async () => {
    const { handler, calls } = loadHandler(LIST, () => [{ id: 5, name: 'Giesserei', city: 'Konstanz' }]);
    const res = await call(handler, 'GET', '/api/test/organizers?slim=1');
    assertEq(res.statusCode, 200);
    const select = calls.find(c => c.text.includes('FROM organizers'));
    assert(!/SELECT \*/.test(select.text), 'slim must not select every column');
    assert(Array.isArray(res.body), 'slim returns a bare array');
  });

  await testAsync('a search term is passed as a pattern', async () => {
    const { handler, calls } = loadHandler(LIST, () => [{ ...ORG, total: 1 }]);
    await call(handler, 'GET', '/api/test/organizers?q=giess');
    const select = calls.find(c => c.text.includes('FROM organizers'));
    assert(select.values.includes('%giess%'), 'search pattern not applied');
  });

  // requireAuth already resolved the band (and answers 404 for an unknown
  // slug): an empty list is just empty, with no second look-up of the band.
  await testAsync('an empty list is 200 and does not look the band up again', async () => {
    const { handler, calls } = loadHandler(LIST, () => []);
    const res = await call(handler, 'GET', '/api/test/organizers');
    assertEq(res.statusCode, 200);
    assertEq(res.body.rows, []);
    assert(!calls.some(c => c.text.includes('FROM artists')), 'band looked up again');
  });

  // ── create ─────────────────────────────────────────────────────────────────
  await testAsync('POST requires a name', async () => {
    const { handler } = loadHandler(LIST, () => [ORG]);
    const res = await call(handler, 'POST', '/api/test/organizers', { body: { city: 'Konstanz' } });
    assertEq(res.statusCode, 400);
  });

  await testAsync('POST rejects an over-long name', async () => {
    const { handler } = loadHandler(LIST, () => [ORG]);
    const res = await call(handler, 'POST', '/api/test/organizers', { body: { name: 'x'.repeat(201) } });
    assertEq(res.statusCode, 400);
    assert(/^name too long/.test(res.body?.error), res.body?.error);
  });

  await testAsync('POST creates and returns 201', async () => {
    const { handler, calls } = loadHandler(LIST, () => [ORG]);
    const res = await call(handler, 'POST', '/api/test/organizers',
      { body: { name: 'Giesserei', city: 'Konstanz', type: 'organization' } });
    assertEq(res.statusCode, 201);
    const insert = calls.find(c => c.text.startsWith('INSERT INTO organizers'));
    assertEq(written(insert).name, 'Giesserei', 'name not written');
  });

  // ── item ───────────────────────────────────────────────────────────────────
  await testAsync('a non-numeric id is rejected before any query', async () => {
    const { handler, calls } = loadHandler(ITEM, () => []);
    const res = await call(handler, 'GET', '/api/test/organizers/abc');
    assertEq(res.statusCode, 400);
    assertEq(calls.length, 0);
  });

  await testAsync('every query is scoped to the artist', async () => {
    const { handler, calls } = loadHandler(ITEM, () => [ORG]);
    await call(handler, 'GET', '/api/test/organizers/5');
    const select = calls.find(c => c.text.includes('FROM organizers'));
    assert(/artist_id =/.test(select.text), 'query must filter by artist_id');
  });

  await testAsync('PUT refuses to modify a deleted organizer', async () => {
    const { handler } = loadHandler(ITEM, () => [{ ...ORG, deleted: true }]);
    const res = await call(handler, 'PUT', '/api/test/organizers/5',
      { body: { name: 'Renamed' } });
    assertEq(res.statusCode, 409);
  });

  await testAsync('PUT updates and merges social links', async () => {
    const stored = { ...ORG, social_links: { facebook: 'fb' } };
    const { handler, calls } = loadHandler(ITEM, text =>
      (text.startsWith('SELECT * FROM organizers') ? [stored] : [{ ...stored, name: 'Renamed' }]));
    const res = await call(handler, 'PUT', '/api/test/organizers/5',
      { body: { name: 'Renamed', social_links: { instagram: 'ig' } } });
    assertEq(res.statusCode, 200);
    const update = calls.find(c => c.text.startsWith('UPDATE organizers'));
    assertEq(mergedInto(update, 'social_links'), { instagram: 'ig' }, 'social links merge in SQL, not replace');
    assertEq(written(update).social_links, undefined, 'the stored object is never written whole');
  });

  // ── delete ─────────────────────────────────────────────────────────────────
  await testAsync('DELETE without hard only marks it deleted', async () => {
    const { handler, calls } = loadHandler(ITEM, text =>
      (text.startsWith('SELECT * FROM organizers') ? [ORG] : [{ ...ORG, deleted: true }]));
    const res = await call(handler, 'DELETE', '/api/test/organizers/5');
    assertEq(res.statusCode, 200);
    assert(calls.some(c => /UPDATE organizers SET deleted/.test(c.text)), 'expected a soft delete');
    assert(!calls.some(c => /DELETE FROM organizers/.test(c.text)), 'must not remove the row');
  });

  await testAsync('hard delete removes setlists before gigs before the organizer', async () => {
    const { handler, calls } = loadHandler(ITEM, () => [ORG]);
    const res = await call(handler, 'DELETE', '/api/test/organizers/5',
      { body: { hard: true, cascade: ['setlists', 'gigs'] } });
    assertEq(res.statusCode, 200);
    assertEq(res.body, { deleted: true, hard: true });
    const order = calls.map(c => c.text).filter(t => /^DELETE FROM/.test(t))
      .map(t => t.split(' ')[2]);
    assertEq(order, ['setlists', 'gigs', 'organizers'],
      'gigs.organizer_id is ON DELETE RESTRICT — the order matters');
  });

  await testAsync('hard delete without cascade leaves gigs alone', async () => {
    const { handler, calls } = loadHandler(ITEM, () => [ORG]);
    await call(handler, 'DELETE', '/api/test/organizers/5',
      { body: { hard: true } });
    assert(!calls.some(c => /DELETE FROM gigs/.test(c.text)), 'gigs must survive without cascade');
    assert(calls.some(c => /DELETE FROM organizers/.test(c.text)), 'organizer should still go');
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
