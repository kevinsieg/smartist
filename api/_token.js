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

module.exports = { generateMagicToken, verifyMagicToken };
