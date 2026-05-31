var artistSlug = '';

async function init() {
  const params     = new URLSearchParams(window.location.search);
  const magic      = params.get('magic');
  const oauthError = params.get('oauth_error');
  const path       = window.location.pathname.replace(/\/+$/, '') || '/';

  // Unauthenticated visits to / (not magic/oauth) → dedicated login URL
  if (path === '/' && !magic && !oauthError && !sessionStorage.getItem(AUTH_TOKEN_KEY)) {
    window.location.replace('/login' + window.location.search);
    return;
  }

  if (magic || oauthError) history.replaceState(null, '', window.location.pathname);

  let cfg;
  try {
    cfg = await loadConfig();
    artistSlug = cfg.slug;
    applyNav(cfg.name, cfg.config);
    document.title = cfg.name || 'Band Tools';
  } catch {
    renderLogin();
    return;
  }

  if (oauthError) {
    renderLogin('Sign-in failed — the account email does not match the configured admin address.', cfg);
    return;
  }

  if (magic) {
    const ok = await verifyToken(magic);
    if (ok) { sessionStorage.setItem(AUTH_TOKEN_KEY, magic); renderLoggedIn(cfg); }
    else     { renderLogin('Invalid or expired login link.', cfg); }
    return;
  }

  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (token && await verifyToken(token)) {
    renderLoggedIn(cfg);
  } else {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    renderLogin(null, cfg);
  }
}

async function verifyToken(token) {
  try {
    const r = await fetch(`/api/${artistSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: token }),
    });
    if (!r.ok) return false;
    const data = await r.json();
    if (data.adminEmail) sessionStorage.setItem('smartist_admin_email', data.adminEmail);
    return true;
  } catch { return false; }
}

// ── Logged-in state ───────────────────────────────────────────────────────────

function renderLoggedIn(cfg) {
  const next = new URLSearchParams(window.location.search).get('next');
  const dest = (next && next.startsWith('/') && !next.startsWith('//')) ? next : '/dashboard';
  window.location.href = dest;
}

// ── Login form ────────────────────────────────────────────────────────────────

function renderLogin(errorMsg, cfg) {
  const el = document.getElementById('landing-auth');
  if (!el) return;

  const showGoogle   = !!cfg?.googleLogin;
  const showFacebook = !!cfg?.facebookLogin;
  const showOAuth    = showGoogle || showFacebook;

  const oauthHtml = !showOAuth ? '' :
    '<div class="oauth-btns">' +
      (showGoogle   ? '<button class="btn oauth-btn" id="google-btn">Continue with Google</button>'   : '') +
      (showFacebook ? '<button class="btn oauth-btn" id="facebook-btn">Continue with Facebook</button>' : '') +
    '</div>' +
    '<div class="auth-divider"><span>or</span></div>';

  el.innerHTML =
    '<div class="landing-login">' +
      oauthHtml +
      '<div class="auth-row">' +
        '<div class="pw-wrapper">' +
          '<input type="password" id="pw-input" placeholder="Password" autocomplete="current-password">' +
          '<button type="button" class="pw-toggle" id="pw-toggle">show</button>' +
        '</div>' +
        '<button class="btn active" id="pw-btn">Login</button>' +
      '</div>' +
      '<div class="auth-error" id="auth-error">' + (errorMsg || '') + '</div>' +
      '<button class="reset-link" id="reset-toggle">Forgot password?</button>' +
      '<div class="reset-form" id="reset-form" style="display:none">' +
        '<div class="auth-row">' +
          '<input type="email" id="reset-email" placeholder="Email address" autocomplete="email">' +
          '<button class="btn" id="reset-btn">Send link</button>' +
        '</div>' +
        '<div class="auth-error" id="reset-msg"></div>' +
      '</div>' +
      '<div class="auth-view-hint">No password? <a href="/songs">Browse in view mode →</a></div>' +
    '</div>';

  if (showGoogle)   document.getElementById('google-btn').addEventListener('click',   () => startOAuth('google'));
  if (showFacebook) document.getElementById('facebook-btn').addEventListener('click', () => startOAuth('facebook'));

  document.getElementById('pw-btn').addEventListener('click', doLogin);
  document.getElementById('pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('pw-toggle').addEventListener('click', () => {
    const input = document.getElementById('pw-input');
    const btn   = document.getElementById('pw-toggle');
    const show  = input.type === 'password';
    input.type      = show ? 'text'     : 'password';
    btn.textContent = show ? 'hide'     : 'show';
  });
  document.getElementById('reset-toggle').addEventListener('click', () => {
    const form = document.getElementById('reset-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
    if (form.style.display !== 'none') document.getElementById('reset-email').focus();
  });
  document.getElementById('reset-btn').addEventListener('click', doRequestReset);
  document.getElementById('reset-email').addEventListener('keydown', e => { if (e.key === 'Enter') doRequestReset(); });

  setTimeout(() => document.getElementById('pw-input')?.focus(), 50);
}

async function startOAuth(provider) {
  const btn = document.getElementById(`${provider}-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r    = await fetch(`/api/config?action=${provider}-url`);
    const data = await r.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      const err = document.getElementById('auth-error');
      if (err) err.textContent = data.error || `${provider} login is not configured`;
      if (btn) { btn.disabled = false; btn.textContent = `Continue with ${provider[0].toUpperCase() + provider.slice(1)}`; }
    }
  } catch {
    const err = document.getElementById('auth-error');
    if (err) err.textContent = 'Connection error. Try again.';
    if (btn) { btn.disabled = false; btn.textContent = `Continue with ${provider[0].toUpperCase() + provider.slice(1)}`; }
  }
}

async function doLogin() {
  const pw  = document.getElementById('pw-input').value.trim();
  if (!pw) return;
  const btn = document.getElementById('pw-btn');
  const err = document.getElementById('auth-error');
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const cfg = await loadConfig();
    artistSlug = cfg.slug;
    const r = await fetch(`/api/${artistSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (!r.ok) throw new Error();
    sessionStorage.setItem(AUTH_TOKEN_KEY, pw);
    applyNav(cfg.name, cfg.config);
    renderLoggedIn(cfg);
  } catch {
    err.textContent = 'Wrong password.';
    btn.disabled = false; btn.textContent = 'Login';
  }
}

async function doRequestReset() {
  const email = document.getElementById('reset-email').value.trim();
  if (!email) return;
  const btn = document.getElementById('reset-btn');
  const msg = document.getElementById('reset-msg');
  btn.disabled = true; btn.textContent = '…'; msg.textContent = '';
  try {
    if (!artistSlug) { const cfg = await loadConfig(); artistSlug = cfg.slug; }
    await fetch(`/api/${artistSlug}/request-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    msg.style.color = 'var(--secondary-color)';
    msg.textContent = 'If that email is correct, a login link has been sent.';
  } catch {
    msg.style.color = '';
    msg.textContent = 'Failed to send. Try again.';
  } finally {
    btn.disabled = false; btn.textContent = 'Send link';
  }
}

init();
