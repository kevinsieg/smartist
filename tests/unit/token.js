const path = require('path');
const crypto = require('crypto');
const { generateMagicToken, verifyMagicToken } =
  require(path.join(__dirname, '../../api/_token'));

function run(r) {
  const { test, assert, assertEq, B } = r;

  console.log(B('\ngenerateMagicToken / verifyMagicToken'));

  const HASH = crypto.randomBytes(32).toString('hex');
  const WRONG_HASH = crypto.randomBytes(32).toString('hex');

  test('returns a base64url string (no +, =, / chars)', () => {
    const token = generateMagicToken(HASH);
    assert(typeof token === 'string', 'not a string');
    assert(token.length > 0, 'empty token');
    assert(!/[+=/]/.test(token), `contains non-base64url chars: ${token}`);
  });
  test('fresh token verifies true with correct hash', () => {
    const token = generateMagicToken(HASH);
    assertEq(verifyMagicToken(token, HASH), true);
  });
  test('fresh token verifies false with wrong hash', () => {
    const token = generateMagicToken(HASH);
    assertEq(verifyMagicToken(token, WRONG_HASH), false);
  });
  test('tampered payload (changed expires) → false', () => {
    const token = generateMagicToken(HASH);
    const raw = JSON.parse(Buffer.from(token, 'base64url').toString());
    raw.expires += 1000;
    const tampered = Buffer.from(JSON.stringify(raw)).toString('base64url');
    assertEq(verifyMagicToken(tampered, HASH), false);
  });
  test('tampered payload (changed sig) → false', () => {
    const token = generateMagicToken(HASH);
    const raw = JSON.parse(Buffer.from(token, 'base64url').toString());
    raw.sig = raw.sig.replace(/[0-9a-f]/, c => (parseInt(c, 16) ^ 1).toString(16));
    const tampered = Buffer.from(JSON.stringify(raw)).toString('base64url');
    assertEq(verifyMagicToken(tampered, HASH), false);
  });
  test('expired token (past expires) → false', () => {
    const expires = Date.now() - 1;
    const sig = crypto.createHmac('sha256', HASH).update(String(expires)).digest('hex');
    const expired = Buffer.from(JSON.stringify({ expires, sig })).toString('base64url');
    assertEq(verifyMagicToken(expired, HASH), false);
  });
  test('garbage string → false (try/catch returns false)', () => {
    assertEq(verifyMagicToken('this-is-not-a-token', HASH), false);
  });
  test('null input → false', () => {
    assertEq(verifyMagicToken(null, HASH), false);
  });
  test('empty string → false', () => {
    assertEq(verifyMagicToken('', HASH), false);
  });
  test('valid JSON but missing fields → false', () => {
    const broken = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
    assertEq(verifyMagicToken(broken, HASH), false);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
