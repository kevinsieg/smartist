'use strict';

// /songs/:id/melodies/:instrument — presign, confirm and delete of a melody's
// sheet images and audio. The database and R2 are stubbed; what is checked is
// who may write what, and that storage and files stay in step.

const path = require('path');
const { makeRunner, stubLogger, viaRouter } = require('./_runner');

stubLogger();

const SECRET = 'melody-handlers-secret-32-bytes!!';
const BASE   = 'https://cdn.example.test';
const IMG    = `${BASE}/sheets/1/new.jpg`;
const IMG2   = `${BASE}/sheets/1/old.jpg`;
const AUD    = `${BASE}/audio/1/new.mp3`;
const AUD_OLD = `${BASE}/audio/1/old.mp3`;
const OTHER  = `${BASE}/sheets/2/theirs.jpg`;
const SIZES  = { 'sheets/1/new.jpg': 100, 'sheets/1/old.jpg': 30, 'audio/1/new.mp3': 500, 'audio/1/old.mp3': 200 };
const TYPES  = { jpg: 'image/jpeg', mp3: 'audio/mpeg' };

const ARTIST = { id: 1, slug: 'testband', name: 'Test Band', storage_used_bytes: 1000,
  config: { plan: 'pro', arrangementConfig: { instruments: [{ key: 'TEN', label: 'Tenor' }] } } };

function modulePath(rel) { return require.resolve(path.join(__dirname, '../..', rel)); }

function mockRes() {
  const res = { statusCode: 200, headersSent: false };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.headersSent = true; return res; };
  res.setHeader = () => {};
  return res;
}

