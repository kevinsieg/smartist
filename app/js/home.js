var artistSlug = '';
var _loginNext = '';

async function init() {
  // Auth params arrive in the URL fragment (never sent to servers or logged);
  // query params still work for older emailed links.
  const params       = new URLSearchParams(window.location.search);
  const hashParams   = new URLSearchParams(window.location.hash.slice(1));
  const qp           = function(k) { return hashParams.get(k) || params.get(k); };
  const magic        = qp('magic');
  const hint         = qp('hint');
  const invite       = qp('invite');
  const oauthError   = qp('oauth_error');
  const path         = window.location.pathname.replace(/\/+$/, '') || '/';
  const next         = qp('next') || '';
  const slugFromNext = next.split('/').filter(Boolean)[0] || '';
  _loginNext = next; // survives the URL strip below

  const hasToken = !!(sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY));
  if (path === '/' && !magic && !oauthError && !invite && !hasToken) {
    window.location.replace('/login' + window.location.search);
    return;
  }

  if (magic || oauthError || invite) history.replaceState(null, '', window.location.pathname);

  let cfg;
  try {
    cfg = await loadConfig(slugFromNext || undefined);
    artistSlug = cfg.slug || slugFromNext;
    if (!artistSlug) {
      window.location.replace('/signup');
      return;
    }
    applyNav(cfg.name, cfg.config);
    document.title = cfg.name || 'smartist';
  } catch {
    renderLogin();
    return;
  }

  if (oauthError) { renderLogin('Sign-in failed — the account email does not match the configured admin address.', cfg); return; }
  if (invite)     { renderSetPassword(invite, cfg); return; }

  if (magic) {
    const { ok, artists } = await verifyToken(magic, hint || null);
    if (ok) renderLoggedIn(cfg, artists);
    else    renderLogin('Invalid or expired login link.', cfg);
    return;
  }

  const token = sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    const { ok, artists } = await verifyToken(token);
    if (ok) { renderLoggedIn(cfg, artists); return; }
  }
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  renderLogin(null, cfg);
}

