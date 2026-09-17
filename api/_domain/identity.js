const crypto = require('crypto');

function _stateSecret(provider) {
  if (provider === 'google')   return process.env.GOOGLE_CLIENT_SECRET   || '';
  if (provider === 'facebook') return process.env.FACEBOOK_APP_SECRET    || '';
  return '';
}

function generateState(provider, mode) {
  const resolvedMode = mode || 'login';
  const nonce   = crypto.randomBytes(10).toString('hex');
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
    return valid ? { provider, mode } : null;
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
    const tokenRes = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?${params}`);
    const { access_token, error } = await tokenRes.json();
    if (error || !access_token) throw new Error(`Facebook token error: ${error?.message}`);
    const userRes = await fetch(`https://graph.facebook.com/me?fields=email&access_token=${encodeURIComponent(access_token)}`);
    const { email } = await userRes.json();
    return email || null;
  }

  return null;
}

module.exports = { generateState, verifyState, resolveOAuthEmail };
