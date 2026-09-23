const { getDb } = require('../_db');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { generateMagicToken, generateUserToken, TTL_8H } = require('../_token');
const logger = require('../_logger');
const { resolveOAuthEmail, generateState, verifyState } = require('./identity');
const { resolveArtist, getArtistsForUser } = require('./artist');
const { createSignupToken } = require('./registration');
const { origin } = require('./http');
const { FB_GRAPH_VERSION } = require('../_constants');

function callbackUri(req) {
  return `${origin(req)}/auth/callback`;
}

// GET ?action=google-url — start Google OAuth flow.
async function googleUrl(req, res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return res.status(503).json({ error: 'Google login is not configured' });
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  callbackUri(req),
    response_type: 'code',
    scope:         'openid email',
    state:         generateState('google', req.query.mode || 'login'),
    access_type:   'online',
    prompt:        'select_account',
  });
  return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
}

// GET ?action=facebook-url — start Facebook OAuth flow.
async function facebookUrl(req, res) {
  if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET)
    return res.status(503).json({ error: 'Facebook login is not configured' });
  const params = new URLSearchParams({
    client_id:    process.env.FACEBOOK_APP_ID,
    redirect_uri: callbackUri(req),
    response_type: 'code',
    scope:        'email',
    state:        generateState('facebook', req.query.mode || 'login'),
    // email is the only permission we ask for and the login cannot work
    // without it. Facebook will not re-ask for a permission someone has
    // declined unless told to, so without this one untick locks that person
    // out of Facebook login permanently — every retry would fail with
    // no_email_from_provider and the dialog would never offer it again.
    // Harmless for everyone else: nothing declined, nothing to re-ask.
    auth_type:    'rerequest',
  });
  return res.json({ url: `https://www.facebook.com/${FB_GRAPH_VERSION}/dialog/oauth?${params}` });
}

// GET ?action=oauth-callback — OAuth provider redirects here (routed from
// /auth/callback via vercel.json rewrite). Validates state, exchanges code for
// email, and on success redirects to /login#session=<token>, which home.js
// stores and verifies against the slug-independent my-artists endpoint.
async function oauthCallback(req, res) {
  const o = origin(req);
  // Everything that can go wrong answers the visitor identically. The reason
  // separates "no account for that address" from "expired state", and telling
  // them apart out loud would say whether an address is registered here — so
  // the distinction lives in the log and nowhere else.
  //
  // The log is awaited: the transport is an HTTP call to the log service, and
  // a serverless invocation can be frozen the moment the response is sent.
  // Left un-awaited, the failures worth reading are the ones most likely to be
  // dropped.
  let provider = 'unknown';
  const fail = async (reason) => {
    await logger.error('oauth_callback_failed', { reason, provider });
    return res.redirect(302, `${o}/login?oauth_error=1`);
  };

  if (req.query.error) return fail(`provider_error:${req.query.error}`);

  const { code, state } = req.query;
  if (!code || !state) return fail('missing_code_or_state');

  const stateResult = verifyState(state);
  if (!stateResult) return fail('invalid_or_expired_state');
  provider   = stateResult.provider;
  const mode = stateResult.mode || 'login';

  if (await checkRateLimit(`oauth:${clientIp(req)}`, 10, 60)) return fail('rate_limited');

  let email;
  try {
    email = await resolveOAuthEmail(provider, code, callbackUri(req));
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
      return res.redirect(302, `${o}/signup?error=rate_limited`);
    const rawToken = await createSignupToken(email, sql);
    await logger.info('oauth_signup_started', { provider, email });
    return res.redirect(302, `${o}/onboarding#token=${encodeURIComponent(rawToken)}`);
  }

  if (firstUser) {
    const artists = await getArtistsForUser(firstUser.id, sql);
    const userToken = generateUserToken(firstUser.id, firstUser.role, TTL_8H);
    const hint = Buffer.from(email.toLowerCase()).toString('base64url');
    await logger.info('oauth_login', { provider, email });
    // This is a finished session, not a link to be redeemed. It used to travel
    // as `magic=`, which sent home.js to the password-based magic endpoint —
    // and that looks the user up WITH password_hash IS NOT NULL and checks the
    // token against that hash. An account created through Google has no
    // password and a user token is keyed on APP_SECRET, so it always came back
    // "Invalid or expired login link". `session=` is verified as what it is.
    const next = artists.length > 1 ? '/workspaces' : `/${artists[0]?.slug || ''}/dashboard`;
    return res.redirect(302,
      `${o}/login#session=${encodeURIComponent(userToken)}&hint=${hint}&next=${encodeURIComponent(next)}`);
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
  return res.redirect(302, `${o}/login#magic=${encodeURIComponent(token)}`);
}

module.exports = { googleUrl, facebookUrl, oauthCallback };
