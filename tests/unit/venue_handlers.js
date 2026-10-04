'use strict';

// Venue POST/PUT handling of the phone and contact_name fields.

const path = require('path');
const { makeRunner, stubLogger, viaRouter } = require('./_runner');

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

// Records every statement with its interpolated values; route(text) answers.
function loadHandler(rel, route, opts) {
  const dbPath = mp('api/_db'), authPath = mp('api/_auth'), handlerPath = mp(rel);
  for (const p of [dbPath, authPath, handlerPath]) delete require.cache[p];
  const calls = [];
  // postgres.js has two call shapes: tagged template (query) and sql(identifier)
  // / sql`fragment` used inside another query. The stub answers both.
  const sql = (strings, ...values) => {
    // sql({ col: value }) — the insert/update helper: keep the object.
    if (strings && typeof strings === 'object' && !Array.isArray(strings)) return { helper: strings };
    if (!Array.isArray(strings)) return { fragment: String(strings) };
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    const isFragment = !/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(text);
    if (isFragment) return { fragment: text, values };
    calls.push({ text, values });
    return Promise.resolve(route(text));
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async () => ARTIST,
      getSlug: () => 'test',
      insertAuditLog: async () => {}, trimSongLogs: async () => {},
      parsePage: () => ({ limit: 50, offset: 0 }),
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { refuseDemo: (req, res) => { if (req.user && req.user.id === null) { res.status(403).json({ error: 'demo' }); return true; } return false; },
      requireAuth: async (req, res) => {
        if (opts && opts.authFails) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        req.user = { id: 1, role: 'member' }; return ARTIST;
      },
      getAccess: async () => ({ artist: ARTIST, user: { id: 1, role: 'member' } }),
      // Handlers ask these directly now; a stub that omits them throws.
      canBrowseCatalogue: () => false,
      canOpenStage: () => true,
    },
  };
  const began = { value: false };
  sql.begin = async fn => { began.value = true; return fn(sql); };
  return { handler: viaRouter(path.join(__dirname, '../..', rel)), calls, began };
}

async function call(handler, method, url, body) {
  const res = mockRes();
  await handler({ method, url, query: { artist: 'test' }, headers: {}, body }, res);
  return res;
}

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

const STORED = { id: 5, artist_id: 1, name: 'Old', deleted: false, phone: '+49 1', contact_name: 'Anna', social_links: {} };
const byId = text => (text.startsWith('SELECT * FROM venues') ? [STORED] : [{ ...STORED }]);

