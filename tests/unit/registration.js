const path = require('path');
const crypto = require('crypto');

process.env.APP_SECRET = process.env.APP_SECRET || 'unit-test-secret-32-bytes-okayy!';

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  const { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken } =
    require(path.join(__dirname, '../../api/_domain/registration'));

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
    const result = await createArtistAndAdmin('My Band', 'my-band', 'admin@example.com', sql);
    assertEq(result.artistId, 10);
    assertEq(result.userId, 20);
    assert(calls.some(c => c.includes('INSERT INTO artists')), 'expected artist insert');
    assert(calls.some(c => c.includes('INSERT INTO users')),   'expected user insert');
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
