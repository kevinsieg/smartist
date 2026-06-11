const crypto = require('crypto');
const { getArtist, getDb } = require('./_db');
const { wrap } = require('./_handler');
const { validateEmail, validateStr } = require('./_validate');
const { checkRateLimit, clientIp } = require('./_ratelimit');
const { requireAuth, getAccess, isPrivate } = require('./_auth');
const { createPresignedUrl } = require('./_r2');
const { sendEmail } = require('./_email');
const { generateMagicToken, generateUserToken, verifyUserToken, TTL_8H } = require('./_token');
const logger = require('./_logger');
const { resolveOAuthEmail, generateState, verifyState } = require('./_domain/identity');
const { resolveArtist, isSlugAvailable, getArtistsForUser } = require('./_domain/artist');
const { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken, checkEmailDeliverable } = require('./_domain/registration');

// ── OAuth helpers ─────────────────────────────────────────────────────────────

function _origin(req) {
  const h = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return process.env.APP_ORIGIN || `${h.includes('localhost') ? 'http' : 'https'}://${h}`;
}

function _callbackUri(req) {
  return `${_origin(req)}/auth/callback`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = wrap(async function handler(req, res) {

  // ── POST: contact form / email subscribe / demo signup ────────────────────
  if (req.method === 'POST') {
    if (req.body?.action === 'signup-link') {
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
        const origin = _origin(req);
        const hint   = Buffer.from(email).toString('base64url');
        const loginHtml = existing.password_hash
          ? `<p><a href="${origin}/login#magic=${encodeURIComponent(generateMagicToken(existing.password_hash))}&hint=${hint}">Click here to log in</a> (valid for 30 minutes).</p>`
          : `<p>Log in at <a href="${origin}/login">${origin}/login</a> — if you signed up with Google or Facebook, use those buttons.</p>`;
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
      const origin = _origin(req);
      const link = `${origin}/onboarding#token=${encodeURIComponent(rawToken)}`;
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

    if (req.body?.action === 'verify-signup-token') {
      if (await checkRateLimit(`signup-consume:${clientIp(req)}`, 10, 60))
        return res.status(429).json({ error: 'Too many requests' });
      const { token } = req.body ?? {};
      if (!token) return res.status(400).json({ error: 'token required' });
      const sql = getDb();
      const result = await verifySignupToken(String(token), sql);
      if (!result) return res.status(400).json({ error: 'Invalid or expired link' });
      return res.json({ ok: true, email: result.email });
    }

    if (req.body?.action === 'signup') {
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

    if (req.body?.source === 'contact') {
      const name = validateStr(req.body?.name, 200);
      if (!name) return res.status(400).json({ error: 'Name is required' });
      const email = validateEmail(req.body?.email);
      if (!email) return res.status(400).json({ error: 'Valid email required' });
      const message = validateStr(req.body?.message, 5000);
      if (message === false) return res.status(400).json({ error: 'Message too long' });
      if (!message) return res.status(400).json({ error: 'Message is required' });

      if (await checkRateLimit(`contact:${clientIp(req)}`, 3, 3600))
        return res.status(429).json({ error: 'Too many requests — try again later' });

      const to = process.env.CONTACT_EMAIL || 'hi@smartist.studio';
      try {
        await sendEmail({
          to,
          reply_to: email,
          subject: `Contact — ${name}`,
          text: `${message}\n\nFrom: ${name} <${email}>`,
        });
        await logger.info('contact_send', { name, email });
      } catch (err) {
        await logger.error('contact_send_failed', { name, email, error: err.message });
        return res.status(500).json({ error: 'Failed to send — try again later' });
      }
      return res.json({ ok: true });
    }

    const email = validateEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Valid email required' });

    if (await checkRateLimit(`subscribe:${clientIp(req)}`, 5, 3600))
      return res.status(429).json({ error: 'Too many requests — try again later' });

    const sql = getDb();
    const source = req.body?.source === 'demo' ? 'demo' : 'landing';

    if (source === 'demo') {
      const meta = {
        name:            req.body?.name            || null,
        genres:          req.body?.genres           || null,
        perform_country: req.body?.perform_country  || null,
        geo_country: req.headers['x-vercel-ip-country'] || null,
        geo_region:  req.headers['x-vercel-ip-country-region'] || null,
        geo_city:    req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : null,
        ua:      req.headers['user-agent'] || null,
        ref:     req.headers['referer'] || null,
      };
      await sql`
        INSERT INTO subscribers (email, source, meta)
        VALUES (${email}, 'demo', ${meta})
        ON CONFLICT (email) DO UPDATE SET source = 'demo', meta = ${meta}
      `;
      const demoSlug   = process.env.DEMO_ARTIST_SLUG || 'demo';
      const demoArtist = await getArtist(demoSlug);
      const demoToken  = demoArtist?.password_hash ? generateMagicToken(demoArtist.password_hash) : null;
      return res.status(200).json({ ok: true, token: demoToken, slug: demoArtist?.slug || demoSlug });
    }

    try {
      await sql`INSERT INTO subscribers (email, source) VALUES (${email}, 'landing')`;
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Already subscribed' });
      throw err;
    }
    return res.status(200).json({ ok: true });
  }

  // ── PATCH: update artist name / config ────────────────────────────────────
  if (req.method === 'PATCH') {
    const slugParam = req.query.slug || process.env.ARTIST_SLUG || '';
    if (!slugParam) return res.status(400).json({ error: 'slug required' });
    const band = await requireAuth(req, res, slugParam, 'admin');
    if (!band) return;
    const sql = getDb();
    if (req.body?.name !== undefined) {
      const name = validateStr(req.body.name, 200);
      if (!name) return res.status(400).json({ error: 'Name required' });
      await sql`UPDATE artists SET name = ${name} WHERE id = ${band.id}`;
    }
    if (req.body?.config !== undefined) {
      await sql`UPDATE artists SET config = config || ${req.body.config} WHERE id = ${band.id}`;
    }
    return res.json({ ok: true });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── GET ?action=check-slug — is a slug available? ─────────────────────────
  if (req.query.action === 'check-slug') {
    const slugToCheck = String(req.query.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(slugToCheck))
      return res.json({ available: false });
    if (await checkRateLimit(`check-slug:${clientIp(req)}`, 30, 60))
      return res.status(429).json({ error: 'Too many requests' });
    const sql = getDb();
    const available = await isSlugAvailable(slugToCheck, sql);
    return res.json({ available });
  }

  // ── GET ?action=my-artists — artists for current user ─────────────────────
  if (req.query.action === 'my-artists') {
    const authHeader = (req.headers.authorization || '').replace(/^Bearer /, '');
    const claim = verifyUserToken(authHeader);
    if (!claim) return res.status(401).json({ error: 'Unauthorised' });
    const sql = getDb();
    const artists = await getArtistsForUser(claim.userId, sql);
    return res.json({ artists });
  }

  const slugParam = req.query.slug || process.env.ARTIST_SLUG || '';
  if (!slugParam) return res.status(404).json({ error: 'Artist not found' });

  // ── GET ?action=photo-url — presigned upload URL (auth required) ──────────
  if (req.query.action === 'photo-url') {
    const band = await requireAuth(req, res, slugParam, 'admin');
    if (!band) return;
    const contentType = req.query.type || 'image/jpeg';
    if (!contentType.startsWith('image/')) return res.status(400).json({ error: 'Image files only' });
    const key = `bands/${band.slug}/photo`;
    const { uploadUrl, publicUrl } = await createPresignedUrl(key, contentType);
    return res.json({ uploadUrl, publicUrl });
  }

  // ── GET ?action=favicon-url — presigned upload URL for favicon ────────────
  if (req.query.action === 'favicon-url') {
    const band = await requireAuth(req, res, slugParam, 'admin');
    if (!band) return;
    const contentType = req.query.type || 'image/png';
    if (!contentType.startsWith('image/')) return res.status(400).json({ error: 'Image files only' });
    const key = `bands/${band.slug}/favicon`;
    const { uploadUrl, publicUrl } = await createPresignedUrl(key, contentType);
    return res.json({ uploadUrl, publicUrl });
  }

  // ── GET ?action=google-url — start Google OAuth flow ─────────────────────
  if (req.query.action === 'google-url') {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
      return res.status(503).json({ error: 'Google login is not configured' });
    const params = new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      redirect_uri:  _callbackUri(req),
      response_type: 'code',
      scope:         'openid email',
      state:         generateState('google', req.query.mode || 'login'),
      access_type:   'online',
      prompt:        'select_account',
    });
    return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }

  // ── GET ?action=facebook-url — start Facebook OAuth flow ─────────────────
  if (req.query.action === 'facebook-url') {
    if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET)
      return res.status(503).json({ error: 'Facebook login is not configured' });
    const params = new URLSearchParams({
      client_id:    process.env.FACEBOOK_APP_ID,
      redirect_uri: _callbackUri(req),
      response_type: 'code',
      scope:        'email',
      state:        generateState('facebook', req.query.mode || 'login'),
    });
    return res.json({ url: `https://www.facebook.com/v18.0/dialog/oauth?${params}` });
  }

  // ── GET ?action=oauth-callback — OAuth provider redirects here ────────────
  // Routed from /auth/callback via vercel.json rewrite.
  // Validates state, exchanges code for email, and on success redirects
  // to /?magic=<token> so the existing home.js magic-link flow handles login.
  if (req.query.action === 'oauth-callback') {
    const origin = _origin(req);
    const fail   = (reason) => {
      logger.error('oauth_callback_failed', { reason, provider: req.query.state ? 'unknown' : undefined });
      return res.redirect(302, `${origin}/login?oauth_error=1`);
    };

    if (req.query.error) return fail(`provider_error:${req.query.error}`);

    const { code, state } = req.query;
    if (!code || !state) return fail('missing_code_or_state');

    const stateResult = verifyState(state);
    if (!stateResult) return fail('invalid_or_expired_state');
    const provider = stateResult.provider;
    const mode     = stateResult.mode || 'login';

    if (await checkRateLimit(`oauth:${clientIp(req)}`, 10, 60))
      return res.redirect(302, `${origin}/login?oauth_error=1`);

    let email;
    try {
      email = await resolveOAuthEmail(provider, code, _callbackUri(req));
    } catch (err) {
      await logger.error('oauth_token_exchange_failed', { provider, error: err.message });
      return fail('token_exchange_failed');
    }

    if (!email) return fail('no_email_from_provider');

    const sql = getDb();
    const [firstUser] = await sql`
      SELECT u.id, u.role FROM users u WHERE u.email = ${email.toLowerCase()} LIMIT 1
    `;

    // Signup mode only creates a new workspace for genuinely new emails —
    // existing accounts fall through to the login flow below instead of
    // accidentally setting up a second workspace.
    if (mode === 'signup' && !firstUser) {
      if (await checkRateLimit(`signup-link:${email.toLowerCase()}`, 3, 3600))
        return res.redirect(302, `${origin}/signup?error=rate_limited`);
      const rawToken = await createSignupToken(email, sql);
      await logger.info('oauth_signup_started', { provider, email });
      return res.redirect(302, `${origin}/onboarding#token=${encodeURIComponent(rawToken)}`);
    }

    if (firstUser) {
      const artists = await getArtistsForUser(firstUser.id, sql);
      const userToken = generateUserToken(firstUser.id, firstUser.role, TTL_8H);
      const hint = Buffer.from(email.toLowerCase()).toString('base64url');
      await logger.info('oauth_login', { provider, email });
      if (artists.length > 1) {
        return res.redirect(302, `${origin}/login#magic=${encodeURIComponent(userToken)}&hint=${hint}&next=/home`);
      }
      const slug = artists[0]?.slug || '';
      return res.redirect(302, `${origin}/login#magic=${encodeURIComponent(userToken)}&hint=${hint}&next=/${slug}/dashboard`);
    }

    // Single-tenant fallback (ARTIST_ADMIN_EMAIL)
    const adminEmail = process.env.ARTIST_ADMIN_EMAIL;
    if (!adminEmail || email.toLowerCase() !== adminEmail.toLowerCase()) {
      await logger.warn('oauth_email_mismatch', { provider, email });
      return fail('email_not_authorised');
    }
    const band = await resolveArtist('', sql);
    if (!band) return fail('band_not_found');
    await logger.info('oauth_login', { provider, email });
    const token = generateMagicToken(band.password_hash);
    return res.redirect(302, `${origin}/login#magic=${encodeURIComponent(token)}`);
  }

  // ── GET — public config (songs, counts, feature flags) ───────────────────
  // ?light=1 skips the songs payload (full song rows incl. lyrics + GEMA join)
  // for pages that only need name/config/counts — most of the app.
  // Private workspaces serve only name/config/flags (login-page branding) to
  // unauthenticated visitors — no songs, no counts.
  const sql = getDb();
  const { artist: band, user } = await getAccess(req, slugParam);
  if (!band) return res.status(404).json({ error: 'Band not found in database' });
  const priv  = !user && isPrivate(band);
  const light = priv || req.query.light === '1';

  const [songs, [counts]] = await Promise.all([
    light ? Promise.resolve([]) : sql`
      SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language
      FROM songs s
      LEFT JOIN LATERAL (
        SELECT iswc, gema_work_number, language
        FROM gema_works
        WHERE song_id = s.id
        ORDER BY gema_work_number
        LIMIT 1
      ) g ON true
      WHERE s.artist_id = ${band.id} AND s.deleted = false
      ORDER BY s.title
    `,
    priv ? Promise.resolve([undefined]) : sql`
      SELECT
        (SELECT COUNT(*)::int FROM songs      WHERE artist_id = ${band.id} AND NOT deleted) AS songs,
        (SELECT COUNT(*)::int FROM gigs       WHERE artist_id = ${band.id} AND NOT deleted) AS gigs,
        (SELECT COUNT(*)::int FROM venues     WHERE artist_id = ${band.id} AND NOT deleted) AS venues,
        (SELECT COUNT(*)::int FROM organizers WHERE artist_id = ${band.id} AND NOT deleted) AS organizers,
        (SELECT COUNT(*)::int FROM setlists   WHERE artist_id = ${band.id})                 AS setlists
    `,
  ]);

  // Responses vary by auth for private workspaces — only the public variant
  // may sit in a shared CDN cache.
  if (!user) res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.json({
    slug:          band.slug,
    name:          band.name,
    config:        band.config,
    songs:         light ? undefined : songs,
    counts,
    googleLogin:   !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    facebookLogin: !!(process.env.FACEBOOK_APP_ID  && process.env.FACEBOOK_APP_SECRET),
    singleTenant:  !!process.env.ARTIST_SLUG,
  });
});
