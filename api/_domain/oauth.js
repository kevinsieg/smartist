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

// The finished session travels from the callback to the login page in a
// short-lived HttpOnly cookie that only this site's own scripts can redeem,
// not in the URL. A URL carrying a session is a login link: anyone holding one
// for their own account could send it to someone else and sign them in as
// that account (login CSRF), and it sits in history while it lives.
const SESSION_COOKIE = 'oauth_session';
const sessionCookie = token => `${SESSION_COOKIE}=${token}; Path=/api; Max-Age=120; HttpOnly; Secure; SameSite=Strict`;
const CLEAR_SESSION = `${SESSION_COOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

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
// email, and on success sets the oauth_session cookie and redirects to
// /login#oauth=1, where home.js redeems the cookie (oauthSession below) and
// verifies the token against the slug-independent my-artists endpoint.
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

  // Facebook has no verified-email flag (see identity.js), so its address proves
  // nothing — for a new account either. A workspace set up under an address
  // someone merely typed into Facebook would later reach every band that
  // invites the address's real owner (memberships join on email). Unless the
  // deployment opts in, a new Facebook address goes through the emailed
  // signup link instead.
  const untrustedFacebook = provider === 'facebook' && process.env.FACEBOOK_TRUST_EMAIL !== 'true';

  // A new address goes on to set up a workspace, whichever button started the
  // flow: "Continue with Google" on the login page used to answer a new
  // Google account with "Sign-in failed". This says nothing about which
  // addresses have accounts — the provider has already shown this visitor
  // owns the address. Existing accounts always fall through to the login
  // below, so signup mode never sets up a second workspace.
  if (!firstUser) {
    if (untrustedFacebook) {
      await logger.warn('oauth_callback_failed', { reason: 'facebook_email_not_trusted', provider });
      return redirect(`${o}/signup?error=verify_email`);
    }
    if (await checkRateLimit(`signup-link:${email.toLowerCase()}`, 3, 3600))
      return redirect(`${o}/signup?error=rate_limited`);
    const rawToken = await createSignupToken(email, sql);
    await logger.info('oauth_signup_started', { provider, email });
    return redirect(`${o}/onboarding#token=${encodeURIComponent(rawToken)}`);
  }

  // Facebook has no verified-email flag (see identity.js). Matching its address
  // to an existing account is therefore opt-in per deployment: without it, an
  // address someone merely typed into Facebook would open that account here.
  if (untrustedFacebook) return failed('facebook_email_not_trusted');

  const artists = await getArtistsForUser(firstUser.id, sql);
  const userToken = generateUserToken(firstUser.id, firstUser.role, TTL_8H, firstUser.password_hash, email);
  const hint = Buffer.from(email.toLowerCase()).toString('base64url');
  await logger.info('oauth_login', { provider, email });
  // This is a finished session, not a link to be redeemed. It used to travel
  // as `magic=`, which sent home.js to the password-based magic endpoint —
  // and that looks the user up WITH password_hash IS NOT NULL and checks the
  // token against that hash. An account created through Google has no
  // password and a user token is keyed on APP_SECRET, so it always came back
  // "Invalid or expired login link". The session is verified as what it is.
  const next = artists.length > 1 ? '/workspaces' : `/${artists[0]?.slug || ''}/dashboard`;
  cookie = { 'Set-Cookie': [CLEAR_NONCE, sessionCookie(userToken)] };
  return redirect(`${o}/login#oauth=1&hint=${hint}&next=${encodeURIComponent(next)}`);
}

// POST action=oauth-session — hands the login page the session the callback
// left in its cookie, once. SameSite=Strict keeps the cookie off requests other
// sites start, and only a script on this origin can read the answer.
async function oauthSession({ headers }) {
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(headers?.cookie || '');
  const out = m ? ok({ token: m[1] }) : fail(401, 'No sign-in to finish');
  return { ...out, headers: { 'Set-Cookie': CLEAR_SESSION } };
}

module.exports = { googleUrl, facebookUrl, oauthCallback, oauthSession };
