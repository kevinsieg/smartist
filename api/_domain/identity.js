const crypto = require('crypto');
const { FB_GRAPH_VERSION } = require('../_constants');

// Meta requires server-to-server Graph calls to be signed with the app secret:
// a sha256 HMAC of `<access token>|<unix seconds>`, sent alongside the timestamp
// it was built from. Proofs expire after five minutes, so this is generated per
// call rather than cached.
function _appsecretProof(accessToken) {
  const time  = Math.floor(Date.now() / 1000);
  const proof = crypto
    .createHmac('sha256', process.env.FACEBOOK_APP_SECRET || '')
    .update(`${accessToken}|${time}`)
    .digest('hex');
  return { appsecret_proof: proof, appsecret_time: String(time) };
}

function _stateSecret(provider) {
  if (provider === 'google')   return process.env.GOOGLE_CLIENT_SECRET   || '';
  if (provider === 'facebook') return process.env.FACEBOOK_APP_SECRET    || '';
  return '';
}

// nonce: the value the OAuth start also sets as the `oauth_nonce` cookie, so
// the callback can check the state came back to the browser that asked for it
// (without that, a callback URL for the attacker's own account can be handed
// to someone else and signs them into it — login CSRF).
function generateState(provider, mode, nonce = crypto.randomBytes(16).toString('hex')) {
  const resolvedMode = mode || 'login';
  const expires = Date.now() + 15 * 60 * 1000;
  const msg     = `${provider}:${nonce}:${expires}:${resolvedMode}`;
  const sig     = crypto.createHmac('sha256', _stateSecret(provider)).update(msg).digest('hex');
  return Buffer.from(JSON.stringify({ provider, nonce, expires, mode: resolvedMode, sig })).toString('base64url');
}

function verifyState(state) {
  if (!state) return null;
  try {
    const { provider, nonce, expires, mode, sig } = JSON.parse(Buffer.from(state, 'base64url').toString());
    if (provider !== 'google' && provider !== 'facebook') return null;
    if (Date.now() > Number(expires)) return null;
    const msg      = `${provider}:${nonce}:${expires}:${mode}`;
    const expected = crypto.createHmac('sha256', _stateSecret(provider)).update(msg).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(sig)) return null;
    const valid = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    return valid ? { provider, mode, nonce } : null;
  } catch { return null; }
}

async function resolveOAuthEmail(provider, code, redirectUri) {
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
    // Unverified addresses are rejected: the email is mapped straight to users rows.
    const { email, verified_email } = await userRes.json();
    return verified_email === true && email ? email : null;
  }

  if (provider === 'facebook') {
    const params = new URLSearchParams({
      client_id:     process.env.FACEBOOK_APP_ID,
      client_secret: process.env.FACEBOOK_APP_SECRET,
      redirect_uri:  redirectUri,
      code,
    });
    const tokenRes = await fetch(`https://graph.facebook.com/${FB_GRAPH_VERSION}/oauth/access_token?${params}`);
    const { access_token, error } = await tokenRes.json();
    if (error || !access_token) throw new Error(`Facebook token error: ${error?.message}`);
    // Facebook exposes no equivalent of Google's verified_email. Meta documents
    // matching this address against an existing account as a supported pattern,
    // and withholds the field entirely when it has none to give — so a missing
    // email is the only "don't trust this" signal there is. See
    // docs/oauth-setup.md for what that does and does not guarantee.
    const meParams = new URLSearchParams({
      fields: 'email',
      access_token,
      ..._appsecretProof(access_token),
    });
    const userRes = await fetch(`https://graph.facebook.com/${FB_GRAPH_VERSION}/me?${meParams}`);
    const { email } = await userRes.json();
    return email || null;
  }

  return null;
}

module.exports = { generateState, verifyState, resolveOAuthEmail };
