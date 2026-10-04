const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb } = require('../_db');
const { generateUserToken, TTL_8H, TTL_30D } = require('../_token');
const { getArtistsForUser } = require('./artist');
const { sendEmail } = require('../_email');
const { escHtml } = require('../_html');
const { checkRateLimit, outboundMailLimited } = require('../_ratelimit');
const { validateStr, validateEmail } = require('../_validate');
const logger = require('../_logger');
const { ok, reply, fail } = require('./http');

// A band's members: invites, roles, and each person's own password and login
// address. api/_band/auth.js checks the session and the role, then calls these
// with a context:
//
//   { band, user, body, ip, origin, slug }   — user is { id, role } (id null for the demo)
//
// and sends back the { status, body } they return.

const ROLES = ['admin', 'member', 'viewer'];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// A random token for a link, and the hash that is stored in its place.
function linkToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return { raw, hash: sha256(raw) };
}

// Header values (subjects) must stay on one line.
function oneLine(s) { return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200); }

// Invites send mail to any address with the band's name in it, so they are
// capped per band, per IP, per sender and overall — an admin session must not
// be a mail relay.
async function inviteLimited(band, ip, user) {
  return (await checkRateLimit(`invite:${band.id}`, 20, 3600))
      || (await checkRateLimit(`invite-ip:${ip}`, 30, 3600))
      || (await outboundMailLimited(user.email || `user:${user.id}`));
}

// Does any users row carry this address (any band, invited or not)?
async function addressTaken(sql, email) {
  const [row] = await sql`SELECT 1 FROM users WHERE email = ${email} LIMIT 1`;
  return !!row;
}

// The caller's own row, when currentPassword is its password; else null.
async function ownRow(sql, user, currentPassword) {
  const [row] = await sql`SELECT * FROM users WHERE id = ${user.id}`;
  if (!row || !row.password_hash || !await bcrypt.compare(String(currentPassword), row.password_hash)) return null;
  return row;
}

// ── Public: the links in the emails ───────────────────────────────────────────

// POST /members/accept-invite — the invite link sets the first password.
async function acceptInvite({ band, body }) {
  const { token, password } = body ?? {};
  if (!token || !password)            return fail(400, 'token and password required');
  if (String(password).length < 8)    return fail(400, 'Password must be at least 8 characters');
  if (String(password).length > 1000) return fail(400, 'Password too long');

  const sql = getDb();
  const [user] = await sql`
    SELECT * FROM users
    WHERE artist_id = ${band.id}
      AND invite_token_hash = ${sha256(token)}
      AND invite_expires_at > now()
      AND password_hash IS NULL
  `;
  if (!user) return fail(400, 'Invalid or expired invite');

  // One address, one password: the same person may already sign in to other
  // bands, and an old password left on those rows would keep working there.
  const hash = await bcrypt.hash(password, 12);
  const [, artists] = await Promise.all([
    sql`
      UPDATE users
      SET password_hash = ${hash},
          invite_token_hash = CASE WHEN id = ${user.id} THEN NULL ELSE invite_token_hash END,
          invite_expires_at = CASE WHEN id = ${user.id} THEN NULL ELSE invite_expires_at END
      WHERE email = ${user.email}
    `,
    getArtistsForUser(user.id, sql),
  ]);
  const sessionToken = generateUserToken(user.id, user.role, TTL_8H, hash);
  return ok({ ok: true, token: sessionToken, role: user.role, email: user.email, artists });
}

// POST /members/confirm-email-change — the link is clicked from an inbox, so
// there is no session. Without `confirm` it previews the change (new address
// and every band affected); with `confirm: true` it applies it.
async function confirmEmailChange({ body, ip, slug }) {
  const { token, confirm } = body ?? {};
  if (!token) return fail(400, 'token required');
  if (await checkRateLimit(`emailchg-confirm:${ip}`, 10, 600))
    return fail(429, 'Too many attempts — try again later');

  const sql = getDb();
  const [pending] = await sql`
    SELECT id, email, pending_email FROM users
    WHERE email_change_token_hash = ${sha256(token)}
      AND email_change_expires_at > now()
      AND pending_email IS NOT NULL
  `;
  if (!pending) return fail(400, 'Invalid or expired link');

  // Every band reached by the current address — the change moves all of them.
  const bands = await sql`
    SELECT a.slug, a.name, u.role
    FROM users u JOIN artists a ON a.id = u.artist_id
    WHERE u.email = ${pending.email}
    ORDER BY a.name
  `;

  if (!confirm) return ok({ newEmail: pending.pending_email, bands });

  const oldEmail = pending.email;
  const target   = pending.pending_email;
  try {
    await sql.begin(async tx => {
      // Refuse if the address has an account of its own anywhere — checked
      // again here, since it may have signed up after the request. Moving onto
      // it would merge two people into one identity (memberships join on email).
      if (await addressTaken(tx, target)) throw Object.assign(new Error('taken'), { taken: true });

      // One statement moves every membership, so the person keeps all bands.
      await tx`UPDATE users SET email = ${target}, delete_token_hash = NULL, delete_token_expires = NULL WHERE email = ${oldEmail}`;
      await tx`
        UPDATE users
        SET pending_email = NULL, email_change_token_hash = NULL, email_change_expires_at = NULL
        WHERE id = ${pending.id}
      `;
    });
  } catch (err) {
    // 23505 = unique_violation: someone claimed the address mid-flight.
    if (err.taken || err.code === '23505') return fail(409, 'That email address is already in use');
    throw err;
  }

  // Tell the old address once the change is durable. A mail failure must not
  // roll it back — retrying would risk applying the change twice.
  try {
    await sendEmail({
      to: oldEmail,
      subject: 'Your email address was changed',
      html: `<p>Your smartist login email was changed to ${escHtml(target)}.</p>
             <p>If you did not do this, contact support immediately.</p>`,
    });
  } catch (err) {
    await logger.error('email_change_notice_failed', { band: slug, error: err.message });
  }

  return ok({ ok: true, email: target });
}

