const { getDb } = require('../_db');
const { validateEmail, validateStr } = require('../_validate');
const { checkRateLimit } = require('../_ratelimit');
const { sendEmail } = require('../_email');
const { generateMagicToken, generateUserToken, TTL_8H } = require('../_token');
const logger = require('../_logger');
const { isSlugAvailable } = require('./artist');
const { createSignupToken, verifySignupToken, redeemSignupToken, checkEmailDeliverable } = require('./registration');
const { reply, ok, fail } = require('./http');

// POST ?action=signup-link — emails a workspace-setup link (or a login link if
// the address already has an account). The response is identical either way so
// the page can't be used to enumerate accounts.
async function signupLink({ body, ip, origin }) {
  const email = validateEmail(body.email);
  if (!email) return fail(400, 'Valid email required');
  // Honeypot: hidden form field humans never see — bots that fill it get
  // a fake success and no email.
  if (body.website) return ok({ ok: true });
  if (await checkRateLimit(`signup-link:${email}`, 3, 3600))
    return fail(429, 'Too many requests — try again in an hour');
  if (await checkRateLimit(`signup-link-ip:${ip}`, 10, 3600))
    return fail(429, 'Too many requests — try again in an hour');
  const sql = getDb();

  // Already registered → send a login email instead of a setup link.
  // The page response is identical either way (no account enumeration).
  // Additional workspaces are created from /home after logging in.
  const [existing] = await sql`
    SELECT u.id, u.email, u.password_hash, a.slug
    FROM users u JOIN artists a ON a.id = u.artist_id
    WHERE u.email = ${email}
    ORDER BY u.id LIMIT 1
  `;
  if (existing) {
    const o    = origin;
    const hint = Buffer.from(email).toString('base64url');
    // The link is redeemed at /api/<slug>/auth, so it names a workspace: at the
    // root of a multi-tenant deployment the login page has no other way to find
    // one, and dropped the link as if it had never been clicked.
    const next = encodeURIComponent(`/${existing.slug}/dashboard`);
    const loginHtml = existing.password_hash
      ? `<p><a href="${o}/login#magic=${encodeURIComponent(generateMagicToken(existing.password_hash))}&hint=${hint}&next=${next}">Click here to log in</a> (valid for 30 minutes).</p>`
      : `<p>Log in at <a href="${o}/login">${o}/login</a> — if you signed up with Google or Facebook, use those buttons.</p>`;
    try {
      await sendEmail({
        to: email,
        subject: 'You already have a smartist account',
        html: `<p>Someone (probably you) tried to sign up with this email, but it already has a smartist account.</p>${loginHtml}<p>To create an additional workspace, log in and choose “+ New workspace”.</p><p>If this wasn't you, you can ignore this email.</p>`,
      });
    } catch (err) {
      await logger.error('signup_link_failed', { email, error: err.message });
      return fail(500, 'Failed to send email — try again later');
    }
    await logger.info('signup_link_existing_account', { email });
    return ok({ ok: true });
  }

  const deliverable = await checkEmailDeliverable(email);
  if (!deliverable.ok) {
    await logger.info('signup_link_rejected', { email, reason: deliverable.reason });
    return fail(400, 'This email address cannot receive mail — please check for typos or use a different address');
  }
  const rawToken = await createSignupToken(email, sql);
  const link = `${origin}/onboarding#token=${encodeURIComponent(rawToken)}`;
  try {
    await sendEmail({
      to: email,
      subject: 'Your smartist sign-up link',
      html: `<p>Click the link below to set up your artist workspace. Valid for 30 minutes.</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, ignore this email.</p>`,
    });
  } catch (err) {
    await logger.error('signup_link_failed', { email, error: err.message });
    return fail(500, 'Failed to send email — try again later');
  }
  await logger.info('signup_link_sent', { email });
  return ok({ ok: true });
}

// POST ?action=verify-signup-token — checks a link token, returns its email.
async function verifySignup({ body, ip }) {
  if (await checkRateLimit(`signup-consume:${ip}`, 10, 60))
    return fail(429, 'Too many requests');
  const { token } = body;
  if (!token) return fail(400, 'token required');
  const sql = getDb();
  const result = await verifySignupToken(String(token), sql);
  if (!result) return fail(400, 'Invalid or expired link');
  return ok({ ok: true, email: result.email });
}

// POST ?action=signup — consumes the token, creates the workspace + admin user,
// returns a session token.
async function signup({ body, ip }) {
  if (await checkRateLimit(`signup-consume:${ip}`, 10, 60))
    return fail(429, 'Too many requests');
  const { token, name, slug: rawSlug } = body;
  if (!token) return fail(400, 'token required');
  const bandName = validateStr(name, 200);
  if (!bandName) return fail(400, 'Band name required');
  const slug = String(rawSlug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(slug))
    return fail(400, 'Slug must be 3–50 lowercase letters, numbers, or hyphens');
  const sql = getDb();
  const verified = await verifySignupToken(String(token), sql);
  if (!verified) return fail(400, 'Invalid or expired link');
  const available = await isSlugAvailable(slug, sql);
  if (!available) return fail(409, 'That URL is already taken');
  // The checks above answer the common mistakes early; the redemption is what
  // decides: it spends the link and creates the workspace together.
  let created;
  try {
    created = await redeemSignupToken(String(token), bandName, slug, sql);
  } catch (err) {
    if (err.code === '23505') return fail(409, 'That URL is already taken');
    throw err;
  }
  if (!created) return fail(400, 'Invalid or expired link');
  const sessionToken = generateUserToken(created.userId, 'admin', TTL_8H, null, created.email);
  await logger.info('signup_complete', { slug, email: created.email });
  return reply(201, { ok: true, token: sessionToken, slug, role: 'admin', email: created.email });
}

module.exports = { signupLink, verifySignup, signup };
