const path = require('path');
const crypto = require('crypto');

process.env.APP_SECRET = process.env.APP_SECRET || 'unit-test-secret-32-bytes-okayy!';

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  const { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken, checkEmailDeliverable } =
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

  console.log(B('\ncreateArtistAndAdmin'));

  await testAsync('inserts artist and user, returns { artistId, userId }', async () => {
    const calls = [];
    const sql = async (strings, ...vals) => {
      calls.push(String(strings[0]).trim().slice(0, 30));
      if (String(strings[0]).includes('INSERT INTO artists')) return [{ id: 10 }];
      if (String(strings[0]).includes('INSERT INTO users'))   return [{ id: 20 }];
      return [];
    };
    sql.begin = async fn => fn(sql);
    const result = await createArtistAndAdmin('My Band', 'my-band', 'admin@example.com', sql);
    assertEq(result.artistId, 10);
    assertEq(result.userId, 20);
    assert(calls.some(c => c.includes('INSERT INTO artists')), 'expected artist insert');
    assert(calls.some(c => c.includes('INSERT INTO users')),   'expected user insert');
  });

  await testAsync('rolls back if user insert fails', async () => {
    const failSql = async (strings) => {
      if (String(strings[0]).includes('INSERT INTO artists')) return [{ id: 10 }];
      throw new Error('users insert failed');
    };
    failSql.begin = async fn => fn(failSql);
    let threw = false;
    try { await createArtistAndAdmin('Band', 'band', 'fail@example.com', failSql); }
    catch { threw = true; }
    assert(threw, 'expected createArtistAndAdmin to throw when user insert fails');
  });

  console.log(B('\nclearSignupToken'));

  await testAsync('removes token fields from subscribers.meta', async () => {
    let updateCalled = false;
    const sql = async (strings) => {
      if (String(strings[0]).includes('UPDATE subscribers')) updateCalled = true;
      return [];
    };
    await clearSignupToken('user@example.com', sql);
    assert(updateCalled, 'expected UPDATE subscribers');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