// ── Admins: the band's members ────────────────────────────────────────────────

// GET — the members and the state of their invites.
async function listMembers({ band }) {
  const users = await getDb()`
    SELECT id, email, role, created_at, invite_expires_at,
           (password_hash IS NOT NULL)                                                               AS accepted,
           (invite_token_hash IS NOT NULL AND invite_expires_at >  now() AND password_hash IS NULL) AS invite_pending,
           (invite_token_hash IS NOT NULL AND invite_expires_at <= now() AND password_hash IS NULL) AS invite_expired
    FROM users WHERE artist_id = ${band.id}
    ORDER BY created_at
  `;
  return ok({ users });
}

// POST /members/invite
async function invite({ band, user, body, ip, origin, slug }) {
  const { email, role } = body ?? {};
  const rawEmail = validateStr(email, 200);
  if (rawEmail === null) return fail(400, 'Email required');
  const cleanEmail = rawEmail && validateEmail(rawEmail);
  if (!cleanEmail) return fail(400, 'Invalid email address');
  if (!ROLES.includes(role)) return fail(400, 'Invalid role');

  const sql = getDb();
  const [existing] = await sql`SELECT id FROM users WHERE artist_id = ${band.id} AND email = ${cleanEmail.toLowerCase()}`;
  if (existing) return fail(409, 'User already exists');
  if (await inviteLimited(band, ip, user)) return fail(429, 'Too many invites — try again later');

  const token   = linkToken();
  const expires = new Date(Date.now() + INVITE_TTL_MS);
  const [newUser] = await sql`
    INSERT INTO users (artist_id, email, role, invite_token_hash, invite_expires_at, invited_by)
    VALUES (${band.id}, ${cleanEmail.toLowerCase()}, ${role}, ${token.hash}, ${expires}, ${user.id})
    RETURNING id, email, role
  `;

  const link = `${origin}/login#invite=${token.raw}`;
  try {
    await sendEmail({
      to: cleanEmail,
      subject: `You've been invited to ${oneLine(band.name)}`,
      html: `<p>You've been invited to access ${escHtml(band.name)} on smartist.</p>
             <p><a href="${link}">Accept invite and set your password</a></p>
             <p>This link expires in 7 days.</p>`,
    });
  } catch (err) {
    await logger.error('invite_email_failed', { band: slug, error: err.message });
    await sql`DELETE FROM users WHERE id = ${newUser.id}`;
    return fail(500, 'Failed to send invite email');
  }
  return reply(201, { ok: true, user: newUser });
}

// POST /members/resend-invite — a fresh link for an invite not yet accepted.
async function resendInvite({ band, user: sender, body, ip, origin, slug }) {
  const { userId } = body ?? {};
  if (!userId) return fail(400, 'userId required');

  const sql = getDb();
  const [user] = await sql`
    SELECT * FROM users WHERE id = ${Number(userId)} AND artist_id = ${band.id} AND password_hash IS NULL
  `;
  if (!user) return fail(404, 'Pending invite not found');
  if (await inviteLimited(band, ip, sender)) return fail(429, 'Too many invites — try again later');

  const token   = linkToken();
  const expires = new Date(Date.now() + INVITE_TTL_MS);
  await sql`UPDATE users SET invite_token_hash = ${token.hash}, invite_expires_at = ${expires} WHERE id = ${user.id}`;

  const link = `${origin}/login#invite=${token.raw}`;
  try {
    await sendEmail({
      to: user.email,
      subject: `Invite reminder — ${oneLine(band.name)}`,
      html: `<p>Here is your updated invite link for ${escHtml(band.name)}:</p>
             <p><a href="${link}">Accept invite and set your password</a></p>
             <p>This link expires in 7 days.</p>`,
    });
  } catch (err) {
    await logger.error('invite_email_failed', { band: slug, error: err.message });
    return fail(500, 'Failed to send email');
  }
  return ok({ ok: true });
}

