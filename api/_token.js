const crypto = require('crypto');

// Checked when a token is signed or verified, not at module load: a throw at
// load took down every route of the function — including the health check
// (GET /api/config?action=health) that reports the missing variable. Signing
// still throws (→ 500), and verifying fails closed (→ 401).
function secret() {
  if (!process.env.APP_SECRET) {
    throw new Error('APP_SECRET env var is required — set it in .env or Vercel project settings');
  }
  return process.env.APP_SECRET;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes

// Magic tokens are bound to a purpose, so a link minted for one job cannot be
// redeemed for another: 'login' (sign-in link / bootstrap), 'reset' (set a new
// password) and 'demo' (the public demo gate — resolves to a member session,
// never an admin one; see api/_auth.js).
const PURPOSES = new Set(['login', 'reset', 'demo']);

function _magicSig(seed, purpose, expires) {
  return crypto.createHmac('sha256', seed).update(`${purpose}:${expires}`).digest('hex');
}

function generateMagicToken(passwordHash, purpose = 'login') {
  if (!PURPOSES.has(purpose)) throw new Error(`unknown magic token purpose: ${purpose}`);
  const expires = Date.now() + TTL_MS;
  const sig = _magicSig(passwordHash, purpose, expires);
  return Buffer.from(JSON.stringify({ expires, purpose, sig })).toString('base64url');
}

function verifyMagicToken(token, passwordHash, purpose = 'login') {
  try {
    if (!passwordHash) return false;
    const { expires, purpose: p, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (p !== purpose) return false;
    if (Date.now() > Number(expires)) return false;
    const expected = _magicSig(passwordHash, purpose, expires);
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

const TTL_8H  =  8 * 60 * 60 * 1000;
const TTL_30D = 30 * 24 * 60 * 60 * 1000;

// Session tokens carry a fingerprint of the password hash they were issued
// against. Setting or changing a password changes the hash, so every session
// issued before it stops verifying (see passwordMatches / api/_auth.js).
// Accounts without a password (OAuth) fingerprint the empty string.
function passwordFingerprint(passwordHash) {
  return crypto.createHmac('sha256', secret())
    .update(`pwv:${passwordHash || ''}`).digest('hex').slice(0, 16);
}

function generateUserToken(userId, role, ttlMs, passwordHash = null) {
  const exp     = Date.now() + ttlMs;
  const payload = JSON.stringify({ userId, role, exp, pwv: passwordFingerprint(passwordHash) });
  const sig     = crypto.createHmac('sha256', secret())
    .update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

function verifyUserToken(token) {
  try {
    if (!token) return null;
    const { payload, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expected = crypto.createHmac('sha256', secret())
      .update(payload).digest('hex');
    if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const { userId, role, exp, pwv } = JSON.parse(payload);
    if (Date.now() > Number(exp)) return null;
    return { userId, role, pwv };
  } catch { return null; }
}

// Does this claim still match the user row's current password? Tokens minted
// before fingerprints existed carry none and are accepted until they expire.
function passwordMatches(claim, row) {
  if (!claim || !row) return false;
  if (claim.pwv === undefined) return true;
  const a = Buffer.from(String(claim.pwv));
  const b = Buffer.from(passwordFingerprint(row.password_hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  generateMagicToken, verifyMagicToken, generateUserToken, verifyUserToken,
  passwordFingerprint, passwordMatches, TTL_8H, TTL_30D,
};
