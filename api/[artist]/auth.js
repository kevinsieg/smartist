const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getArtist, getDb, getSlug }            = require('../_db');
const { checkCredentials, requireAuth, requireRole } = require('../_auth');
const { generateUserToken, generateMagicToken, verifyMagicToken, TTL_8H, TTL_30D } = require('../_token');
const { sendEmail }    = require('../_email');
const { wrap }         = require('../_handler');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { validateStr }  = require('../_validate');
const logger           = require('../_logger');

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

    const hash = await bcrypt.hash(password, 12);
    await sql`
      UPDATE users
      SET password_hash = ${hash}, invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = ${user.id}
    `;
    const sessionToken = generateUserToken(user.id, user.role, TTL_8H);
    return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email });
  }

  // ── Password reset request (via /api/:artist/request-reset rewrite) ───────
  if (req.method === 'POST' && req.url.includes('request-reset')) {
    const { email } = req.body ?? {};
    if (await checkRateLimit(`reset:${clientIp(req)}`, 3, 600))
      return res.json({ ok: true }); // silent

    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Not found' });

    const cleanEmail = String(email || '').trim().toLowerCase();
    const [user] = await sql`
      SELECT * FROM users
      WHERE artist_id = ${band.id} AND email = ${cleanEmail} AND password_hash IS NOT NULL
    `;

    let resetEmail, tokenSeed;
    if (user) {
      resetEmail = user.email;
      tokenSeed  = user.password_hash;
    } else {
      // Bootstrap fallback: match ARTIST_ADMIN_EMAIL
      const adminEmail = process.env.ARTIST_ADMIN_EMAIL;
      if (!adminEmail || cleanEmail !== adminEmail.toLowerCase()) return res.json({ ok: true });
      resetEmail = adminEmail;
      tokenSeed  = band.password_hash;
    }

    const resetToken = generateMagicToken(tokenSeed);
    const h      = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const proto  = req.headers['x-forwarded-proto'] || (h.includes('localhost') ? 'http' : 'https');
    const origin = process.env.APP_ORIGIN || `${proto}://${h}`;
    // Encode email as hint so client can pass it back for user lookup
    const hint   = Buffer.from(resetEmail).toString('base64url');
    const link   = `${origin}/login?magic=${encodeURIComponent(resetToken)}&hint=${hint}`;

    try {
      await sendEmail({
        to: resetEmail,
        subject: 'Login link',
        html: `<p>Here is your login link:</p><p><a href="${link}">${link}</a></p><p>Valid for 30 minutes. Do not share this link.</p>`,
      });
    } catch (err) {
      await logger.error('request_reset_failed', { band: slug, error: err.message });
      return res.status(500).json({ error: 'Failed to send email' });
    }
    return res.json({ ok: true });
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && !action) {
    const { email, password, rememberMe, magic, hint } = req.body ?? {};

    // Magic token login (password reset link click)
    if (magic) {
      if (await checkRateLimit(`auth:${clientIp(req)}`, 10, 60))
        return res.status(429).json({ error: 'Too many attempts — try again later' });
      const band = await getArtist(slug);
      if (!band) return res.status(404).json({ error: 'Not found' });

      if (hint) {
        // Multi-user magic: decode email from hint, verify against user's password_hash
        const hintEmail = Buffer.from(hint, 'base64url').toString().toLowerCase();
        const [user] = await sql`
          SELECT * FROM users
          WHERE artist_id = ${band.id} AND email = ${hintEmail} AND password_hash IS NOT NULL
        `;
        if (user && verifyMagicToken(magic, user.password_hash)) {
          const sessionToken = generateUserToken(user.id, user.role, TTL_8H);
          return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email });
        }
        return res.status(401).json({ error: 'Invalid or expired login link' });
      }
      // Bootstrap magic token (no hint → single-user install)
      if (await checkCredentials(magic, band)) {
        return res.json({ ok: true, adminEmail: process.env.ARTIST_ADMIN_EMAIL || null });
      }
      return res.status(401).json({ error: 'Invalid or expired login link' });
    }

    // Legacy bootstrap: password-only (no email field, old installs)
    if (!email && password) {
      if (String(password).length > 1000) return res.status(400).json({ error: 'Invalid' });
      if (await checkRateLimit(`auth:${clientIp(req)}`, 10, 60))
        return res.status(429).json({ error: 'Too many attempts — try again later' });
      const band = await getArtist(slug);
      if (!band) return res.status(404).json({ error: 'Artist not found' });
      if (!await checkCredentials(password, band)) return res.status(401).json({ error: 'Invalid password' });
      return res.json({ ok: true, adminEmail: process.env.ARTIST_ADMIN_EMAIL || null });
    }

    // Email + password login
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (await checkRateLimit(`auth:${clientIp(req)}`, 10, 60))
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Artist not found' });

    const [user] = await sql`
      SELECT * FROM users
      WHERE artist_id = ${band.id}
        AND email = ${String(email).trim().toLowerCase()}
        AND password_hash IS NOT NULL
    `;
    if (!user || !await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });

    const ttl   = rememberMe ? TTL_30D : TTL_8H;
    const token = generateUserToken(user.id, user.role, ttl);
    return res.json({ ok: true, token, role: user.role, email: user.email });
  }

  // ── Authenticated actions ─────────────────────────────────────────────────
  const artist = await requireAuth(req, res, slug);
  if (!artist) return;

  // GET — list users (admin)
  if (req.method === 'GET') {
    if (!requireRole(req, res, 'admin')) return;
    const users = await sql`
      SELECT id, email, role, created_at, invite_expires_at,
             (password_hash IS NOT NULL)                                    AS accepted,
             (invite_token_hash IS NOT NULL AND invite_expires_at > now())  AS invite_pending
      FROM users WHERE artist_id = ${artist.id}
      ORDER BY created_at
    `;
    return res.json({ users });
  }

  // POST ?action=invite — send invite (admin)
  if (req.method === 'POST' && action === 'invite') {
    if (!requireRole(req, res, 'admin')) return;
    const { email, role } = req.body ?? {};
    const cleanEmail = validateStr(email, 200);
    if (!cleanEmail) return res.status(400).json({ error: 'Email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail))
      return res.status(400).json({ error: 'Invalid email address' });
    if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const [existing] = await sql`SELECT id FROM users WHERE artist_id = ${artist.id} AND email = ${cleanEmail.toLowerCase()}`;
    if (existing) return res.status(409).json({ error: 'User already exists' });

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [newUser] = await sql`
      INSERT INTO users (artist_id, email, role, invite_token_hash, invite_expires_at, invited_by)
      VALUES (${artist.id}, ${cleanEmail.toLowerCase()}, ${role}, ${tokenHash}, ${expires}, ${req.user.id})
      RETURNING id, email, role
    `;

    const h      = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const proto  = req.headers['x-forwarded-proto'] || (h.includes('localhost') ? 'http' : 'https');
    const origin = process.env.APP_ORIGIN || `${proto}://${h}`;
    const link   = `${origin}/login?invite=${rawToken}`;

    try {
      await sendEmail({
        to: cleanEmail,
        subject: `You've been invited to ${artist.name}`,
        html: `<p>You've been invited to access ${artist.name} on smartist.</p>
               <p><a href="${link}">Accept invite and set your password</a></p>
               <p>This link expires in 7 days.</p>`,
      });
    } catch (err) {
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

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await sql`UPDATE users SET invite_token_hash = ${tokenHash}, invite_expires_at = ${expires} WHERE id = ${user.id}`;

    const h      = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const proto  = req.headers['x-forwarded-proto'] || (h.includes('localhost') ? 'http' : 'https');
    const origin = process.env.APP_ORIGIN || `${proto}://${h}`;
    const link   = `${origin}/login?invite=${rawToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: `Invite reminder — ${artist.name}`,
        html: `<p>Here is your updated invite link for ${artist.name}:</p>
               <p><a href="${link}">Accept invite and set your password</a></p>
               <p>This link expires in 7 days.</p>`,
      });
    } catch { return res.status(500).json({ error: 'Failed to send email' }); }

    return res.json({ ok: true });
  }

  // PUT — update user role (admin)
  if (req.method === 'PUT') {
    if (!requireRole(req, res, 'admin')) return;
    const { userId, role } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (req.user.id !== null && req.user.id === Number(userId)) return res.status(400).json({ error: 'Cannot change your own role' });

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
