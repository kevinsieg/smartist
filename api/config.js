const crypto = require('crypto');
const { getArtist, getDb } = require('./_db');
const { wrap } = require('./_handler');
const { validateEmail, validateStr } = require('./_validate');
const { checkRateLimit, clientIp } = require('./_ratelimit');
const { requireAuth } = require('./_auth');
const { createPresignedUrl } = require('./_r2');
const { sendEmail } = require('./_email');
const { generateMagicToken } = require('./_token');
const logger = require('./_logger');

// ── OAuth helpers ─────────────────────────────────────────────────────────────

function _origin(req) {
  const h = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return process.env.APP_ORIGIN || `${h.includes('localhost') ? 'http' : 'https'}://${h}`;
}

function _callbackUri(req) {
  return `${_origin(req)}/auth/callback`;
}

// State is signed with the provider's own client secret so each provider's
// state is independently verifiable without a separate env var.
function _stateSecret(provider) {
  if (provider === 'google')   return process.env.GOOGLE_CLIENT_SECRET   || '';
  if (provider === 'facebook') return process.env.FACEBOOK_APP_SECRET    || '';
  return '';
}

function _generateState(provider) {
  const nonce   = crypto.randomBytes(10).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000; // 15 min
  const msg     = `${provider}:${nonce}:${expires}`;
  const sig     = crypto.createHmac('sha256', _stateSecret(provider)).update(msg).digest('hex');
  return Buffer.from(JSON.stringify({ provider, nonce, expires, sig })).toString('base64url');
}

function _verifyState(state) {
  try {
    const { provider, nonce, expires, sig } = JSON.parse(Buffer.from(state, 'base64url').toString());
    if (Date.now() > Number(expires)) return null;
    const msg      = `${provider}:${nonce}:${expires}`;
    const expected = crypto.createHmac('sha256', _stateSecret(provider)).update(msg).digest('hex');
    if (sig.length !== expected.length) return null;
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')) ? provider : null;
  } catch { return null; }
}

// Exchange OAuth code for the user's email address.
async function _resolveEmail(provider, code, redirectUri) {
  if (provider === 'google') {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    const { access_token, error } = await tokenRes.json();
    if (error || !access_token) throw new Error(`Google token error: ${error}`);
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { email } = await userRes.json();
    return email || null;
  }

  if (provider === 'facebook') {
    const params = new URLSearchParams({
      client_id:     process.env.FACEBOOK_APP_ID,
      client_secret: process.env.FACEBOOK_APP_SECRET,
      redirect_uri:  redirectUri,
      code,
    });
    const tokenRes = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?${params}`);
    const { access_token, error } = await tokenRes.json();
    if (error || !access_token) throw new Error(`Facebook token error: ${error?.message}`);
    const userRes = await fetch(`https://graph.facebook.com/me?fields=email&access_token=${encodeURIComponent(access_token)}`);
    const { email } = await userRes.json();
    return email || null;
  }

  return null;
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = wrap(async function handler(req, res) {

  // ── POST: contact form / email subscribe / demo signup ────────────────────
  if (req.method === 'POST') {
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
      const demoArtist = await getArtist(process.env.ARTIST_SLUG);
      const demoToken = demoArtist ? generateMagicToken(demoArtist.password_hash) : null;
      return res.status(200).json({ ok: true, token: demoToken });
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
    const slug = process.env.ARTIST_SLUG;
    if (!slug) return res.status(500).json({ error: 'ARTIST_SLUG not configured' });
    const band = await requireAuth(req, res, slug);
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

  const slug = process.env.ARTIST_SLUG;
  if (!slug) return res.status(500).json({ error: 'ARTIST_SLUG not configured' });

  // ── GET ?action=photo-url — presigned upload URL (auth required) ──────────
  if (req.query.action === 'photo-url') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const contentType = req.query.type || 'image/jpeg';
    if (!contentType.startsWith('image/')) return res.status(400).json({ error: 'Image files only' });
    const key = `bands/${band.slug}/photo`;
    const { uploadUrl, publicUrl } = await createPresignedUrl(key, contentType);
    return res.json({ uploadUrl, publicUrl });
  }

  // ── GET ?action=favicon-url — presigned upload URL for favicon ────────────
  if (req.query.action === 'favicon-url') {
    const band = await requireAuth(req, res, slug);
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
      state:         _generateState('google'),
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
      state:        _generateState('facebook'),
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
      return res.redirect(302, `${origin}/?oauth_error=1`);
    };

    if (req.query.error) return fail(`provider_error:${req.query.error}`);

    const { code, state } = req.query;
    if (!code || !state) return fail('missing_code_or_state');

    const provider = _verifyState(state);
    if (!provider) return fail('invalid_or_expired_state');

    if (await checkRateLimit(`oauth:${clientIp(req)}`, 10, 60))
      return res.redirect(302, `${origin}/?oauth_error=1`);

    let email;
    try {
      email = await _resolveEmail(provider, code, _callbackUri(req));
    } catch (err) {
      await logger.error('oauth_token_exchange_failed', { provider, error: err.message });
      return fail('token_exchange_failed');
    }

    const adminEmail = process.env.ARTIST_ADMIN_EMAIL;
    if (!email || !adminEmail || email.toLowerCase() !== adminEmail.toLowerCase()) {
      await logger.warn('oauth_email_mismatch', { provider, email });
      return fail('email_not_authorised');
    }

    const band = await getArtist(slug);
    if (!band) return fail('band_not_found');

    await logger.info('oauth_login', { provider, email });
    const token = generateMagicToken(band.password_hash);
    return res.redirect(302, `${origin}/?magic=${encodeURIComponent(token)}`);
  }

  // ── GET — public config (songs, counts, feature flags) ───────────────────
  // Run all three queries in parallel — artist lookup is embedded as a subquery
  // so we avoid the sequential getArtist() → data queries pattern.
  const sql = getDb();
  const [[band], songs, [counts]] = await Promise.all([
    sql`SELECT id, slug, name, config FROM artists WHERE slug = ${slug} LIMIT 1`,
    sql`
      SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language
      FROM songs s
      LEFT JOIN LATERAL (
        SELECT iswc, gema_work_number, language
        FROM gema_works
        WHERE song_id = s.id
        ORDER BY gema_work_number
        LIMIT 1
      ) g ON true
      WHERE s.artist_id = (SELECT id FROM artists WHERE slug = ${slug}) AND s.deleted = false
      ORDER BY s.title
    `,
    sql`
      SELECT
        (SELECT COUNT(*)::int FROM gigs       WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug}) AND NOT deleted) AS gigs,
        (SELECT COUNT(*)::int FROM venues     WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug}) AND NOT deleted) AS venues,
        (SELECT COUNT(*)::int FROM organizers WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug}) AND NOT deleted) AS organizers,
        (SELECT COUNT(*)::int FROM setlists   WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug}))                 AS setlists
    `,
  ]);
  if (!band) return res.status(404).json({ error: 'Band not found in database' });

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  res.json({
    slug:          band.slug,
    name:          band.name,
    config:        band.config,
    songs,
    counts,
    googleLogin:   !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    facebookLogin: !!(process.env.FACEBOOK_APP_ID  && process.env.FACEBOOK_APP_SECRET),
  });
});
