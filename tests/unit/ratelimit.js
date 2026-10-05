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
  const { testAsync, assert, assertEq, B } = r;
  console.log(B('\nabuse limits'));
  const dbPath = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  function load() {
    const counts = {};
    const sql = (strings, ...values) => {
      const text = strings.join('?');
      if (!text.includes('INSERT INTO rate_limits')) return Promise.resolve([]);
      // Every counter goes through countInWindows: one INSERT, the keys as a
      // JSON recordset, one statement for all of them.
      statements++;
      return Promise.resolve(values[0].map(({ key }) => {
        counts[key] = (counts[key] || 0) + 1;
        return { key, count: counts[key] };
      }));
    };
    sql.json = v => v;
    let statements = 0;
    const alarms = [];
    const logPath = require.resolve(path.join(__dirname, '../../api/_logger'));
    const saved = { db: require.cache[dbPath], rl: require.cache[rlPath], log: require.cache[logPath] };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => sql } };
    require.cache[logPath] = { id: logPath, filename: logPath, loaded: true,
      exports: { error: async (event, data) => { alarms.push(data); }, warn: async () => {}, info: async () => {} } };
    delete require.cache[rlPath];
    const mod = require(rlPath);
    require.cache[dbPath] = saved.db; require.cache[rlPath] = saved.rl; require.cache[logPath] = saved.log;
    if (!saved.db) delete require.cache[dbPath];
    if (!saved.log) delete require.cache[logPath];
    return { mod, counts, alarms, statements: () => statements };
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
    // As a hard stop, ten free accounts could block every band's invites for
    // the day; the deployment-wide count now only raises an alarm.
    await testAsync('everyone together past MAIL_OUT_DAILY alarms once, and nobody is blocked', async () => {
      const { mod, alarms } = load();
      for (let i = 0; i <= mod.MAIL_OUT_DAILY + 5; i++) await mod.outboundMailLimited(`p${i}@x.test`);
      assertEq(await mod.outboundMailLimited('fresh@x.test'), false);
      assertEq(alarms.filter(a => a.key === 'mail-out-day').length, 1);
    });
    await testAsync('presigns are capped per band per hour', async () => {
      const { mod } = load();
      for (let i = 0; i < mod.PRESIGN_PER_HOUR; i++) assertEq(await mod.presignLimited(1), false);
      assertEq(await mod.presignLimited(1), true);
      assertEq(await mod.presignLimited(2), false);
    });
    await testAsync('presigns are capped per band per day, and one band cannot block the others', async () => {
      const { mod, counts, alarms } = load();
      counts['presign-day:1'] = mod.PRESIGN_BAND_DAILY;
      counts['presign-day'] = mod.PRESIGN_DAILY;
      assertEq(await mod.presignLimited(1), true);
      assertEq(await mod.presignLimited(2), false);
      assertEq(alarms.filter(a => a.key === 'presign-day').length, 1);
      assert(mod.PRESIGN_BAND_DAILY * 2 < mod.PRESIGN_DAILY, 'two bands must not reach the alarm');
    });
    // A workspace costs one click: a cap per band alone let one account
    // multiply it.
    await testAsync('presigns are capped per person across all their bands', async () => {
      const { mod, counts } = load();
      counts['presign-person:a@x.test'] = mod.PRESIGN_PERSON_DAILY - 1;
      assertEq(await mod.presignLimited(1, 'A@x.test'), false);
      assertEq(await mod.presignLimited(2, 'a@x.test'), true);
      assertEq(await mod.presignLimited(3, 'b@x.test'), false);
      assert(mod.PRESIGN_PERSON_DAILY > mod.PRESIGN_BAND_DAILY, 'one band\'s day must fit in a person\'s');
    });
    await testAsync('a presign counts its four keys in one statement', async () => {
      const { mod, counts, statements } = load();
      await mod.presignLimited(1, 'a@x.test');
      assertEq(statements(), 1);
      assertEq(Object.keys(counts).sort(), ['presign-day', 'presign-day:1', 'presign-person:a@x.test', 'presign:1']);
    });
    // A lock per address alone let anyone lock a person out by typing ten
    // wrong passwords for them; passwordLogin compares these counts with
    // LOGIN_FAIL_MAX (pair) and LOGIN_FAIL_ADDRESS_MAX (address).
    await testAsync('a failed sign-in counts for the address and IP, and for the address', async () => {
      const { mod, counts } = load();
      for (let i = 0; i < 3; i++) await mod.countLoginFailure('Owner@x.test', '6.6.6.6');
      await mod.countLoginFailure('owner@x.test', '1.1.1.1');
      assertEq(counts['login-fail:owner@x.test 6.6.6.6'], 3);
      assertEq(counts['login-fail:owner@x.test 1.1.1.1'], 1);
      assertEq(counts['login-fail:owner@x.test'], 4);
      assert(mod.LOGIN_FAIL_ADDRESS_MAX > mod.LOGIN_FAIL_MAX, 'the address-wide lock must need more than one IP');
    });
    // With `|` the "address" `owner@x.test|6.6.6.6` was the owner's own pair
    // key: ten strangers tripped the lock meant for the owner's network.
    await testAsync('no address key is another address\'s pair key, and no known-IP prefix covers another address', async () => {
      const { mod } = load();
      const { validateEmail } = require(path.join(__dirname, '../../api/_validate'));
      const pair = mod.loginFailPairKey('owner@x.test', '6.6.6.6');
      const forged = pair.slice('login-fail:'.length);
      assert(!validateEmail(forged), 'an address that forges a pair key must be refused before counting');      assert(!mod.loginOkKey('owner@x.test|evil.test', '1.1.1.1').startsWith(mod.loginOkPrefix('owner@x.test')),
        'another address must not share the known-IP prefix');
      assert(!mod.loginOkKey('owner@x.tester', '1.1.1.1').startsWith(mod.loginOkPrefix('owner@x.test')),
        'a longer address must not share the known-IP prefix');
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
