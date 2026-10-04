const crypto = require('crypto');

// Checked when a token is signed or verified, not at module load: a throw at
// load took down every route of the function — including the health check
// (GET /api/config?action=health) that reports the missing variable. Signing
// still throws (→ 500), and verifying fails closed (→ 401).
//
// The signing key is bound to the database this deployment uses. Tokens name a
// user by id, and ids are per database: with one APP_SECRET shared by several
// deployments, user 5 of one database would otherwise be accepted as user 5 of
// another (password-less accounts all carry the same password fingerprint).
// Host and database name identify it; credentials do not, so rotating the
// database password keeps everyone signed in.
function databaseIdentity() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}${u.pathname}`;
  } catch { return ''; }
}

let _key = null, _keyFor = null;
function secret() {
  if (!process.env.APP_SECRET) {
    throw new Error('APP_SECRET env var is required — set it in .env or Vercel project settings');
  }
  const id = `${process.env.APP_SECRET}\n${databaseIdentity()}`;
  if (_keyFor !== id) {
    _key = crypto.createHmac('sha256', process.env.APP_SECRET)
      .update(`smartist-signing-key:${databaseIdentity()}`).digest('hex');
    _keyFor = id;
  }
  return _key;
}

// Signing seed for reset links of an account without a password (Google or
// Facebook sign-up): an empty seed would make those links forgeable, and the
// id binds it to one account.
function passwordlessSeed(userId) {
  return crypto.createHmac('sha256', secret()).update(`account:${userId}`).digest('hex');
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes

// Magic tokens are bound to a purpose, so a link minted for one job cannot be
// redeemed for another: 'login' (sign-in link), 'reset' (set a new
// password) and 'demo' (the public demo gate — resolves to a member session,
// never an admin one; see api/_auth.js).
const PURPOSES = new Set(['login', 'reset', 'demo']);

// Keyed on APP_SECRET, with the seed (a password hash) in the message: the
// seed still ties the link to the password it was issued against, and a copy
// of the users table alone is no longer enough to mint sign-in or reset links.
function _magicSig(seed, purpose, expires) {
  return crypto.createHmac('sha256', secret()).update(`${purpose}:${expires}:${seed}`).digest('hex');
}

// The demo gate's signing key: per band, derived from APP_SECRET, so a demo
// band needs no password of its own.
function demoSeed(artistId) {
  return crypto.createHmac('sha256', secret()).update(`demo:${artistId}`).digest('hex');
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
// against, and when they were issued. Setting or changing a password changes
// the hash, and "log out everywhere" sets users.sessions_valid_after, so every
// session issued before either stops verifying (see sessionValid / api/_auth.js).
// Accounts without a password (OAuth) fingerprint the empty string.
function passwordFingerprint(passwordHash) {
  return crypto.createHmac('sha256', secret())
    .update(`pwv:${passwordHash || ''}`).digest('hex').slice(0, 16);
}

// `email` names the person, not just the row: a session outlives the removal of
// the users row it was issued for (one band removing them must not sign them
// out of every other band). See loadArtistAndMember in api/_auth.js.
function generateUserToken(userId, role, ttlMs, passwordHash = null, email = null) {
  const iat     = Date.now();
  const payload = JSON.stringify({ userId, role, iat, exp: iat + ttlMs, pwv: passwordFingerprint(passwordHash),
    ...(email ? { email: String(email).toLowerCase() } : {}) });
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
    const { userId, role, iat, exp, pwv, email } = JSON.parse(payload);
    if (Date.now() > Number(exp)) return null;
    return { userId, role, iat: Number(iat) || 0, pwv, email: typeof email === 'string' ? email : null };
  } catch { return null; }
}

// Does this claim still hold for its user row: the same password, and issued
// after the last "log out everywhere"? Every token carries a fingerprint; one
// without is not ours. Tokens from before issue times were recorded count as
// issued at 0, so a logout ends them too.
function sessionValid(claim, row) {
  if (!claim || !row || typeof claim.pwv !== 'string') return false;
  if (row.sessions_valid_after && claim.iat < new Date(row.sessions_valid_after).getTime()) return false;
  const a = Buffer.from(String(claim.pwv));
  const b = Buffer.from(passwordFingerprint(row.password_hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  generateMagicToken, verifyMagicToken, demoSeed, passwordlessSeed, generateUserToken, verifyUserToken,
  sessionValid, TTL_8H, TTL_30D,
};
