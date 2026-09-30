const bcrypt = require('bcryptjs');
const { getDb } = require('../_db');
const { checkRateLimit, loginLocked, countLoginFailure } = require('../_ratelimit');
const { ok, fail } = require('./http');
const { generateUserToken, verifyMagicToken, verifyUserToken, sessionValid, TTL_8H, TTL_30D } = require('../_token');
const { getArtistsForUser } = require('./artist');
const logger = require('../_logger');

// Log in without naming a band.
//
// `/api/:artist/auth` needs the slug in the URL, which a deployment pinned to
// one band gets from ARTIST_SLUG and a workspace URL gets from its path. At the
// root of a multi-tenant deployment there is neither, so there was no way in at
// all: the form posted to `/api//auth`.
//
// Email is the cross-workspace identity (the same address can be a user of
// several bands, see getArtistsForUser), so the address alone is enough to find
// the account. The OAuth callback already logs people in this way.
//
// The same person may hold different passwords on different bands (rows from
// before one password per address), so every distinct hash is checked and the
// first row whose hash matches wins. Setting a password writes it to every row
// of the address, so rows sharing a hash are compared once: each bcrypt round
// costs hundreds of milliseconds, and a member of several bands paid it per band.
const MAX_CANDIDATES = 10;

// Compared against when no account matches, so an unknown address costs the
// same bcrypt round as a wrong password — response time must not say which
// emails have accounts. Cost 12, like every stored hash; matches no password.
const DUMMY_HASH = '$2a$12$bX/Oyxx22A2xtE30S33C6evrSuAbmD9UFwycjT85mhdiJBygShHLO';

async function passwordLogin({ body, ip }) {
  const { email, password, rememberMe } = body ?? {};
  const clean = String(email ?? '').trim().toLowerCase();
  if (!clean || !password) return fail(400, 'Email and password required');
  if (String(password).length > 1000) return fail(400, 'Invalid');

  if (await checkRateLimit(`auth:${ip}`, 10, 60) || await loginLocked(clean))
    return fail(429, 'Too many attempts — try again later');

  const sql = getDb();
  const candidates = await sql`
    SELECT id, role, password_hash FROM (
      SELECT DISTINCT ON (password_hash) id, role, password_hash
      FROM users
      WHERE email = ${clean} AND password_hash IS NOT NULL
      ORDER BY password_hash, id
    ) first_per_hash
    ORDER BY id
    LIMIT ${MAX_CANDIDATES}
  `;

  let user = null;
  for (const row of candidates) {
    if (await bcrypt.compare(password, row.password_hash)) { user = row; break; }
  }
  if (!candidates.length) await bcrypt.compare(String(password), DUMMY_HASH);
  // One message for an unknown address and a wrong password alike — otherwise
  // this endpoint tells anyone which emails have accounts.
  if (!user) {
    await countLoginFailure(clean);
    await logger.info('login_failed', { email: clean });
    return fail(401, 'Invalid email or password');
  }

  const token   = generateUserToken(user.id, user.role, rememberMe ? TTL_30D : TTL_8H, user.password_hash);
  const artists = await getArtistsForUser(user.id, sql);
  await logger.info('login', { email: clean, artists: artists.length });
  return ok({ ok: true, token, role: user.role, email: clean, artists });
}

// Redeem a mailed sign-in link (`/login#magic=…&hint=…`, sent by the signup
// form to an address that already has an account). `hint` names the address;
// the token was signed with one of its rows' password hashes, so it is checked
// against each, as passwordLogin checks the password. A password-less account
// gets no such link (api/_domain/signup.js).
async function magicLogin({ body, ip }) {
  const { magic, hint } = body ?? {};
  if (!magic || !hint) return fail(400, 'magic and hint required');
  if (await checkRateLimit(`auth:${ip}`, 10, 60)) return fail(429, 'Too many attempts — try again later');

  const addr = Buffer.from(String(hint), 'base64url').toString().trim().toLowerCase();
  const sql  = getDb();
  const rows = await sql`
    SELECT id, role, password_hash
    FROM users
    WHERE email = ${addr} AND password_hash IS NOT NULL
    ORDER BY id
    LIMIT ${MAX_CANDIDATES}
  `;
  const user = rows.find(r => verifyMagicToken(String(magic), r.password_hash, 'login'));
  if (!user) return fail(401, 'Invalid or expired login link');

  const token   = generateUserToken(user.id, user.role, TTL_8H, user.password_hash);
  const artists = await getArtistsForUser(user.id, sql);
  await logger.info('login_link', { email: addr, artists: artists.length });
  return ok({ ok: true, token, role: user.role, email: addr, artists });
}

// POST ?action=logout-everywhere — every session of this person ends: on every
// device, in every workspace (the address is the identity), this one included.
// Sessions issued before the stored time no longer verify (sessionValid).
async function logoutEverywhere({ headers }) {
  const claim = verifyUserToken((headers.authorization || '').replace(/^Bearer /, ''));
  if (!claim) return fail(401, 'Unauthorized');
  const sql = getDb();
  const [me] = await sql`
    SELECT email, password_hash, sessions_valid_after FROM users WHERE id = ${claim.userId} LIMIT 1`;
  if (!me || !sessionValid(claim, me)) return fail(401, 'Unauthorized');
  // The function's own clock, which is what iat was taken from.
  const { count } = await sql`
    UPDATE users SET sessions_valid_after = ${new Date()} WHERE email = ${me.email}`;
  await logger.info('logout_everywhere', { userId: claim.userId, rows: count });
  return ok({ ok: true });
}

module.exports = { passwordLogin, magicLogin, logoutEverywhere, DUMMY_HASH };
