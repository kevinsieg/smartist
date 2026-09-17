const { getDb } = require('../_db');
const { validateEmail, validateStr } = require('../_validate');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { sendEmail } = require('../_email');
const { generateMagicToken, generateUserToken, TTL_8H } = require('../_token');
const logger = require('../_logger');
const { isSlugAvailable } = require('./artist');
const { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken, checkEmailDeliverable } = require('./registration');
const { origin } = require('./http');

// POST ?action=signup-link — emails a workspace-setup link (or a login link if
// the address already has an account). The response is identical either way so
// the page can't be used to enumerate accounts.
async function signupLink(req, res) {
  const email = validateEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Valid email required' });
  // Honeypot: hidden form field humans never see — bots that fill it get
  // a fake success and no email.
  if (req.body?.website) return res.json({ ok: true });
  if (await checkRateLimit(`signup-link:${email}`, 3, 3600))
    return res.status(429).json({ error: 'Too many requests — try again in an hour' });
  if (await checkRateLimit(`signup-link-ip:${clientIp(req)}`, 10, 3600))
    return res.status(429).json({ error: 'Too many requests — try again in an hour' });
  const sql = getDb();

  // Already registered → send a login email instead of a setup link.
  // The page response is identical either way (no account enumeration).
  // Additional workspaces are created from /home after logging in.
  const [existing] = await sql`
    SELECT id, email, password_hash FROM users WHERE email = ${email} LIMIT 1
  `;
  if (existing) {
    const o    = origin(req);
    const hint = Buffer.from(email).toString('base64url');
    const loginHtml = existing.password_hash
      ? `<p><a href="${o}/login#magic=${encodeURIComponent(generateMagicToken(existing.password_hash))}&hint=${hint}">Click here to log in</a> (valid for 30 minutes).</p>`
      : `<p>Log in at <a href="${o}/login">${o}/login</a> — if you signed up with Google or Facebook, use those buttons.</p>`;
    try {
      await sendEmail({
        to: email,
        subject: 'You already have a smartist account',
        html: `<p>Someone (probably you) tried to sign up with this email, but it already has a smartist account.</p>${loginHtml}<p>To create an additional workspace, log in and choose “+ New workspace”.</p><p>If this wasn't you, you can ignore this email.</p>`,
      });
    } catch (err) {
      await logger.error('signup_link_failed', { email, error: err.message });
      return res.status(500).json({ error: 'Failed to send email — try again later' });
    }
    await logger.info('signup_link_existing_account', { email });
    return res.json({ ok: true });
  }

  const deliverable = await checkEmailDeliverable(email);
  if (!deliverable.ok) {
    await logger.info('signup_link_rejected', { email, reason: deliverable.reason });
    return res.status(400).json({ error: 'This email address cannot receive mail — please check for typos or use a different address' });
  }
  const rawToken = await createSignupToken(email, sql);
  const link = `${origin(req)}/onboarding#token=${encodeURIComponent(rawToken)}`;
  try {
    await sendEmail({
      to: email,
      subject: 'Your smartist sign-up link',
      html: `<p>Click the link below to set up your artist workspace. Valid for 30 minutes.</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, ignore this email.</p>`,
    });
  } catch (err) {
    await logger.error('signup_link_failed', { email, error: err.message });
    return res.status(500).json({ error: 'Failed to send email — try again later' });
  }
  await logger.info('signup_link_sent', { email });
  return res.json({ ok: true });
}

// POST ?action=verify-signup-token — checks a link token, returns its email.
async function verifySignup(req, res) {
  if (await checkRateLimit(`signup-consume:${clientIp(req)}`, 10, 60))
    return res.status(429).json({ error: 'Too many requests' });
  const { token } = req.body ?? {};
  if (!token) return res.status(400).json({ error: 'token required' });
  const sql = getDb();
  const result = await verifySignupToken(String(token), sql);
  if (!result) return res.status(400).json({ error: 'Invalid or expired link' });
  return res.json({ ok: true, email: result.email });
}

// POST ?action=signup — consumes the token, creates the workspace + admin user,
// returns a session token.
async function signup(req, res) {
  if (await checkRateLimit(`signup-consume:${clientIp(req)}`, 10, 60))
    return res.status(429).json({ error: 'Too many requests' });
  const { token, name, slug: rawSlug } = req.body ?? {};
  if (!token) return res.status(400).json({ error: 'token required' });
  const bandName = validateStr(name, 200);
  if (!bandName) return res.status(400).json({ error: 'Band name required' });
  const slug = String(rawSlug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(slug))
    return res.status(400).json({ error: 'Slug must be 3–50 lowercase letters, numbers, or hyphens' });
  const sql = getDb();
  const verified = await verifySignupToken(String(token), sql);
  if (!verified) return res.status(400).json({ error: 'Invalid or expired link' });
  const available = await isSlugAvailable(slug, sql);
  if (!available) return res.status(409).json({ error: 'That URL is already taken' });
  const { userId } = await createArtistAndAdmin(bandName, slug, verified.email, sql);
  await clearSignupToken(verified.email, sql);
  const sessionToken = generateUserToken(userId, 'admin', TTL_8H);
  await logger.info('signup_complete', { slug, email: verified.email });
  return res.status(201).json({ ok: true, token: sessionToken, slug, role: 'admin', email: verified.email });
}

module.exports = { signupLink, verifySignup, signup };