// PUT — change a member's role. Login email is never admin-editable: it is the
// cross-workspace identity (resolveUser joins users on email), so rewriting it
// would hand this user another account's memberships.
async function setRole({ band, user, body }) {
  const { userId, role, email } = body ?? {};
  if (!userId) return fail(400, 'userId required');
  if (email !== undefined) return fail(400, 'Email cannot be changed');
  if (!ROLES.includes(role)) return fail(400, 'Invalid role');
  if (user.id !== null && user.id === Number(userId)) return fail(400, 'Cannot change your own role');

  const [updated] = await getDb()`
    UPDATE users SET role = ${role}
    WHERE id = ${Number(userId)} AND artist_id = ${band.id}
    RETURNING id, email, role
  `;
  if (!updated) return fail(404, 'User not found');
  return ok({ ok: true, user: updated });
}

// DELETE — remove a member from the band.
async function removeMember({ band, user, body }) {
  const { userId } = body ?? {};
  if (!userId) return fail(400, 'userId required');
  if (user.id !== null && user.id === Number(userId)) return fail(400, 'Cannot remove yourself');

  const [deleted] = await getDb()`
    DELETE FROM users WHERE id = ${Number(userId)} AND artist_id = ${band.id} RETURNING id
  `;
  if (!deleted) return fail(404, 'User not found');
  return ok({ ok: true });
}

// ── Anyone signed in: their own account ───────────────────────────────────────

// POST /members/change-password
async function changePassword({ user, body, ip }) {
  const { currentPassword, newPassword, rememberMe } = body ?? {};
  if (!currentPassword || !newPassword) return fail(400, 'currentPassword and newPassword required');
  if (String(newPassword).length < 8)   return fail(400, 'Password must be at least 8 characters');
  if (String(newPassword).length > 1000 || String(currentPassword).length > 1000)
    return fail(400, 'Password too long');
  if (user.id === null) return fail(400, 'Password change is not available for this account');
  if (await checkRateLimit(`chpw:${ip}`, 5, 600)) return fail(429, 'Too many attempts — try again later');

  const sql = getDb();
  const row = await ownRow(sql, user, currentPassword);
  if (!row) return fail(401, 'Current password is incorrect');

  // Every band of this address: after a compromise, a password changed in one
  // band must not keep working through another.
  const hash = await bcrypt.hash(String(newPassword), 12);
  // Links still outstanding (email change, account deletion) end with the old
  // password: whoever held it may have requested them.
  await sql`
    UPDATE users SET password_hash = ${hash},
        pending_email = NULL, email_change_token_hash = NULL, email_change_expires_at = NULL,
        delete_token_hash = NULL, delete_token_expires = NULL
    WHERE email = ${row.email}`;
  // The new hash invalidates every session issued before it, this one
  // included — hand back a replacement so the caller stays signed in.
  const token = generateUserToken(row.id, row.role, rememberMe ? TTL_30D : TTL_8H, hash);
  return ok({ ok: true, token });
}

// POST /members/request-email-change — nothing changes until the link sent to
// the NEW address is confirmed: email is the cross-workspace identity, so it
// must be proven, not asserted.
async function requestEmailChange({ user, body, ip, origin, slug }) {
  const { currentPassword, newEmail } = body ?? {};
  if (!currentPassword || !newEmail) return fail(400, 'currentPassword and newEmail required');
  if (String(currentPassword).length > 1000) return fail(400, 'Password too long');
  if (user.id === null) return fail(400, 'Email change is not available for this account');

  const clean = validateStr(newEmail, 200);
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) return fail(400, 'Invalid email address');
  const lower = clean.toLowerCase();

  if (await checkRateLimit(`emailchg:${ip}`, 5, 600)) return fail(429, 'Too many attempts — try again later');

  const sql = getDb();
  const row = await ownRow(sql, user, currentPassword);
  if (!row) return fail(401, 'Current password is incorrect');
  if (row.email.toLowerCase() === lower) return fail(400, 'That is already your email address');
  // An address that already has an account belongs to someone: moving these
  // rows onto it would merge the two accounts, so this password would open
  // that person's bands (passwordLogin tries every hash of an address).
  if (await addressTaken(sql, lower)) return fail(409, 'That email address is already in use');

  const token   = linkToken();
  const expires = new Date(Date.now() + EMAIL_CHANGE_TTL_MS).toISOString();
  await sql`
    UPDATE users
    SET pending_email = ${lower}, email_change_token_hash = ${token.hash}, email_change_expires_at = ${expires}
    WHERE id = ${row.id}
  `;

  // Fragment, not query — tokens must not land in server/CDN logs.
  const link = `${origin}/confirm-email#token=${encodeURIComponent(token.raw)}&slug=${encodeURIComponent(slug)}`;
  try {
    await sendEmail({
      to: lower,
      subject: 'Confirm your new email address',
      html: `<p>Confirm this address to finish changing your smartist login email:</p>
             <p><a href="${link}">Confirm new email address</a></p>
             <p>Valid for 24 hours. If you did not request this, you can ignore this email.</p>`,
    });
  } catch (err) {
    await logger.error('email_change_request_failed', { band: slug, error: err.message });
    return fail(500, 'Failed to send email');
  }
  return ok({ ok: true });
}

module.exports = {
  acceptInvite, confirmEmailChange,
  listMembers, invite, resendInvite, setRole, removeMember,
  changePassword, requestEmailChange,
};
