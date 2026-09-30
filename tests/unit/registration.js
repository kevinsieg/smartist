const path = require('path');
const crypto = require('crypto');

process.env.APP_SECRET = process.env.APP_SECRET || 'unit-test-secret-32-bytes-okayy!';

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  const { createSignupToken, verifySignupToken, redeemSignupToken, checkEmailDeliverable } =
    require(path.join(__dirname, '../../api/_domain/registration'));

  console.log(B('\ncheckEmailDeliverable'));

  await testAsync('disposable domain → not deliverable', async () => {
    const result = await checkEmailDeliverable('x@mailinator.com', async () => [{ exchange: 'mx.mailinator.com', priority: 10 }]);
    assertEq(result.ok, false);
  });

  await testAsync('domain with MX records → deliverable', async () => {
    const result = await checkEmailDeliverable('x@realband.com', async () => [{ exchange: 'mx1.realband.com', priority: 10 }]);
    assertEq(result.ok, true);
  });

  await testAsync('domain with no MX records → not deliverable', async () => {
    const result = await checkEmailDeliverable('x@nomail.com', async () => []);
    assertEq(result.ok, false);
  });

  await testAsync('null MX (RFC 7505, exchange ".") → not deliverable', async () => {
    const result = await checkEmailDeliverable('x@example.com', async () => [{ exchange: '.', priority: 0 }]);
    assertEq(result.ok, false);
  });

  await testAsync('NXDOMAIN → not deliverable', async () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    const result = await checkEmailDeliverable('x@no-such-domain.zz', async () => { throw err; });
    assertEq(result.ok, false);
  });

  await testAsync('transient DNS error → fail open (deliverable)', async () => {
    const result = await checkEmailDeliverable('x@realband.com', async () => { throw new Error('ETIMEOUT'); });
    assertEq(result.ok, true);
  });

  console.log(B('\ncreateSignupToken'));

  await testAsync('returns a hex string token and stores hash in subscribers', async () => {
    let upsertCalled = false;
    const sql = async (strings, ...vals) => {
      if (String(strings[0]).includes('INSERT INTO subscribers')) upsertCalled = true;
      return [];
    };
    const token = await createSignupToken('test@example.com', sql);
    assert(typeof token === 'string' && token.length === 64, 'expected 64-char hex token');
    assert(upsertCalled, 'expected upsert into subscribers');
  });

  await testAsync('stores a mixed-case address lowercased (OAuth providers keep case)', async () => {
    let stored;
    const sql = async (strings, ...vals) => {
      if (String(strings[0]).includes('INSERT INTO subscribers')) stored = vals[0];
      return [];
    };
    await createSignupToken('Kev.Test@Example.COM', sql);
    assertEq(stored, 'kev.test@example.com');
  });


  console.log(B('\nverifySignupToken'));

  await testAsync('returns { email } for valid non-expired token', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000);
    const sql = async () => [{ email: 'user@example.com', signup_token_hash: hash, signup_token_expires: expires }];
    const result = await verifySignupToken(rawToken, sql);
    assert(result !== null, 'expected non-null');
    assertEq(result.email, 'user@example.com');
  });

  await testAsync('returns null when no subscriber found', async () => {
    const sql = async () => [];
    const result = await verifySignupToken('deadbeef'.repeat(8), sql);
    assertEq(result, null);
  });

  await testAsync('returns null when token is expired', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() - 1000);
    const sql = async () => [{ email: 'user@example.com', signup_token_hash: hash, signup_token_expires: expires }];
    const result = await verifySignupToken(rawToken, sql);
    assertEq(result, null);
  });

  console.log(B('\nredeemSignupToken'));

  // A fake transaction: the token row, then the two inserts.
  function redeemSql({ spent = false, failUsers = false } = {}) {
    const calls = [];
    const tx = async (strings, ...vals) => {
      const q = String(strings.join('?'));
      calls.push({ q, vals });
      if (q.includes('UPDATE subscribers')) return spent ? [] : [{ email: 'Kev.Test@Example.COM' }];
      if (q.includes('INSERT INTO artists')) return [{ id: 10 }];
      if (q.includes('INSERT INTO users')) { if (failUsers) throw new Error('users insert failed'); return [{ id: 20 }]; }
      return [];
    };
    return { sql: { begin: fn => fn(tx) }, calls };
  }

  await testAsync('spends the link and creates the band and its admin in one transaction', async () => {
    const { sql, calls } = redeemSql();
    const result = await redeemSignupToken('raw', 'My Band', 'my-band', sql);
    assertEq(result, { email: 'kev.test@example.com', artistId: 10, userId: 20 });
    assertEq(calls.map(c => c.q.trim().split(/\s+/).slice(0, 2).join(' ')),
      ['UPDATE subscribers', 'INSERT INTO', 'INSERT INTO']);
    assert(calls[0].q.includes('now()'), 'an expired link must not redeem');
    const users = calls.find(c => c.q.includes('INSERT INTO users'));
    assertEq(users.vals[1], 'kev.test@example.com');
  });

  await testAsync('a spent or unknown link creates nothing', async () => {
    const { sql, calls } = redeemSql({ spent: true });
    assertEq(await redeemSignupToken('raw', 'My Band', 'my-band', sql), null);
    assert(!calls.some(c => c.q.includes('INSERT')), 'nothing inserted');
  });

  await testAsync('a failed insert throws (the transaction rolls back, the link stays)', async () => {
    const { sql } = redeemSql({ failUsers: true });
    let threw = false;
    try { await redeemSignupToken('raw', 'Band', 'band', sql); } catch { threw = true; }
    assert(threw, 'expected a throw');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
