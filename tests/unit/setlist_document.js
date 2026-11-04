'use strict';

// /setlists/:id/document — presign, confirm and delete of the PDF attached to a
// setlist (the evening's schedule). The database and R2 are stubbed; what is
// checked is who may attach what, and that storage and files stay in step.

const path = require('path');
const { stubLogger, viaRouter } = require('./_runner');

stubLogger();

const SECRET = 'setlist-document-secret-32-bytes!';
const BASE   = 'https://cdn.example.test';
const NEW    = `${BASE}/documents/1/aaaaaaaa-1111-2222-3333-444444444444-new-schedule.pdf`;
const OLD    = `${BASE}/documents/1/bbbbbbbb-1111-2222-3333-444444444444-old-schedule.pdf`;
const OTHER  = `${BASE}/documents/2/uuid-theirs.pdf`;
const SIZES  = { 'documents/1/aaaaaaaa-1111-2222-3333-444444444444-new-schedule.pdf': 400, 'documents/1/bbbbbbbb-1111-2222-3333-444444444444-old-schedule.pdf': 150 };

const ARTIST = { id: 1, slug: 'testband', name: 'Test Band', storage_used_bytes: 1000, config: { plan: 'pro' } };

function modulePath(rel) { return require.resolve(path.join(__dirname, '../..', rel)); }

function mockRes() {
  const res = { statusCode: 200, headersSent: false };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.headersSent = true; return res; };
  res.setHeader = () => {};
  return res;
}

