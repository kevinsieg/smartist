const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

const { clientIp } =
  require(path.join(__dirname, '../../api/_ratelimit'));

function run(r) {
  const { test, assertEq, B } = r;

  console.log(B('\nrate-limit helpers'));

  test('clientIp uses x-real-ip when present', () => {
    assertEq(
      clientIp({ headers: { 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }),
      '5.5.5.5'
    );
  });
  test('clientIp trims x-real-ip whitespace', () => {
    assertEq(clientIp({ headers: { 'x-real-ip': ' 2001:db8::1 ' } }), '2001:db8::1');
  });
  test('clientIp falls back to leftmost x-forwarded-for when x-real-ip absent', () => {
    assertEq(
      clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }),
      '1.2.3.4'
    );
  });
  test('clientIp trims forwarded-for whitespace', () => {
    assertEq(clientIp({ headers: { 'x-forwarded-for': ' 203.0.113.10 , 10.0.0.2' } }), '203.0.113.10');
  });
  test('clientIp single forwarded-for value', () => {
    assertEq(clientIp({ headers: { 'x-forwarded-for': '203.0.113.10' } }), '203.0.113.10');
  });
  test('clientIp missing both headers → unknown', () => {
    assertEq(clientIp({ headers: {} }), 'unknown');
  });
  return runAbuseLimits(r);
}

// The abuse limits on a counting fake of the rate_limits table.
async function runAbuseLimits(r) {
  const { testAsync, assertEq, B } = r;
  console.log(B('\nabuse limits'));
  const dbPath = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  function load() {
    const counts = {};
    const sql = (strings, ...values) => {
      const text = strings.join('?');
      if (!text.includes('INSERT INTO rate_limits')) return Promise.resolve([]);
      const key = values[0];
      counts[key] = (counts[key] || 0) + 1;
      return Promise.resolve([{ count: counts[key] }]);
    };
    const saved = { db: require.cache[dbPath], rl: require.cache[rlPath] };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
    delete require.cache[rlPath];
    const mod = require(rlPath);
    require.cache[dbPath] = saved.db; require.cache[rlPath] = saved.rl;
    if (!saved.db) delete require.cache[dbPath];
    return { mod, counts };
  }
  const realRandom = Math.random;
  Math.random = () => 0.5;   // no sweep
  try {
    await testAsync('one sender is stopped after MAIL_OUT_PERSON_DAILY mails, across bands', async () => {
      const { mod } = load();
      for (let i = 0; i < mod.MAIL_OUT_PERSON_DAILY; i++)
        assertEq(await mod.outboundMailLimited('A@x.test'), false);
      assertEq(await mod.outboundMailLimited('a@x.test'), true);
      assertEq(await mod.outboundMailLimited('b@x.test'), false);
    });
    await testAsync('everyone together is stopped after MAIL_OUT_DAILY mails', async () => {
      const { mod } = load();
      for (let i = 0; i < mod.MAIL_OUT_DAILY; i++) await mod.outboundMailLimited(`p${i}@x.test`);
      assertEq(await mod.outboundMailLimited('fresh@x.test'), true);
    });
    await testAsync('presigns are capped per band per hour', async () => {
      const { mod } = load();
      for (let i = 0; i < mod.PRESIGN_PER_HOUR; i++) assertEq(await mod.presignLimited(1), false);
      assertEq(await mod.presignLimited(1), true);
      assertEq(await mod.presignLimited(2), false);
    });
  } finally {
    Math.random = realRandom;
  }

  await testAsync('a rejected media presign costs the band nothing', async () => {
    const res = rel => require.resolve(path.join(__dirname, '../../api', rel));
    const paths = { rl: rlPath, media: res('_media'), auth: res('_auth'), db: res('_db') };
    const saved = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, require.cache[p]]));
    const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
    let counted = 0;
    stub(paths.rl,   { ...require(rlPath), presignLimited: async () => { counted++; return false; } });
    stub(paths.auth, { ...require(paths.auth), requireAuth: async () => ({ id: 1 }), refuseDemo: () => false });
    stub(paths.db,   { ...require(paths.db), getDb: () => async () => [{ id: 1 }], getSlug: () => 'band' });
    delete require.cache[paths.media];
    try {
      const { makeMediaFn, MEDIA_CONFIGS } = require(paths.media);
      const handler = makeMediaFn(MEDIA_CONFIGS.audio);
      for (const body of [{}, { filename: 'a.exe', contentType: 'audio/mpeg', size: 10 }, { filename: 'a.mp3', contentType: 'audio/mpeg' }]) {
        let status = null;
        await handler({ method: 'POST', query: { id: '1' }, body }, { status: s => { status = s; return { json: () => {} }; } });
        assertEq(status, 400);
      }
      assertEq(counted, 0);
    } finally {
      for (const [k, p] of Object.entries(paths)) {
        if (saved[k]) require.cache[p] = saved[k]; else delete require.cache[p];
      }
    }
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