async function run(r) {
  await r.testAsync('venue reads always need a session — no setting opens them', async () => {
    // Venue rows carry contact_name, phone and generic_email. The old private
    // flag published them when switched off; there is deliberately no flag now.
    const { handler, calls } = loadHandler('api/_band/venues.js', () => [], { authFails: true });
    const res = await call(handler, 'GET', '/api/test/venues');
    r.assertEq(res.statusCode, 401);
    r.assertEq(calls.length, 0, 'must not query before the auth gate');
  });

  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\nvenue handlers (phone, contact_name)'));

  await testAsync('POST stores phone and contact_name', async () => {
    const { handler, calls } = loadHandler('api/_band/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', phone: ' 0711 123 ', contact_name: 'Max' });
    assertEq(res.statusCode, 201);
    const insert = calls.find(c => c.text.startsWith('INSERT INTO venues'));
    assertEq(written(insert).phone, '0711 123', 'trimmed phone not passed');
    assertEq(written(insert).contact_name, 'Max', 'contact_name not passed');
    assertEq(written(insert).artist_id, 1, 'artist_id comes from the session');
  });

  await testAsync('POST stores postcode, generic_email and website', async () => {
    const { handler, calls } = loadHandler('api/_band/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues',
      { name: 'Club', postcode: '78462', generic_email: 'booking@club.de', website: 'https://club.de' });
    assertEq(res.statusCode, 201);
    const insert = calls.find(c => c.text.startsWith('INSERT INTO venues'));
    assertEq(written(insert).postcode, '78462');
    assertEq(written(insert).generic_email, 'booking@club.de');
    assertEq(written(insert).website, 'https://club.de');
  });

  await testAsync('POST rejects postcode over 20 chars → 400', async () => {
    const { handler } = loadHandler('api/_band/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', postcode: '1'.repeat(21) });
    assertEq(res.statusCode, 400);
    assert(/^postcode too long/.test(res.body?.error), res.body?.error);
  });

  await testAsync('POST rejects website over 500 chars → 400', async () => {
    const { handler } = loadHandler('api/_band/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', website: 'https://x.de/' + 'a'.repeat(500) });
    assertEq(res.statusCode, 400);
    assert(/^website too long/.test(res.body?.error), res.body?.error);
  });

  await testAsync('POST rejects generic_email over 254 chars → 400', async () => {
    const { handler } = loadHandler('api/_band/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', generic_email: 'a'.repeat(250) + '@x.de' });
    assertEq(res.statusCode, 400);
    assert(/^generic_email too long/.test(res.body?.error), res.body?.error);
  });

  await testAsync('POST rejects phone over 100 chars → 400', async () => {
    const { handler } = loadHandler('api/_band/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', phone: 'x'.repeat(101) });
    assertEq(res.statusCode, 400);
    assert(/^phone too long/.test(res.body?.error), res.body?.error);
  });

  await testAsync('POST rejects contact_name over 200 chars → 400', async () => {
    const { handler } = loadHandler('api/_band/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', contact_name: 'x'.repeat(201) });
    assertEq(res.statusCode, 400);
    assert(/^contact_name too long/.test(res.body?.error), res.body?.error);
  });

  await testAsync('PUT updates phone and contact_name', async () => {
    const { handler, calls } = loadHandler('api/_band/venues/item.js', byId);
    const res = await call(handler, 'PUT', '/api/test/venues/5', { name: 'Old', phone: '+41 2', contact_name: 'Ben' });
    assertEq(res.statusCode, 200);
    const update = calls.find(c => c.text.startsWith('UPDATE venues'));
    assertEq(written(update).phone, '+41 2');
    assertEq(written(update).contact_name, 'Ben');
  });

  await testAsync('PUT writes only the fields sent', async () => {
    const { handler, calls } = loadHandler('api/_band/venues/item.js', byId);
    const res = await call(handler, 'PUT', '/api/test/venues/5', { name: 'Old' });
    assertEq(res.statusCode, 200);
    const update = calls.find(c => c.text.startsWith('UPDATE venues'));
    assertEq(Object.keys(written(update)), ['name'], 'untouched fields must not be written');
  });

  await testAsync('PUT with null clears a field; bad values are 400, not 500', async () => {
    const { handler, calls } = loadHandler('api/_band/venues/item.js', byId);
    const res = await call(handler, 'PUT', '/api/test/venues/5', { phone: null });
    assertEq(res.statusCode, 200);
    assertEq(written(calls.find(c => c.text.startsWith('UPDATE venues'))).phone, null);
    for (const body of [{ size: 'big' }, { deadline: '2026-02-31' }, { website: 'javascript:alert(1)' }, { name: '' }, { alive: 'maybe' }]) {
      const bad = await call(loadHandler('api/_band/venues/item.js', byId).handler, 'PUT', '/api/test/venues/5', body);
      assertEq(bad.statusCode, 400, JSON.stringify(body));
    }
  });

  await testAsync('GET sorts by a whitelisted column', async () => {
    const { handler, calls } = loadHandler('api/_band/venues.js', () => []);
    const res = mockRes();
    await handler({ method: 'GET', url: '/api/test/venues?sort=last_communication&dir=desc', headers: {} }, res);
    const select = calls.find(c => c.text.includes('FROM venues'));
    assert(JSON.stringify(select.values).includes('last_communication'), 'sort column not used in ORDER BY');
    assert(JSON.stringify(select.values).includes('DESC'), 'sort direction not applied');
  });

  await testAsync('GET ignores an unknown sort column (no SQL injection)', async () => {
    const { handler, calls } = loadHandler('api/_band/venues.js', () => []);
    const res = mockRes();
    await handler({ method: 'GET', url: '/api/test/venues?sort=' + encodeURIComponent('name; DROP TABLE venues'), headers: {} }, res);
    const select = calls.find(c => c.text.includes('FROM venues'));
    assert(!select.text.includes('DROP TABLE'), 'raw sort value reached the query');
    assert(!JSON.stringify(select.values).includes('DROP TABLE'), 'raw sort value passed into the query');
    assert(JSON.stringify(select.values).includes("category = 'placeholder'"), 'should fall back to the default order');
  });

  await testAsync('GET filters by letter for the A-Z jump', async () => {
    const { handler, calls } = loadHandler('api/_band/venues.js', () => []);
    const res = mockRes();
    await handler({ method: 'GET', url: '/api/test/venues?letter=K', headers: {} }, res);
    const select = calls.find(c => c.text.includes('FROM venues'));
    assert(select.values.includes('K%'), 'letter filter not applied');
  });

  await testAsync('GET ignores a letter that is not a single character', async () => {
    const { handler, calls } = loadHandler('api/_band/venues.js', () => []);
    const res = mockRes();
    await handler({ method: 'GET', url: '/api/test/venues?letter=Kon', headers: {} }, res);
    const select = calls.find(c => c.text.includes('FROM venues'));
    assert(!select.values.includes('Kon%'), 'multi-character letter should be ignored');
  });

  await testAsync('PATCH updates only the fields sent and keeps the rest', async () => {
    const stored = { id: 5, artist_id: 1, status: 'prospect', category: 'pub', comment: 'old note',
      booking_channel: 'email', season: 'summer', preferred_period: 'June', remuneration: '150',
      last_communication: '2026-01-01', deadline: null };
    const { handler, calls } = loadHandler('api/_band/venues.js',
      text => (text.startsWith('SELECT * FROM venues') ? [stored] : [{ ...stored, status: 'contacted' }]));
    const res = await call(handler, 'PATCH', '/api/test/venues', [{ id: 5, status: 'contacted', comment: '' }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 1);
    const update = calls.find(c => c.text.startsWith('UPDATE venues'));
    const sent = JSON.stringify(update.values);
    assert(sent.includes('contacted'), 'new status not passed');
    assert(sent.includes('pub'), 'untouched category not kept');
    assert(sent.includes('email'), 'untouched booking_channel not kept');
    assert(sent.includes('null'), 'cleared comment should be null');
  });

  await testAsync('PATCH reports which rows were rejected and why', async () => {
    const stored = { id: 5, artist_id: 1, status: null, category: null, comment: null, booking_channel: null,
      season: null, preferred_period: null, remuneration: null, last_communication: null, deadline: null };
    const { handler } = loadHandler('api/_band/venues.js',
      text => (text.startsWith('SELECT * FROM venues') ? [stored] : [stored]));
    const res = await call(handler, 'PATCH', '/api/test/venues', [
      { id: 5, last_communication: 'gestern' },
      { id: 6, status: 'x'.repeat(60) },
    ]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 0);
    assertEq(res.body?.rejected?.length, 2);
    assertEq(res.body.rejected[0].id, 5);
    assert(/date/i.test(res.body.rejected[0].error), 'date error not reported: ' + res.body.rejected[0].error);
    assertEq(res.body.rejected[1].id, 6);
    assert(/not found|too long/i.test(res.body.rejected[1].error), 'reason missing: ' + res.body.rejected[1].error);
  });

  await testAsync('PATCH writes all rows in one transaction', async () => {
    const stored = id => ({ id, artist_id: 1, status: null, category: null, comment: null, booking_channel: null,
      season: null, preferred_period: null, remuneration: null, last_communication: null, deadline: null });
    const { handler, calls, began } = loadHandler('api/_band/venues.js',
      text => (text.startsWith('SELECT * FROM venues') ? [stored(5), stored(6)] : [{ id: 5 }, { id: 6 }]));
    const res = await call(handler, 'PATCH', '/api/test/venues',
      [{ id: 5, status: 'contacted' }, { id: 6, status: 'declined' }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 2);
    assert(began.value, 'writes must run inside sql.begin');
    const updates = calls.filter(c => c.text.startsWith('UPDATE venues'));
    assert(updates.length <= 1, `expected one batched UPDATE, got ${updates.length}`);
  });

  await testAsync('PATCH skips rows with an invalid date and reports the count', async () => {
    const stored = { id: 5, artist_id: 1, status: null, category: null, comment: null, booking_channel: null,
      season: null, preferred_period: null, remuneration: null, last_communication: null, deadline: null };
    const { handler } = loadHandler('api/_band/venues.js',
      text => (text.startsWith('SELECT * FROM venues') ? [stored] : [stored]));
    const res = await call(handler, 'PATCH', '/api/test/venues', [{ id: 5, last_communication: 'gestern' }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 0);
  });

  await testAsync('PATCH accepts a date and clears one with an empty string', async () => {
    const stored = { id: 5, artist_id: 1, status: null, category: null, comment: null, booking_channel: null,
      season: null, preferred_period: null, remuneration: null, last_communication: '2020-01-01', deadline: '2020-02-02' };
    const { handler, calls } = loadHandler('api/_band/venues.js',
      text => (text.startsWith('SELECT * FROM venues') ? [stored] : [stored]));
    const res = await call(handler, 'PATCH', '/api/test/venues', [{ id: 5, last_communication: '2026-09-21', deadline: '' }]);
    assertEq(res.body?.count, 1);
    const update = calls.find(c => c.text.startsWith('UPDATE venues'));
    assert(JSON.stringify(update.values).includes('2026-09-21'), 'date not passed');
  });

  await testAsync('PATCH without an array → 400', async () => {
    const { handler } = loadHandler('api/_band/venues.js', () => []);
    const res = await call(handler, 'PATCH', '/api/test/venues', { id: 5 });
    assertEq(res.statusCode, 400);
  });

  await testAsync('PATCH with more than 200 rows → 400', async () => {
    const { handler } = loadHandler('api/_band/venues.js', () => []);
    const res = await call(handler, 'PATCH', '/api/test/venues', Array.from({ length: 201 }, (_, i) => ({ id: i + 1 })));
    assertEq(res.statusCode, 400);
  });

  await testAsync('PATCH ignores ids that belong to another artist', async () => {
    const { handler } = loadHandler('api/_band/venues.js',
      text => (text.startsWith('SELECT * FROM venues') ? [] : []));
    const res = await call(handler, 'PATCH', '/api/test/venues', [{ id: 999, status: 'contacted' }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.count, 0);
  });

  await testAsync('PUT rejects phone over 100 chars → 400', async () => {
    const { handler } = loadHandler('api/_band/venues/item.js', byId);
    const res = await call(handler, 'PUT', '/api/test/venues/5', { name: 'Old', phone: 'x'.repeat(101) });
    assertEq(res.statusCode, 400);
    assert(/^phone too long/.test(res.body?.error), res.body?.error);
  });

  await testAsync('PATCH with an impossible calendar date rejects that row instead of failing the batch', async () => {
    const stored = { id: 5, artist_id: 1, status: null, category: null, comment: null, booking_channel: null,
      season: null, preferred_period: null, remuneration: null, last_communication: null, deadline: null };
    const { handler, calls } = loadHandler('api/_band/venues.js', () => [stored]);
    const res = await call(handler, 'PATCH', '/api/test/venues', [{ id: 5, deadline: '2026-02-30' }]);
    assertEq(res.statusCode, 200);
    assertEq(res.body?.rejected?.[0]?.id, 5);
    assert(!calls.some(c => c.text.startsWith('UPDATE venues')), 'an impossible date reached the database');
  });

}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
