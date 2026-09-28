const crypto = require('crypto');
const { getDb } = require('../_db');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { generateUserToken, TTL_8H } = require('../_token');
const logger = require('../_logger');
const { resolveOAuthEmail, generateState, verifyState } = require('./identity');
const { getArtistsForUser } = require('./artist');
const { createSignupToken } = require('./registration');
const { origin } = require('./http');
const { FB_GRAPH_VERSION } = require('../_constants');

function callbackUri(req) {
  return `${origin(req)}/auth/callback`;
}

const NONCE_COOKIE = 'oauth_nonce';

// Set on the OAuth start (a same-origin fetch), sent back by the browser on the
// provider's top-level redirect to /auth/callback (SameSite=Lax allows that).
function setNonceCookie(res) {
  const nonce = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie',
    `${NONCE_COOKIE}=${nonce}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax`);
  return nonce;
}

function readNonceCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${NONCE_COOKIE}=([0-9a-f]{32})(?:;|$)`).exec(req.headers?.cookie || '');
  return m ? m[1] : null;
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
    state:         generateState('google', req.query.mode || 'login', setNonceCookie(res)),
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
    state:        generateState('facebook', req.query.mode || 'login', setNonceCookie(res)),
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
  const cookieNonce = readNonceCookie(req);
  // Not a secret (it also travels in the state): only proof this browser began the flow.
  if (!cookieNonce || stateResult.nonce !== cookieNonce) return fail('state_not_from_this_browser');
  res.setHeader('Set-Cookie', `${NONCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
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
    SELECT u.id, u.role, u.password_hash FROM users u WHERE u.email = ${email.toLowerCase()} ORDER BY u.id LIMIT 1
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

  // Facebook has no verified-email flag (see identity.js). Matching its address
  // to an existing account is therefore opt-in per deployment: without it, an
  // address someone merely typed into Facebook would open that account here.
  if (firstUser && provider === 'facebook' && process.env.FACEBOOK_TRUST_EMAIL !== 'true')
    return fail('facebook_email_not_trusted');

  if (firstUser) {
    const artists = await getArtistsForUser(firstUser.id, sql);
    const userToken = generateUserToken(firstUser.id, firstUser.role, TTL_8H, firstUser.password_hash);
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

  await logger.warn('oauth_email_mismatch', { provider, email });
  return fail('email_not_authorised');
}

module.exports = { googleUrl, facebookUrl, oauthCallback };