async function verifyToken(token, hint) {
  try {
    const body = hint
      ? { magic: token, hint }
      : { password: token };
    const r = await fetch(`/api/${artistSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, artists: [] };
    const data = await r.json();
    if (data.token) {
      storeToken(data.token, false);
      sessionStorage.setItem('smartist_admin_email', data.email || '');
    } else if (data.adminEmail) {
      sessionStorage.setItem('smartist_admin_email', data.adminEmail);
    }
    return { ok: true, artists: data.artists || [] };
  } catch { return { ok: false, artists: [] }; }
}

// ── Logged-in state ───────────────────────────────────────────────────────────

function renderLoggedIn(cfg, artists) {
  const next = _loginNext || new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) {
    window.location.href = next;
    return;
  }
  if (!artists || artists.length === 0) {
    // Single-tenant installs (ARTIST_SLUG set) use legacy bootstrap auth with
    // no users rows — the workspace is fixed by the deployment, never onboarding.
    if (cfg?.singleTenant && cfg.slug) {
      window.location.href = '/' + cfg.slug + '/dashboard';
      return;
    }
    window.location.href = '/onboarding';
    return;
  }
  if (artists.length === 1) {
    window.location.href = '/' + artists[0].slug + '/dashboard';
    return;
  }
  window.location.href = '/home';
}

// ── Login form ────────────────────────────────────────────────────────────────

function storeToken(token, remember) {
  if (remember) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
  } else {
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}

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
      '<div class="auth-field">' +
        '<label class="auth-label" for="email-input">Email</label>' +
        '<input type="email" id="email-input" placeholder="you@band.com" autocomplete="email">' +
      '</div>' +
      '<div class="auth-field">' +
        '<label class="auth-label" for="pw-input">Password</label>' +
        '<div class="pw-wrapper">' +
          '<input type="password" id="pw-input" placeholder="••••••••" autocomplete="current-password">' +
          '<button type="button" class="pw-toggle" id="pw-toggle">show</button>' +
        '</div>' +
      '</div>' +
      '<div class="auth-remember">' +
        '<label class="auth-remember-label"><input type="checkbox" id="remember-me"> Remember me</label>' +
      '</div>' +
      '<div class="auth-error" id="auth-error">' + (errorMsg || '') + '</div>' +
      '<button class="btn active auth-submit" id="pw-btn">Sign in</button>' +
      '<button class="reset-link" id="reset-toggle">Forgot password?</button>' +
      '<div class="reset-form" id="reset-form" style="display:none">' +
        '<div class="auth-field">' +
          '<label class="auth-label" for="reset-email">Email address</label>' +
          '<input type="email" id="reset-email" placeholder="you@band.com" autocomplete="email">' +
        '</div>' +
        '<div class="auth-error" id="reset-msg"></div>' +
        '<button class="btn auth-submit" id="reset-btn">Send link</button>' +
      '</div>' +
      '<p class="auth-hint">No account? <a href="/signup">Sign up free →</a></p>' +
    '</div>';

  if (showGoogle)   document.getElementById('google-btn').addEventListener('click', () => startOAuth('google'));
  if (showFacebook) document.getElementById('facebook-btn').addEventListener('click', () => startOAuth('facebook'));
  document.getElementById('pw-btn').addEventListener('click', doLogin);
  document.getElementById('email-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('pw-input').focus(); });
  document.getElementById('pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('pw-toggle').addEventListener('click', () => {
    const input = document.getElementById('pw-input');
    const btn   = document.getElementById('pw-toggle');
    const show  = input.type === 'password';
    input.type      = show ? 'text' : 'password';
    btn.textContent = show ? 'hide' : 'show';
  });
  document.getElementById('reset-toggle').addEventListener('click', () => {
    const form = document.getElementById('reset-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
    if (form.style.display !== 'none') document.getElementById('reset-email').focus();
  });
  document.getElementById('reset-btn').addEventListener('click', doRequestReset);
  document.getElementById('reset-email').addEventListener('keydown', e => { if (e.key === 'Enter') doRequestReset(); });
  setTimeout(() => document.getElementById('email-input')?.focus(), 50);
}

function renderSetPassword(inviteToken, cfg) {
  const el = document.getElementById('landing-auth');
  if (!el) return;
  el.innerHTML =
    '<div class="landing-login">' +
      '<div class="auth-field">' +
        '<label class="auth-label" for="pw-new">Choose a password</label>' +
        '<div class="pw-wrapper">' +
          '<input type="password" id="pw-new" placeholder="8 or more characters" autocomplete="new-password">' +
          '<button type="button" class="pw-toggle" id="pw-toggle-new">show</button>' +
        '</div>' +
      '</div>' +
      '<div class="auth-error" id="auth-error"></div>' +
      '<button class="btn active auth-submit" id="accept-btn">Create account</button>' +
    '</div>';
  document.getElementById('pw-toggle-new').addEventListener('click', () => {
    const input = document.getElementById('pw-new');
    const btn   = document.getElementById('pw-toggle-new');
    const show  = input.type === 'password';
    input.type      = show ? 'text' : 'password';
    btn.textContent = show ? 'hide' : 'show';
  });
  document.getElementById('accept-btn').addEventListener('click', () => doAcceptInvite(inviteToken, cfg));
  document.getElementById('pw-new').addEventListener('keydown', e => { if (e.key === 'Enter') doAcceptInvite(inviteToken, cfg); });
  setTimeout(() => document.getElementById('pw-new')?.focus(), 50);
}

async function doAcceptInvite(inviteToken, cfg) {
  const pw  = document.getElementById('pw-new').value;
  const btn = document.getElementById('accept-btn');
  const err = document.getElementById('auth-error');
  if (!pw) { err.textContent = 'Enter a password.'; return; }
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const slug = cfg?.slug || artistSlug;
    const r    = await fetch(`/api/${slug}/auth?action=accept-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken, password: pw }),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error || 'Failed to create account.'; btn.disabled = false; btn.textContent = 'Create account'; return; }
    storeToken(data.token, false);
    sessionStorage.setItem('smartist_admin_email', data.email || '');
    renderLoggedIn(cfg, data.artists || []);
  } catch {
    err.textContent = 'Connection error. Try again.';
    btn.disabled = false; btn.textContent = 'Create account';
  }
}

async function doLogin() {
  const email   = document.getElementById('email-input')?.value.trim() || '';
  const pw      = document.getElementById('pw-input').value.trim();
  const remember = document.getElementById('remember-me')?.checked || false;
  if (!pw) return;
  const btn = document.getElementById('pw-btn');
  const err = document.getElementById('auth-error');
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const cfg = await loadConfig();
    artistSlug = cfg.slug;
    const body = email
      ? { email, password: pw, rememberMe: remember }
      : { password: pw };
    const r = await fetch(`/api/${artistSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error || 'Sign in failed.'; btn.disabled = false; btn.textContent = 'Sign in'; return; }
    if (data.token) {
      storeToken(data.token, remember);
      sessionStorage.setItem('smartist_admin_email', data.email || '');
    } else {
      // Legacy bootstrap: server returns adminEmail (no token), store pw as bearer
      sessionStorage.setItem(AUTH_TOKEN_KEY, pw);
      if (data.adminEmail) sessionStorage.setItem('smartist_admin_email', data.adminEmail);
    }
    applyNav(cfg.name, cfg.config);
    renderLoggedIn(cfg, data.artists || []);
  } catch {
    err.textContent = 'Connection error. Try again.';
    btn.disabled = false; btn.textContent = 'Sign in';
  }
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
