const bcrypt = require('bcryptjs');
const { getDb } = require('../_db');
const { checkRateLimit } = require('../_ratelimit');
const { generateMagicToken, verifyMagicToken, generateUserToken, passwordlessSeed, TTL_8H } = require('../_token');
const { sendEmail } = require('../_email');
const { getArtistsForUser } = require('./artist');
const { ok, fail } = require('./http');
const logger = require('../_logger');

// Reset a password without naming a band.
//
// `/api/:artist/request-reset` needs the slug in the URL. At the root of a
// multi-tenant deployment there is none, so the form posted to
// `/api//request-reset` — a 308 to a 404, with no mail ever sent and no error
// shown. Someone who signed up with Google there had no way back into their
// account at all: no password to remember, and nothing that would reset one.
// Same shape, and same fix, as passwordLogin in ./login.js.
//
// **One address, one password.** The same address can own several `users` rows
// with different hashes — passwordLogin already hides that by trying each in
// turn — so a reset writes the new hash to every row for that address. Resetting
// only one would leave the person still locked out of their other bands, which
// is the bug this fixes, moved somewhere less obvious.
const MAX_ROWS = 10;

// Every row for this address, lowest id first. The first is the *anchor*: its
// hash is the token's signing key, so setting a password changes the seed and
// the link that set it stops verifying, along with any other outstanding link.
async function _rowsFor(addr, sql) {
  return await sql`
    SELECT id, email, role, password_hash
    FROM users
    WHERE email = ${addr}
    ORDER BY id
    LIMIT ${MAX_ROWS}
  `;
}

// A password-less account (created through Google or Facebook) has no hash to
// sign with; passwordlessSeed (api/_token.js) stands in for it.
function _seed(row) {
  return row.password_hash || passwordlessSeed(row.id);
}

// POST ?action=request-reset
async function requestReset({ body, ip, origin }) {
  const addr = String(body.email ?? '').trim().toLowerCase();
  // Always the same answer, with or without an account — otherwise this endpoint
  // will happily tell anyone which addresses are registered here.
  if (!addr) return ok({ ok: true });
  if (await checkRateLimit(`reset:${addr}`, 3, 3600)) return ok({ ok: true });
  // Per address alone lets one client mail-bomb many addresses.
  if (await checkRateLimit(`reset-ip:${ip}`, 10, 3600)) return ok({ ok: true });

  const sql  = getDb();
  const rows = await _rowsFor(addr, sql);
  if (!rows.length) {
    await logger.info('reset_requested_unknown', { email: addr });
    return ok({ ok: true });
  }

  const token = generateMagicToken(_seed(rows[0]), 'reset');
  const hint  = Buffer.from(rows[0].email).toString('base64url');
  // Fragment, not query — tokens must not reach server or CDN logs. No `next`
  // here: at the root there is no single workspace to land in, so the login
  // page decides where to go once it knows which bands this person has.
  const link  = `${origin}/login#reset=${encodeURIComponent(token)}&hint=${hint}`;

  try {
    await sendEmail({
      to: rows[0].email,
      subject: 'Set a new password',
      html: `<p>Choose a new password for your smartist account:</p><p><a href="${link}">${link}</a></p><p>Valid for 30 minutes. Do not share this link. If you did not ask for this, ignore this email — nothing changes until you set a password.</p>`,
    });
  } catch (err) {
    await logger.error('reset_email_failed', { email: addr, error: err.message });
    return fail(500, 'Failed to send email — try again later');
  }
  await logger.info('reset_requested', { email: addr, workspaces: rows.length });
  return ok({ ok: true });
}

// POST ?action=set-password
async function setPassword({ body }) {
  const { token, hint, password } = body;
  if (!token || !hint || !password)   return fail(400, 'token, hint and password required');
  if (String(password).length < 8)    return fail(400, 'Password must be at least 8 characters');
  if (String(password).length > 1000) return fail(400, 'Password too long');

  let addr;
  try { addr = Buffer.from(String(hint), 'base64url').toString().toLowerCase(); }
  catch { return fail(400, 'Invalid or expired link'); }

  const sql  = getDb();
  const rows = await _rowsFor(addr, sql);
  // The hint is attacker-supplied, so the token is checked against the seed of
  // the account the hint actually names. A valid token for one address paired
  // with someone else's proves nothing and rewrites nothing.
  if (!rows.length || !verifyMagicToken(String(token), _seed(rows[0]), 'reset'))
    return fail(400, 'Invalid or expired link');

  const hash = await bcrypt.hash(String(password), 12);
  // Email-change and deletion links still outstanding end with the old password.
  await sql`
    UPDATE users SET password_hash = ${hash},
        pending_email = NULL, email_change_token_hash = NULL, email_change_expires_at = NULL,
        delete_token_hash = NULL, delete_token_expires = NULL
    WHERE email = ${addr}`;

  // Setting the password is what logs them in; they are here because they could
  // not, and handing them back to the login form would be a joke.
  const anchor       = rows[0];
  const sessionToken = generateUserToken(anchor.id, anchor.role, TTL_8H, hash);
  const artists      = await getArtistsForUser(anchor.id, sql);
  await logger.info('password_set_via_reset', { email: addr, workspaces: rows.length });
  return ok({ ok: true, token: sessionToken, role: anchor.role, email: anchor.email, artists });
}

module.exports = { requestReset, setPassword };
