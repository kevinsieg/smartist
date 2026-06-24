var artistSlug = '';
var _loginNext = '';

async function init() {
  // Ensure the i18n dictionary is loaded before rendering via t().
  if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }
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

  if (oauthError) { renderLogin(t('home.oauthErrorMsg'), cfg); return; }
  if (invite)     { renderSetPassword(invite, cfg); return; }

  if (magic) {
    const { ok, artists } = await verifyToken(magic, hint || null);
    if (ok) renderLoggedIn(cfg, artists);
    else    renderLogin(t('home.invalidLink'), cfg);
    return;
  }

  const token = sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    const { ok, artists } = await verifySession(token);
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

// Validate a stored session token on page load. The token may be a named-user
// JWT or a legacy bootstrap password; the Bearer-authenticated my-artists
// endpoint accepts both and returns the user's workspaces. Posting it to the
// password-login endpoint (as the magic flow does) would reject a valid JWT and
// silently log the user out — defeating "Remember me".
async function verifySession(token) {
  try {
    const r = await fetch('/api/config?action=my-artists', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return { ok: false, artists: [] };
    const data = await r.json();
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
  window.location.href = '/workspaces';
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
      (showGoogle   ? '<button class="btn oauth-btn" id="google-btn">' + t('home.continueWithGoogle') + '</button>'   : '') +
      (showFacebook ? '<button class="btn oauth-btn" id="facebook-btn">' + t('home.continueWithFacebook') + '</button>' : '') +
    '</div>' +
    '<div class="auth-divider"><span>' + t('home.orDivider') + '</span></div>';

  el.innerHTML =
    '<div class="landing-login">' +
      oauthHtml +
      '<div class="auth-field">' +
        '<label class="auth-label" for="email-input">' + t('home.emailLabel') + '</label>' +
        '<input type="email" id="email-input" placeholder="' + t('home.emailPlaceholder') + '" autocomplete="email">' +
      '</div>' +
      '<div class="auth-field">' +
        '<label class="auth-label" for="pw-input">' + t('home.passwordLabel') + '</label>' +
        '<div class="pw-wrapper">' +
          '<input type="password" id="pw-input" placeholder="••••••••" autocomplete="current-password">' +
          '<button type="button" class="pw-toggle" id="pw-toggle">' + t('home.showPw') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="auth-remember">' +
        '<label class="auth-remember-label"><input type="checkbox" id="remember-me"> ' + t('home.rememberMe') + '</label>' +
      '</div>' +
      '<div class="auth-error" id="auth-error">' + (errorMsg || '') + '</div>' +
      '<button class="btn active auth-submit" id="pw-btn">' + t('home.signIn') + '</button>' +
      '<button class="reset-link" id="reset-toggle">' + t('home.forgotPassword') + '</button>' +
      '<div class="reset-form" id="reset-form" style="display:none">' +
        '<div class="auth-field">' +
          '<label class="auth-label" for="reset-email">' + t('home.emailAddressLabel') + '</label>' +
          '<input type="email" id="reset-email" placeholder="' + t('home.emailPlaceholder') + '" autocomplete="email">' +
        '</div>' +
        '<div class="auth-error" id="reset-msg"></div>' +
        '<button class="btn auth-submit" id="reset-btn">' + t('home.sendLink') + '</button>' +
      '</div>' +
      '<p class="auth-hint">' + t('home.noAccount') + ' <a href="/signup">' + t('home.signUpFree') + '</a></p>' +
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
    btn.textContent = show ? t('home.hidePw') : t('home.showPw');
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
        '<label class="auth-label" for="pw-new">' + t('home.choosePassword') + '</label>' +
        '<div class="pw-wrapper">' +
          '<input type="password" id="pw-new" placeholder="' + t('home.pwPlaceholder') + '" autocomplete="new-password">' +
          '<button type="button" class="pw-toggle" id="pw-toggle-new">' + t('home.showPw') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="auth-error" id="auth-error"></div>' +
      '<button class="btn active auth-submit" id="accept-btn">' + t('home.createAccount') + '</button>' +
    '</div>';
  document.getElementById('pw-toggle-new').addEventListener('click', () => {
    const input = document.getElementById('pw-new');
    const btn   = document.getElementById('pw-toggle-new');
    const show  = input.type === 'password';
    input.type      = show ? 'text' : 'password';
    btn.textContent = show ? t('home.hidePw') : t('home.showPw');
  });
  document.getElementById('accept-btn').addEventListener('click', () => doAcceptInvite(inviteToken, cfg));
  document.getElementById('pw-new').addEventListener('keydown', e => { if (e.key === 'Enter') doAcceptInvite(inviteToken, cfg); });
  setTimeout(() => document.getElementById('pw-new')?.focus(), 50);
}

async function doAcceptInvite(inviteToken, cfg) {
  const pw  = document.getElementById('pw-new').value;
  const btn = document.getElementById('accept-btn');
  const err = document.getElementById('auth-error');
  if (!pw) { err.textContent = t('home.enterPassword'); return; }
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const slug = cfg?.slug || artistSlug;
    const r    = await fetch(`/api/${slug}/auth?action=accept-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken, password: pw }),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error || t('home.failedCreateAccount'); btn.disabled = false; btn.textContent = t('home.createAccount'); return; }
    storeToken(data.token, false);
    sessionStorage.setItem('smartist_admin_email', data.email || '');
    renderLoggedIn(cfg, data.artists || []);
  } catch {
    err.textContent = t('home.connError');
    btn.disabled = false; btn.textContent = t('home.createAccount');
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
    if (!r.ok) { err.textContent = data.error || t('home.signInFailed'); btn.disabled = false; btn.textContent = t('home.signIn'); return; }
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
    err.textContent = t('home.connError');
    btn.disabled = false; btn.textContent = t('home.signIn');
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
      if (err) err.textContent = data.error || t('home.oauthNotConfigured', { provider: provider });
      if (btn) { btn.disabled = false; btn.textContent = t('home.continueWith', { provider: provider[0].toUpperCase() + provider.slice(1) }); }
    }
  } catch {
    const err = document.getElementById('auth-error');
    if (err) err.textContent = t('home.connError');
    if (btn) { btn.disabled = false; btn.textContent = t('home.continueWith', { provider: provider[0].toUpperCase() + provider.slice(1) }); }
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
    msg.textContent = t('home.resetSent');
  } catch {
    msg.style.color = '';
    msg.textContent = t('home.resetFailed');
  } finally {
    btn.disabled = false; btn.textContent = t('home.sendLink');
  }
}

init();
