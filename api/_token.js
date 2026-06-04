const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000; // 30 minutes

function generateMagicToken(passwordHash) {
  const expires = Date.now() + TTL_MS;
  const sig = crypto.createHmac('sha256', passwordHash).update(String(expires)).digest('hex');
  return Buffer.from(JSON.stringify({ expires, sig })).toString('base64url');
}

function verifyMagicToken(token, passwordHash) {
  try {
    const { expires, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (Date.now() > Number(expires)) return false;
    const expected = crypto.createHmac('sha256', passwordHash).update(String(expires)).digest('hex');
    if (sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

const TTL_8H  =  8 * 60 * 60 * 1000;
const TTL_30D = 30 * 24 * 60 * 60 * 1000;

function generateUserToken(userId, role, ttlMs) {
  const exp     = Date.now() + ttlMs;
  const payload = JSON.stringify({ userId, role, exp });
  const sig     = crypto.createHmac('sha256', process.env.APP_SECRET)
    .update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

function verifyUserToken(token) {
  try {
    if (!token) return null;
    const { payload, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expected = crypto.createHmac('sha256', process.env.APP_SECRET)
      .update(payload).digest('hex');
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const { userId, role, exp } = JSON.parse(payload);
    if (Date.now() > Number(exp)) return null;
    return { userId, role };
  } catch { return null; }
}

module.exports = { generateMagicToken, verifyMagicToken, generateUserToken, verifyUserToken, TTL_8H, TTL_30D };
