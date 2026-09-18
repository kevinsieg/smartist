'use strict';

// Venue POST/PUT handling of the phone and contact_name fields.

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

// Records every statement with its interpolated values; route(text) answers.
function loadHandler(rel, route) {
  const dbPath = mp('api/_db'), authPath = mp('api/_auth'), handlerPath = mp(rel);
  for (const p of [dbPath, authPath, handlerPath]) delete require.cache[p];
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    return route(text);
  };
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
      isPrivate: () => false,
    },
  };
  return { handler: require(path.join(__dirname, '../..', rel)), calls };
}

async function call(handler, method, url, body) {
  const res = mockRes();
  await handler({ method, url, query: { artist: 'test' }, headers: {}, body }, res);
  return res;
}

const STORED = { id: 5, artist_id: 1, name: 'Old', deleted: false, phone: '+49 1', contact_name: 'Anna', social_links: {} };
const byId = text => (text.startsWith('SELECT * FROM venues') ? [STORED] : [{ ...STORED }]);

async function run(r) {
  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\nvenue handlers (phone, contact_name)'));

  await testAsync('POST stores phone and contact_name', async () => {
    const { handler, calls } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', phone: ' 0711 123 ', contact_name: 'Max' });
    assertEq(res.statusCode, 201);
    const insert = calls.find(c => c.text.startsWith('INSERT INTO venues'));
    assert(insert.text.includes('phone') && insert.text.includes('contact_name'), 'columns missing in INSERT');
    assert(insert.values.includes('0711 123'), 'trimmed phone not passed');
    assert(insert.values.includes('Max'), 'contact_name not passed');
  });

  await testAsync('POST stores postcode, generic_email and website', async () => {
    const { handler, calls } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues',
      { name: 'Club', postcode: '78462', generic_email: 'booking@club.de', website: 'https://club.de' });
    assertEq(res.statusCode, 201);
    const insert = calls.find(c => c.text.startsWith('INSERT INTO venues'));
    for (const col of ['postcode', 'generic_email', 'website']) assert(insert.text.includes(col), `${col} missing in INSERT`);
    for (const val of ['78462', 'booking@club.de', 'https://club.de']) assert(insert.values.includes(val), `${val} not passed`);
  });

  await testAsync('POST rejects postcode over 20 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', postcode: '1'.repeat(21) });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'postcode too long');
  });

  await testAsync('POST rejects website over 500 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', website: 'https://x.de/' + 'a'.repeat(500) });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'website too long');
  });

  await testAsync('POST rejects generic_email over 254 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', generic_email: 'a'.repeat(250) + '@x.de' });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'generic_email too long');
  });

  await testAsync('POST rejects phone over 100 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', phone: 'x'.repeat(101) });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'phone too long');
  });

  await testAsync('POST rejects contact_name over 200 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', '/api/test/venues', { name: 'Club', contact_name: 'x'.repeat(201) });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'contact_name too long');
  });

  await testAsync('PUT updates phone and contact_name', async () => {
    const { handler, calls } = loadHandler('api/[artist]/venues/[...path].js', byId);
    const res = await call(handler, 'PUT', '/api/test/venues/5', { name: 'Old', phone: '+41 2', contact_name: 'Ben' });
    assertEq(res.statusCode, 200);
    const update = calls.find(c => c.text.startsWith('UPDATE venues'));
    assert(update.values.includes('+41 2') && update.values.includes('Ben'), 'new values not passed to UPDATE');
  });

  await testAsync('PUT without the fields keeps stored values', async () => {
    const { handler, calls } = loadHandler('api/[artist]/venues/[...path].js', byId);
    const res = await call(handler, 'PUT', '/api/test/venues/5', { name: 'Old' });
    assertEq(res.statusCode, 200);
    const update = calls.find(c => c.text.startsWith('UPDATE venues'));
    assert(update.values.includes('+49 1') && update.values.includes('Anna'), 'stored values not kept');
  });

  await testAsync('PUT rejects phone over 100 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues/[...path].js', byId);
    const res = await call(handler, 'PUT', '/api/test/venues/5', { name: 'Old', phone: 'x'.repeat(101) });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'phone too long');
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