// current — the url on the setlist now (null = none); exists — whether the band has setlist 3.
function load({ current = null, exists = true, full = false, deleteOk = true, type = 'application/pdf' } = {}) {
  process.env.APP_SECRET    = SECRET;
  process.env.R2_PUBLIC_URL = BASE;

  const paths = ['api/_db', 'api/_auth', 'api/_token', 'api/_band/setlists/item.js', 'api/_band/setlists/document.js', 'api/_media'].map(modulePath);
  for (const p of paths) delete require.cache[p];

  const deltas = [], deleted = [], presigned = [], writes = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(' ').replace(/\s+/g, ' ');
    if (text.includes('JOIN users u2')) return [{ ...ARTIST, member_id: 7, member_role: 'member', member_password_hash: null }];
    if (text.includes('UPDATE artists') && text.includes('storage_used_bytes')) {
      if (text.includes('<=') && full) return [];
      deltas.push(text.includes('storage_used_bytes -') ? -Number(values[0]) : Number(values[0]));
      return [{ storage_used_bytes: 0 }];
    }
    if (text.includes('UPDATE setlists SET document_url')) {
      writes.push({ text, values });
      return exists ? [{ document_url: current }] : [];
    }
    if (text.includes('DELETE FROM setlists')) return exists ? [{ id: 3, document_url: current }] : [];
    if (text.includes('FROM setlists')) return exists ? [{ id: 3, document_url: current }] : [];
    return [];
  };

  const stub = (rel, exports) => { const p = modulePath(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('api/_ratelimit', { presignLimited: async () => false, clientIp: () => '127.0.0.1', checkRateLimit: async () => false, loginLocked: async () => false, countLoginFailure: async () => {}, outboundMailLimited: async () => false });
  stub('api/_email', { sendEmail: async () => {} });
  const keyOf = url => (String(url).startsWith(BASE) ? String(url).slice(BASE.length + 1) : null);
  const headOf = key => (SIZES[key] == null ? null : { size: SIZES[key], contentType: type });
  stub('api/_r2', {
    createPresignedUrl: async (key, t, size) => { presigned.push({ key, type: t, size }); return { uploadUrl: 'https://upload.example.test', publicUrl: `${BASE}/${key}` }; },
    deleteFromR2: async url => { deleted.push(url); return deleteOk; },
    filenameFromUrl: url => decodeURIComponent(String(url).split('/').pop()),
    keyFromUrl: keyOf,
    verifyUpload: async key => headOf(key),
    promoteUpload: async key => headOf(key),
  });
  stub('api/_db', {
    getDb: () => sql,
    getArtist: async slug => (slug === ARTIST.slug ? ARTIST : null),
    getSlug: req => req.query?.artist || ARTIST.slug,
    insertAuditLog: async () => {}, trimSongLogs: async () => {}, parsePage: () => ({ limit: 50, offset: 0 }),
  });

  const tokenApi = require(path.join(__dirname, '../../api/_token'));
  return {
    handler: viaRouter(modulePath('api/_band/setlists/item.js')),
    token: tokenApi.generateUserToken(7, 'member', tokenApi.TTL_8H),
    deltas, deleted, presigned, writes,
  };
}

async function call(h, { method, action = 'document', body, auth = true }) {
  const res = mockRes();
  const segs = ['3', action].filter(Boolean);
  await h.handler({
    method,
    url: `/api/${ARTIST.slug}/setlists/${segs.join('/')}`,
    query: { artist: ARTIST.slug, path: segs },
    headers: auth ? { authorization: `Bearer ${h.token}` } : {},
    body,
  }, res);
  return res;
}

async function run(r) {
  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\nsetlist document'));

  await testAsync('attaching needs a signed-in member', async () => {
    const res = await call(load(), { method: 'POST', body: { filename: 'a.pdf', contentType: 'application/pdf', size: 1000 }, auth: false });
    assertEq(res.statusCode, 401);
  });

  await testAsync('presign answers an upload address under the band\'s documents/ prefix', async () => {
    const h = load();
    const res = await call(h, { method: 'POST', body: { filename: 'Run of show.pdf', contentType: 'application/pdf', size: 1000 } });
    assertEq(res.statusCode, 200);
    assert(/^documents\/1\/[0-9a-f-]+-Run_of_show\.pdf$/.test(h.presigned[0].key), h.presigned[0].key);
    assertEq(h.presigned[0].type, 'application/pdf');
  });

  await testAsync('presign refuses anything but a PDF, and a PDF over 20 MB', async () => {
    const h = load();
    assertEq((await call(h, { method: 'POST', body: { filename: 'a.docx', contentType: 'application/pdf', size: 1000 } })).statusCode, 400);
    assertEq((await call(h, { method: 'POST', body: { filename: 'a.pdf', contentType: 'text/html', size: 1000 } })).statusCode, 400);
    assertEq((await call(h, { method: 'POST', body: { filename: 'a.pdf', contentType: 'application/pdf', size: 21 * 1024 * 1024 } })).statusCode, 400);
    assertEq(h.presigned.length, 0);
  });

  await testAsync('presign for a setlist that is not the band\'s is a 404', async () => {
    const res = await call(load({ exists: false }), { method: 'POST', body: { filename: 'a.pdf', contentType: 'application/pdf', size: 1000 } });
    assertEq(res.statusCode, 404);
  });

  await testAsync('confirm stores the address and the file name, and counts the bytes', async () => {
    const h = load();
    const res = await call(h, { method: 'PUT', body: { publicUrl: NEW } });
    assertEq(res.statusCode, 200);
    assertEq(res.body.document_url, NEW);
    assertEq(res.body.document_name, 'new-schedule.pdf');
    assertEq(h.deltas, [400]);
  });

  await testAsync('confirm refuses an address outside the band\'s own documents/', async () => {
    const h = load();
    assertEq((await call(h, { method: 'PUT', body: { publicUrl: OTHER } })).statusCode, 400);
    assertEq((await call(h, { method: 'PUT', body: { publicUrl: `${BASE}/audio/1/x.pdf` } })).statusCode, 400);
    assertEq(h.writes.length, 0);
  });

  await testAsync('confirm refuses a file that is not a PDF and removes it', async () => {
    const h = load({ type: 'text/html' });
    assertEq((await call(h, { method: 'PUT', body: { publicUrl: NEW } })).statusCode, 400);
    assertEq(h.deleted, [NEW]);
  });

  await testAsync('a full storage quota is a 402 and the upload is removed', async () => {
    const h = load({ full: true });
    const res = await call(h, { method: 'PUT', body: { publicUrl: NEW } });
    assertEq(res.statusCode, 402);
    assertEq(res.body.code, 'storage_limit');
    assertEq(h.deleted, [NEW]);
    assertEq(h.writes.length, 0);
  });

  await testAsync('replacing a file removes the old one and counts only the difference', async () => {
    const h = load({ current: OLD });
    const res = await call(h, { method: 'PUT', body: { publicUrl: NEW } });
    assertEq(res.statusCode, 200);
    assertEq(h.deleted, [OLD]);
    assertEq(h.deltas, [250]);
  });

  await testAsync('confirming the address already stored changes nothing', async () => {
    const h = load({ current: NEW });
    assertEq((await call(h, { method: 'PUT', body: { publicUrl: NEW } })).statusCode, 200);
    assertEq(h.deleted.length, 0);
    assertEq(h.deltas.length, 0);
  });

  await testAsync('delete removes the file and gives its bytes back', async () => {
    const h = load({ current: OLD });
    const res = await call(h, { method: 'DELETE' });
    assertEq(res.statusCode, 200);
    assertEq(h.deleted, [OLD]);
    assertEq(h.deltas, [-150]);
  });

  await testAsync('delete keeps the bytes counted when the file could not be removed', async () => {
    const h = load({ current: OLD, deleteOk: false });
    assertEq((await call(h, { method: 'DELETE' })).statusCode, 200);
    assertEq(h.deltas.length, 0);
  });

  await testAsync('deleting the setlist removes its document too', async () => {
    const h = load({ current: OLD });
    const res = await call(h, { method: 'DELETE', action: null });
    assertEq(res.statusCode, 200);
    assertEq(h.deleted, [OLD]);
    assertEq(h.deltas, [-150]);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