// existing — the melody row the lookup finds; upsert — rows the INSERT returns;
// diag — answer of the "why was nothing written" read.
function load({ existing, clash = 0, upsert = [{ id: 9 }], diag = { song: true, n: 1, imgs: 1 }, removed = [{ id: 9 }], dropped = null, deleteOk = true } = {}) {
  process.env.APP_SECRET    = SECRET;
  process.env.R2_PUBLIC_URL = BASE;

  const paths = ['api/_db', 'api/_auth', 'api/_token', 'api/_band/songs/item.js', 'api/_band/songs/melodies.js', 'api/_media', 'api/_domain/melodies.js'].map(modulePath);
  for (const p of paths) delete require.cache[p];

  const deltas = [], deleted = [], presigned = [], logs = [], writes = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(' ').replace(/\s+/g, ' ');
    if (text.includes('JOIN users u2')) return [{ ...ARTIST, member_id: 7, member_role: 'member', member_password_hash: null }];
    if (text.includes('INSERT INTO song_media')) {
      writes.push({ text, values });
      if (clash-- > 0) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return upsert;
    }
    if (text.includes('AS imgs')) return [diag];
    // removeSheet: one image by url.
    if (text.includes('DELETE FROM song_media') && text.includes('AND url =')) return removed;
    // removeAudio: the recording row.
    if (text.includes('DELETE FROM song_media') && text.includes("kind = 'instrument'") && !text.includes('kind IN')) {
      writes.push({ text, values });
      return dropped && dropped.audio_url ? [{ url: dropped.audio_url }] : [];
    }
    // removeMelody: every row of the voice.
    if (text.includes('DELETE FROM song_media')) {
      return dropped ? [...(dropped.sheet_urls || []), ...(dropped.audio_url ? [dropped.audio_url] : [])].map(url => ({ url })) : [];
    }
    // getMelody: the rows of one voice.
    if (text.includes('FROM song_media') && text.includes('ORDER BY id')) {
      if (!existing) return [];
      return [
        ...(existing.sheet_urls || []).map((url, i) => ({ id: 10 + i, kind: 'sheet', instrument: existing.instrument, url, waveform: null, position: i, updated_at: 't' })),
        ...(existing.audio_url ? [{ id: 20, kind: 'instrument', instrument: existing.instrument, url: existing.audio_url, waveform: existing.waveform ?? null, position: 0, updated_at: 't' }] : []),
      ];
    }
    if (text.includes('FROM songs WHERE id')) return [{ id: 5 }];
    if (text.includes('UPDATE artists') && text.includes('storage_used_bytes')) {
      if (text.includes('<=') && deltas.__full) return [];
      deltas.push(text.includes('storage_used_bytes -') ? -Number(values[0]) : Number(values[0]));
      return [{ storage_used_bytes: 0 }];
    }
    return [];
  };

  const stub = (rel, exports) => { const p = modulePath(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('api/_ratelimit', { presignLimited: async () => false, clientIp: () => '127.0.0.1', checkRateLimit: async () => false, loginLocked: async () => false, countLoginFailure: async () => {} });
  stub('api/_email', { sendEmail: async () => {} });
  stub('api/_ai', { suggestLyricsWithAI: async () => ({ lyrics: null, skipped: true }) });
  const keyOf = url => (String(url).startsWith(BASE) ? String(url).slice(BASE.length + 1) : null);
  const headOf = key => (SIZES[key] == null ? null : { size: SIZES[key], contentType: TYPES[key.split('.').pop()] });
  stub('api/_r2', {
    createPresignedUrl: async (key, type, size) => { presigned.push({ key, type, size }); return { uploadUrl: 'https://upload.example.test', publicUrl: `${BASE}/${key}` }; },
    deleteFromR2: async url => { deleted.push(url); return deleteOk; },
    filenameFromUrl: url => String(url).split('/').pop(),
    keyFromUrl: keyOf,
    verifyUpload: async key => headOf(key),
    promoteUpload: async key => headOf(key),
  });
  stub('api/_db', {
    getDb: () => sql,
    getArtist: async slug => (slug === ARTIST.slug ? ARTIST : null),
    getSlug: req => req.query?.artist || ARTIST.slug,
    insertAuditLog: async (_sql, _a, _s, action, data) => { logs.push({ action, data }); },
    trimSongLogs: async () => {}, parsePage: () => ({ limit: 50, offset: 0 }),
  });

  const tokenApi = require(path.join(__dirname, '../../api/_token'));
  return {
    handler: viaRouter(modulePath('api/_band/songs/item.js')),
    token: tokenApi.generateUserToken(7, 'member', tokenApi.TTL_8H),
    deltas, deleted, presigned, logs, writes,
  };
}

async function call(h, { method, instrument = 'TEN', kind, body, query = {} }) {
  const res = mockRes();
  const segs = ['5', 'melodies', instrument, kind].filter(Boolean);
  await h.handler({
    method,
    url: `/api/${ARTIST.slug}/songs/${segs.join('/')}${query.url ? '?url=' + encodeURIComponent(query.url) : ''}`,
    query: { artist: ARTIST.slug, path: segs },
    headers: { authorization: `Bearer ${h.token}` },
    body,
  }, res);
  return res;
}

async function run(r) {
  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\nmelody handlers'));

  await testAsync('presign refuses a PDF sheet', async () => {
    const h = load();
    const res = await call(h, { method: 'POST', kind: 'sheet', body: { filename: 'a.pdf', contentType: 'application/pdf', size: 1000 } });
    assertEq(res.statusCode, 400);
  });

  await testAsync('presign refuses an image over 5 MB', async () => {
    const h = load();
    const res = await call(h, { method: 'POST', kind: 'sheet', body: { filename: 'a.jpg', contentType: 'image/jpeg', size: 6 * 1024 * 1024 } });
    assertEq(res.statusCode, 400);
  });

  await testAsync('presign of an image gives an upload url under sheets/<band id>/', async () => {
    const h = load();
    const res = await call(h, { method: 'POST', kind: 'sheet', body: { filename: 'a.jpg', contentType: 'image/jpeg', size: 1000 } });
    assertEq(res.statusCode, 200);
    assert(res.body.uploadUrl, 'uploadUrl missing');
    assert(h.presigned[0].key.startsWith('sheets/1/'), 'key must be scoped to the band: ' + h.presigned[0].key);
  });

  await testAsync('presign of audio uses audio/<band id>/', async () => {
    const h = load();
    const res = await call(h, { method: 'POST', kind: 'audio', body: { filename: 'a.mp3', contentType: 'audio/mpeg', size: 1000 } });
    assertEq(res.statusCode, 200);
    assert(h.presigned[0].key.startsWith('audio/1/'), h.presigned[0].key);
  });

  await testAsync('the whole song takes sheet images without being a configured instrument', async () => {
    const h = load();
    const pre = await call(h, { method: 'POST', instrument: '_song', kind: 'sheet', body: { filename: 'a.jpg', contentType: 'image/jpeg', size: 1000 } });
    assertEq(pre.statusCode, 200);
    const done = await call(h, { method: 'PUT', instrument: '_song', kind: 'sheet', body: { publicUrl: IMG } });
    assertEq(done.statusCode, 200);
    assertEq(h.writes.length, 1);
  });

  await testAsync('the whole song takes no recording', async () => {
    const h = load();
    const pre = await call(h, { method: 'POST', instrument: '_song', kind: 'audio', body: { filename: 'a.mp3', contentType: 'audio/mpeg', size: 1000 } });
    assertEq(pre.statusCode, 400);
    const done = await call(h, { method: 'PUT', instrument: '_song', kind: 'audio', body: { publicUrl: AUD } });
    assertEq(done.statusCode, 400);
    assertEq(h.writes.length, 0);
  });

  await testAsync('an instrument the band has not configured is refused', async () => {
    const h = load();
    const res = await call(h, { method: 'POST', instrument: 'XYZ', kind: 'sheet', body: { filename: 'a.jpg', contentType: 'image/jpeg', size: 1000 } });
    assertEq(res.statusCode, 400);
    assertEq(h.presigned.length, 0);
  });

  await testAsync('confirm refuses a url under another band', async () => {
    const h = load();
    const res = await call(h, { method: 'PUT', kind: 'sheet', body: { publicUrl: OTHER } });
    assertEq(res.statusCode, 400);
    assertEq(h.deltas, []);
  });

  await testAsync('confirming an image reserves its bytes, stores it and logs', async () => {
    const h = load();
    const res = await call(h, { method: 'PUT', kind: 'sheet', body: { publicUrl: IMG } });
    assertEq(res.statusCode, 200);
    assertEq(h.deltas, [100]);
    assertEq(h.logs.map(l => l.action), ['melody_replace']);
  });

  await testAsync('confirming the same image again counts nothing and deletes nothing', async () => {
    const h = load({ existing: { id: 9, instrument: 'TEN', sheet_urls: [IMG], audio_url: null } });
    const res = await call(h, { method: 'PUT', kind: 'sheet', body: { publicUrl: IMG } });
    assertEq(res.statusCode, 200);
    assertEq(h.deltas, []);
    assertEq(h.deleted, []);
  });

  await testAsync('a ninth image is refused: 409, file deleted, bytes given back', async () => {
    const h = load({ upsert: [], diag: { song: true, n: 1, imgs: 8 } });
    const res = await call(h, { method: 'PUT', kind: 'sheet', body: { publicUrl: IMG } });
    assertEq(res.statusCode, 409);
    assertEq(res.body.code, 'image_limit');
    assertEq(h.deleted, [IMG]);
    assertEq(h.deltas, [100, -100]);
  });

  await testAsync('a song that is gone answers 404 and cleans up', async () => {
    const h = load({ upsert: [], diag: { song: null, n: 0, imgs: null } });
    const res = await call(h, { method: 'PUT', kind: 'sheet', body: { publicUrl: IMG } });
    assertEq(res.statusCode, 404);
    assertEq(h.deleted, [IMG]);
  });

  await testAsync('replacing audio settles the counter once, by the net change', async () => {
    const h = load({ existing: { id: 9, instrument: 'TEN', sheet_urls: [], audio_url: AUD_OLD } });
    const res = await call(h, { method: 'PUT', kind: 'audio', body: { publicUrl: AUD } });
    assertEq(res.statusCode, 200);
    assertEq(h.deltas, [300]);
    assertEq(h.deleted, [AUD_OLD]);
  });

  await testAsync('removing one image deletes its file and subtracts its size', async () => {
    const h = load();
    const res = await call(h, { method: 'DELETE', kind: 'sheet', query: { url: IMG2 } });
    assertEq(res.statusCode, 200);
    assertEq(h.deleted, [IMG2]);
    assertEq(h.deltas, [-30]);
  });

  await testAsync('removing an image the melody does not hold is 404', async () => {
    const h = load({ removed: [] });
    const res = await call(h, { method: 'DELETE', kind: 'sheet', query: { url: IMG2 } });
    assertEq(res.statusCode, 404);
    assertEq(h.deleted, []);
  });

  const WAVE = 'ab'.repeat(100);

  await testAsync('confirming a recording stores its waveform with the url', async () => {
    const h = load();
    const res = await call(h, { method: 'PUT', kind: 'audio', body: { publicUrl: AUD, waveform: WAVE } });
    assertEq(res.statusCode, 200);
    assert(h.writes[0].values.includes(WAVE), 'waveform not written');
    assert(h.writes[0].text.includes('waveform'), h.writes[0].text);
  });

  await testAsync('a replaced recording without a waveform clears the old one', async () => {
    const h = load({ existing: { id: 9, instrument: 'TEN', sheet_urls: [], audio_url: AUD_OLD } });
    await call(h, { method: 'PUT', kind: 'audio', body: { publicUrl: AUD } });
    assert(/waveform = EXCLUDED\.waveform/.test(h.writes[0].text), h.writes[0].text);
    assert(!h.writes[0].values.includes(WAVE));
  });

  await testAsync('a malformed waveform is refused before anything is stored', async () => {
    for (const bad of ['xyz', 'AB'.repeat(100), 'ab'.repeat(99), 7]) {
      const h = load();
      const res = await call(h, { method: 'PUT', kind: 'audio', body: { publicUrl: AUD, waveform: bad } });
      assertEq(res.statusCode, 400, String(bad));
      assertEq(h.writes.length, 0);
      assertEq(h.deltas, []);
    }
  });

  await testAsync('a sheet confirm takes no waveform', async () => {
    const h = load();
    await call(h, { method: 'PUT', kind: 'sheet', body: { publicUrl: IMG, waveform: WAVE } });
    assert(!h.writes[0].values.includes(WAVE), 'waveform written for a sheet');
  });

  await testAsync('removing the audio removes its row, waveform and all', async () => {
    const h = load({ dropped: { audio_url: AUD_OLD } });
    await call(h, { method: 'DELETE', kind: 'audio' });
    assertEq(h.writes.length, 1);
    assert(/DELETE FROM song_media/.test(h.writes[0].text), h.writes[0].text);
  });

  await testAsync('the whole song is stored with no instrument, a voice with its key', async () => {
    const song = load();
    await call(song, { method: 'PUT', instrument: '_song', kind: 'sheet', body: { publicUrl: IMG } });
    assert(song.writes[0].values.includes(null), 'the whole song takes a null instrument: ' + JSON.stringify(song.writes[0].values));
    const voice = load();
    await call(voice, { method: 'PUT', kind: 'sheet', body: { publicUrl: IMG } });
    assert(voice.writes[0].values.includes('TEN'), JSON.stringify(voice.writes[0].values));
  });

  await testAsync('two images confirmed at once: the one that loses the page number tries again', async () => {
    const h = load({ clash: 1 });
    const res = await call(h, { method: 'PUT', kind: 'sheet', body: { publicUrl: IMG } });
    assertEq(res.statusCode, 200);
    assertEq(h.writes.length, 2);
    assertEq(h.deltas, [100]);
  });

  await testAsync('a page number that keeps clashing ends in an error, not a loop', async () => {
    const h = load({ clash: 99 });
    const res = await call(h, { method: 'PUT', kind: 'sheet', body: { publicUrl: IMG } });
    assertEq(res.statusCode, 500);
    assertEq(h.writes.length, 4);
  });

  await testAsync('removing the audio deletes the file', async () => {
    const h = load({ dropped: { audio_url: AUD_OLD } });
    const res = await call(h, { method: 'DELETE', kind: 'audio' });
    assertEq(res.statusCode, 200);
    assertEq(h.deleted, [AUD_OLD]);
    assertEq(h.deltas, [-200]);
  });

  await testAsync('removing a melody deletes every file it held', async () => {
    const h = load({ dropped: { sheet_urls: [IMG, IMG2], audio_url: AUD_OLD } });
    const res = await call(h, { method: 'DELETE' });
    assertEq(res.statusCode, 200);
    assertEq(h.deleted.slice().sort(), [AUD_OLD, IMG, IMG2].sort());
    assertEq(h.deltas.reduce((a, b) => a + b, 0), -330);
  });

  await testAsync('a failed storage delete does not credit the bytes back', async () => {
    const h = load({ dropped: { audio_url: AUD_OLD }, deleteOk: false });
    const res = await call(h, { method: 'DELETE', kind: 'audio' });
    assertEq(res.statusCode, 200);
    assertEq(h.deltas, []);
  });

  await testAsync('removing a melody that holds nothing is 404', async () => {
    const h = load({ dropped: { sheet_urls: [], audio_url: null } });
    const res = await call(h, { method: 'DELETE' });
    assertEq(res.statusCode, 404);
  });

  await testAsync('removing a melody whose instrument left the settings still works', async () => {
    const h = load({ dropped: { sheet_urls: [IMG], audio_url: null } });
    const res = await call(h, { method: 'DELETE', instrument: 'GONE' });
    assertEq(res.statusCode, 200);
  });

  await testAsync('a kind that only exists on Object.prototype is 404, and deletes nothing', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const h = load({ dropped: { sheet_urls: [IMG], audio_url: AUD_OLD } });
      const res = await call(h, { method, kind: 'constructor', body: { filename: 'a.jpg', contentType: 'image/jpeg', size: 1, publicUrl: IMG } });
      assertEq(res.statusCode, 404, method);
      assertEq(h.deleted, [], method);
    }
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
