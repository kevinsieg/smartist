const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getArtist, getDb, getSlug }            = require('../_db');
const { requireAuth, requireRole } = require('../_auth');
const { generateUserToken, TTL_8H, TTL_30D } = require('../_token');
const { getArtistsForUser } = require('../_domain/artist');
const { sendEmail }    = require('../_email');
const { escHtml }      = require('../_html');
const { origin: appOrigin }  = require('../_domain/http');
const { wrap }         = require('../_handler');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { validateStr, validateEmail } = require('../_validate');
const logger           = require('../_logger');

// Invites send mail to any address with the band's name in it, so they are
// capped per band and per IP — an admin session must not be a mail relay.
async function inviteLimited(artist, req) {
  return (await checkRateLimit(`invite:${artist.id}`, 20, 3600))
      || (await checkRateLimit(`invite-ip:${clientIp(req)}`, 30, 3600));
}

// Header values (subjects) must stay on one line.
function oneLine(s) { return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200); }

module.exports = wrap(async function handler(req, res) {
  const slug   = getSlug(req);
  const sql    = getDb();
  const action = new URL(req.url, 'http://x').searchParams.get('action') || '';

  // ── Accept invite (public — no auth) ─────────────────────────────────────
  if (req.method === 'POST' && action === 'accept-invite') {
    const { token, password } = req.body ?? {};
    if (!token || !password)             return res.status(400).json({ error: 'token and password required' });
    if (String(password).length < 8)     return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (String(password).length > 1000)  return res.status(400).json({ error: 'Password too long' });

    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Not found' });

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const [user] = await sql`
      SELECT * FROM users
      WHERE artist_id = ${band.id}
        AND invite_token_hash = ${tokenHash}
        AND invite_expires_at > now()
        AND password_hash IS NULL
    `;
    if (!user) return res.status(400).json({ error: 'Invalid or expired invite' });

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
    return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email, artists });
  }

  // POST ?action=confirm-email-change — public: the link is clicked from an
  // inbox, so there is no session. Two modes: without `confirm` it previews the
  // change (new address + every band affected); with `confirm: true` it applies.
  if (req.method === 'POST' && action === 'confirm-email-change') {
    const { token, confirm } = req.body ?? {};
    if (!token) return res.status(400).json({ error: 'token required' });
    if (await checkRateLimit(`emailchg-confirm:${clientIp(req)}`, 10, 600))
      return res.status(429).json({ error: 'Too many attempts — try again later' });

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const [pending] = await sql`
      SELECT id, email, pending_email FROM users
      WHERE email_change_token_hash = ${tokenHash}
        AND email_change_expires_at > now()
        AND pending_email IS NOT NULL
    `;
    if (!pending) return res.status(400).json({ error: 'Invalid or expired link' });

    // Every band reached by the current address — the change moves all of them.
    const bands = await sql`
      SELECT a.slug, a.name, u.role
      FROM users u JOIN artists a ON a.id = u.artist_id
      WHERE u.email = ${pending.email}
      ORDER BY a.name
    `;

    if (!confirm) return res.json({ newEmail: pending.pending_email, bands });

    const oldEmail = pending.email;
    const target   = pending.pending_email;
    try {
      await sql.begin(async tx => {
        // Refuse if the address is already taken in any band this change touches.
        const [clash] = await tx`
          SELECT 1 FROM users u
          WHERE u.email = ${target}
            AND u.artist_id IN (SELECT artist_id FROM users WHERE email = ${oldEmail})
          LIMIT 1
        `;
        if (clash) throw Object.assign(new Error('taken'), { taken: true });

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
      if (err.taken || err.code === '23505')
        return res.status(409).json({ error: 'That email address is already in use' });
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

    return res.json({ ok: true, email: target });
  }

  // ── Authenticated actions ─────────────────────────────────────────────────
  const artist = await requireAuth(req, res, slug);
  if (!artist) return;

  // GET — list users (admin)
  if (req.method === 'GET') {
    if (!requireRole(req, res, 'admin')) return;
    const users = await sql`
      SELECT id, email, role, created_at, invite_expires_at,
             (password_hash IS NOT NULL)                                                               AS accepted,
             (invite_token_hash IS NOT NULL AND invite_expires_at >  now() AND password_hash IS NULL) AS invite_pending,
             (invite_token_hash IS NOT NULL AND invite_expires_at <= now() AND password_hash IS NULL) AS invite_expired
      FROM users WHERE artist_id = ${artist.id}
      ORDER BY created_at
    `;
    return res.json({ users });
  }

  // POST ?action=invite — send invite (admin)
  if (req.method === 'POST' && action === 'invite') {
    if (!requireRole(req, res, 'admin')) return;
    const { email, role } = req.body ?? {};
    const rawEmail = validateStr(email, 200);
    if (rawEmail === null) return res.status(400).json({ error: 'Email required' });
    const cleanEmail = rawEmail && validateEmail(rawEmail);
    if (!cleanEmail) return res.status(400).json({ error: 'Invalid email address' });
    if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const [existing] = await sql`SELECT id FROM users WHERE artist_id = ${artist.id} AND email = ${cleanEmail.toLowerCase()}`;
    if (existing) return res.status(409).json({ error: 'User already exists' });
    if (await inviteLimited(artist, req)) return res.status(429).json({ error: 'Too many invites — try again later' });

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [newUser] = await sql`
      INSERT INTO users (artist_id, email, role, invite_token_hash, invite_expires_at, invited_by)
      VALUES (${artist.id}, ${cleanEmail.toLowerCase()}, ${role}, ${tokenHash}, ${expires}, ${req.user.id})
      RETURNING id, email, role
    `;

    const origin = appOrigin(req);
    const link   = `${origin}/login#invite=${rawToken}`;

    try {
      await sendEmail({
        to: cleanEmail,
        subject: `You've been invited to ${oneLine(artist.name)}`,
        html: `<p>You've been invited to access ${escHtml(artist.name)} on smartist.</p>
               <p><a href="${link}">Accept invite and set your password</a></p>
               <p>This link expires in 7 days.</p>`,
      });
    } catch (err) {
      await logger.error('invite_email_failed', { band: slug, error: err.message });
      await sql`DELETE FROM users WHERE id = ${newUser.id}`;
      return res.status(500).json({ error: 'Failed to send invite email' });
    }
    return res.status(201).json({ ok: true, user: newUser });
  }

  // POST ?action=resend-invite (admin)
  if (req.method === 'POST' && action === 'resend-invite') {
    if (!requireRole(req, res, 'admin')) return;
    const { userId } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const [user] = await sql`
      SELECT * FROM users WHERE id = ${Number(userId)} AND artist_id = ${artist.id} AND password_hash IS NULL
    `;
    if (!user) return res.status(404).json({ error: 'Pending invite not found' });
    if (await inviteLimited(artist, req)) return res.status(429).json({ error: 'Too many invites — try again later' });

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await sql`UPDATE users SET invite_token_hash = ${tokenHash}, invite_expires_at = ${expires} WHERE id = ${user.id}`;

    const origin = appOrigin(req);
    const link   = `${origin}/login#invite=${rawToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: `Invite reminder — ${oneLine(artist.name)}`,
        html: `<p>Here is your updated invite link for ${escHtml(artist.name)}:</p>
               <p><a href="${link}">Accept invite and set your password</a></p>
               <p>This link expires in 7 days.</p>`,
      });
    } catch (err) {
      await logger.error('invite_email_failed', { band: slug, error: err.message });
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.json({ ok: true });
  }

  // POST ?action=change-password — caller changes their own password
  if (req.method === 'POST' && action === 'change-password') {
    const { currentPassword, newPassword, rememberMe } = req.body ?? {};
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    if (String(newPassword).length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (String(newPassword).length > 1000 || String(currentPassword).length > 1000)
      return res.status(400).json({ error: 'Password too long' });
    if (req.user.id === null)
      return res.status(400).json({ error: 'Password change is not available for this account' });
    if (await checkRateLimit(`chpw:${clientIp(req)}`, 5, 600))
      return res.status(429).json({ error: 'Too many attempts — try again later' });

    const [user] = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    if (!user || !user.password_hash || !await bcrypt.compare(String(currentPassword), user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });

    // Every band of this address: after a compromise, a password changed in one
    // band must not keep working through another.
    const hash = await bcrypt.hash(String(newPassword), 12);
    await sql`UPDATE users SET password_hash = ${hash} WHERE email = ${user.email}`;
    // The new hash invalidates every session issued before it, this one
    // included — hand back a replacement so the caller stays signed in.
    const token = generateUserToken(user.id, user.role, rememberMe ? TTL_30D : TTL_8H, hash);
    return res.json({ ok: true, token });
  }

  // POST ?action=request-email-change — caller asks to change their own login
  // email. Nothing changes until the link sent to the NEW address is confirmed:
  // email is the cross-workspace identity, so it must be proven, not asserted.
  if (req.method === 'POST' && action === 'request-email-change') {
    const { currentPassword, newEmail } = req.body ?? {};
    if (!currentPassword || !newEmail)
      return res.status(400).json({ error: 'currentPassword and newEmail required' });
    if (String(currentPassword).length > 1000)
      return res.status(400).json({ error: 'Password too long' });
    if (req.user.id === null)
      return res.status(400).json({ error: 'Email change is not available for this account' });

    const clean = validateStr(newEmail, 200);
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean))
      return res.status(400).json({ error: 'Invalid email address' });
    const lower = clean.toLowerCase();

    if (await checkRateLimit(`emailchg:${clientIp(req)}`, 5, 600))
      return res.status(429).json({ error: 'Too many attempts — try again later' });

    const [user] = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    if (!user || !user.password_hash || !await bcrypt.compare(String(currentPassword), user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });
    if (user.email.toLowerCase() === lower)
      return res.status(400).json({ error: 'That is already your email address' });

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires   = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await sql`
      UPDATE users
      SET pending_email = ${lower}, email_change_token_hash = ${tokenHash}, email_change_expires_at = ${expires}
      WHERE id = ${user.id}
    `;

    const origin = appOrigin(req);
    // Fragment, not query — tokens must not land in server/CDN logs.
    const link   = `${origin}/confirm-email#token=${encodeURIComponent(rawToken)}&slug=${encodeURIComponent(slug)}`;

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
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.json({ ok: true });
  }


  // PUT — update user role (admin). Login email is never admin-editable: it is
  // the cross-workspace identity (resolveUser joins users on email), so rewriting
  // it would hand this user another account's memberships.
  if (req.method === 'PUT') {
    if (!requireRole(req, res, 'admin')) return;
    const { userId, role, email } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (email !== undefined) return res.status(400).json({ error: 'Email cannot be changed' });
    if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (req.user.id !== null && req.user.id === Number(userId))
      return res.status(400).json({ error: 'Cannot change your own role' });

    const [updated] = await sql`
      UPDATE users SET role = ${role}
      WHERE id = ${Number(userId)} AND artist_id = ${artist.id}
      RETURNING id, email, role
    `;
    if (!updated) return res.status(404).json({ error: 'User not found' });
    return res.json({ ok: true, user: updated });
  }

  // DELETE — remove user (admin)
  if (req.method === 'DELETE') {
    if (!requireRole(req, res, 'admin')) return;
    const { userId } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (req.user.id !== null && req.user.id === Number(userId)) return res.status(400).json({ error: 'Cannot remove yourself' });

    const [deleted] = await sql`
      DELETE FROM users WHERE id = ${Number(userId)} AND artist_id = ${artist.id} RETURNING id
    `;
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
});
