const crypto = require('crypto');
const { getDb } = require('../_db');
const { checkRateLimit } = require('../_ratelimit');
const { generateUserToken, TTL_8H } = require('../_token');
const logger = require('../_logger');
const { resolveOAuthEmail, generateState, verifyState } = require('./identity');
const { getArtistsForUser } = require('./artist');
const { createSignupToken } = require('./registration');
const { ok, fail } = require('./http');
const { FB_GRAPH_VERSION } = require('../_constants');

function callbackUri(origin) {
  return `${origin}/auth/callback`;
}

const NONCE_COOKIE = 'oauth_nonce';

// Set on the OAuth start (a same-origin fetch), sent back by the browser on the
// provider's top-level redirect to /auth/callback (SameSite=Lax allows that).
function nonceCookie() {
  const nonce = crypto.randomBytes(16).toString('hex');
  return { nonce, header: `${NONCE_COOKIE}=${nonce}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax` };
}
const CLEAR_NONCE = `${NONCE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

function readNonceCookie(headers) {
  const m = new RegExp(`(?:^|;\\s*)${NONCE_COOKIE}=([0-9a-f]{32})(?:;|$)`).exec(headers?.cookie || '');
  return m ? m[1] : null;
}

// GET ?action=google-url — start Google OAuth flow.
async function googleUrl({ query, origin }) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return fail(503, 'Google login is not configured');
  const { nonce, header } = nonceCookie();
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  callbackUri(origin),
    response_type: 'code',
    scope:         'openid email',
    state:         generateState('google', query.mode || 'login', nonce),
    access_type:   'online',
    prompt:        'select_account',
  });
  return { ...ok({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }), headers: { 'Set-Cookie': header } };
}

// GET ?action=facebook-url — start Facebook OAuth flow.
async function facebookUrl({ query, origin }) {
  if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET)
    return fail(503, 'Facebook login is not configured');
  const { nonce, header } = nonceCookie();
  const params = new URLSearchParams({
    client_id:    process.env.FACEBOOK_APP_ID,
    redirect_uri: callbackUri(origin),
    response_type: 'code',
    scope:        'email',
    state:        generateState('facebook', query.mode || 'login', nonce),
    // email is the only permission we ask for and the login cannot work
    // without it. Facebook will not re-ask for a permission someone has
    // declined unless told to, so without this one untick locks that person
    // out of Facebook login permanently — every retry would fail with
    // no_email_from_provider and the dialog would never offer it again.
    // Harmless for everyone else: nothing declined, nothing to re-ask.
    auth_type:    'rerequest',
  });
  return { ...ok({ url: `https://www.facebook.com/${FB_GRAPH_VERSION}/dialog/oauth?${params}` }), headers: { 'Set-Cookie': header } };
}

// GET ?action=oauth-callback — OAuth provider redirects here (routed from
// /auth/callback via vercel.json rewrite). Validates state, exchanges code for
// email, and on success redirects to /login#session=<token>, which home.js
// stores and verifies against the slug-independent my-artists endpoint.
async function oauthCallback({ query, headers, ip, origin }) {
  const o = origin;
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
  // Once the nonce matched it is spent: every later answer clears the cookie.
  let cookie = {};
  const redirect = to => ({ status: 302, redirect: to, headers: cookie });
  const failed = async (reason) => {
    await logger.error('oauth_callback_failed', { reason, provider });
    return redirect(`${o}/login?oauth_error=1`);
  };

  if (query.error) return failed(`provider_error:${query.error}`);

  const { code, state } = query;
  if (!code || !state) return failed('missing_code_or_state');

  const stateResult = verifyState(state);
  if (!stateResult) return failed('invalid_or_expired_state');
  const cookieNonce = readNonceCookie(headers);
  // Not a secret (it also travels in the state): only proof this browser began the flow.
  if (!cookieNonce || stateResult.nonce !== cookieNonce) return failed('state_not_from_this_browser');
  cookie = { 'Set-Cookie': CLEAR_NONCE };
  provider   = stateResult.provider;
  const mode = stateResult.mode || 'login';

  if (await checkRateLimit(`oauth:${ip}`, 10, 60)) return failed('rate_limited');

  let email;
  try {
    email = await resolveOAuthEmail(provider, code, callbackUri(origin));
  } catch (err) {
    await logger.error('oauth_token_exchange_failed', { provider, error: err.message });
    return failed('token_exchange_failed');
  }

  if (!email) return failed('no_email_from_provider');

  const sql = getDb();
  const [firstUser] = await sql`
    SELECT u.id, u.role, u.password_hash FROM users u WHERE u.email = ${email.toLowerCase()} ORDER BY u.id LIMIT 1
  `;

  // Signup mode only creates a new workspace for genuinely new emails —
  // existing accounts fall through to the login flow below instead of
  // accidentally setting up a second workspace.
  if (mode === 'signup' && !firstUser) {
    if (await checkRateLimit(`signup-link:${email.toLowerCase()}`, 3, 3600))
      return redirect(`${o}/signup?error=rate_limited`);
    const rawToken = await createSignupToken(email, sql);
    await logger.info('oauth_signup_started', { provider, email });
    return redirect(`${o}/onboarding#token=${encodeURIComponent(rawToken)}`);
  }

  // Facebook has no verified-email flag (see identity.js). Matching its address
  // to an existing account is therefore opt-in per deployment: without it, an
  // address someone merely typed into Facebook would open that account here.
  if (firstUser && provider === 'facebook' && process.env.FACEBOOK_TRUST_EMAIL !== 'true')
    return failed('facebook_email_not_trusted');

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
    return redirect(`${o}/login#session=${encodeURIComponent(userToken)}&hint=${hint}&next=${encodeURIComponent(next)}`);
  }

  await logger.warn('oauth_email_mismatch', { provider, email });
  return failed('email_not_authorised');
}

module.exports = { googleUrl, facebookUrl, oauthCallback };
