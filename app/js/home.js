var artistSlug = '';
var _loginNext = '';

// Where to go after signing in: a path on this site, nothing else. A plain
// "starts with / but not //" check let `/\evil.example` through — browsers
// read the backslash as a slash and leave the site. The parsed path is
// checked too: `/.//evil.example` resolves to the path `//evil.example`, which
// the browser then reads as another host.
function _safeNext(next) {
  if (!next) return '';
  try {
    var u = new URL(next, window.location.origin);
    if (u.origin !== window.location.origin || /^\/[/\\]/.test(u.pathname)) return '';
    return u.pathname + u.search + u.hash;
  } catch (e) { return ''; }
}

async function init() {
  // Ensure the i18n dictionary is loaded before rendering via t().
  if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }
  // Auth params arrive in the URL fragment (never sent to servers or logged);
  // query params still work for older emailed links.
  const params       = new URLSearchParams(window.location.search);
  const hashParams   = new URLSearchParams(window.location.hash.slice(1));
  const qp           = function(k) { return hashParams.get(k) || params.get(k); };
  const magic        = qp('magic');
  const oauthDone    = qp('oauth');
  const hint         = qp('hint');
  const invite       = qp('invite');
  const reset        = qp('reset');
  const oauthError   = qp('oauth_error');
  const path         = window.location.pathname.replace(/\/+$/, '') || '/';
  const next         = _safeNext(qp('next'));
  const slugFromNext = next.split('/').filter(Boolean)[0] || '';
  _loginNext = next; // survives the URL strip below

  const hasToken = !!(sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY));
  if (path === '/' && !magic && !oauthDone && !oauthError && !invite && !reset && !hasToken) {
    window.location.replace('/login' + window.location.search);
    return;
  }

  if (magic || oauthDone || oauthError || invite || reset) history.replaceState(null, '', window.location.pathname);

  // A finished session the OAuth callback left in an HttpOnly cookie, redeemed
  // once. Handled before
  // loadConfig because it needs no workspace: verifySession authenticates
  // against the slug-independent my-artists endpoint. Doing it later would
  // break the multi-workspace case, where `next` is /workspaces and there is no
  // slug to load a config for.
  if (oauthDone) {
    const session = await _redeemOAuthSession();
    if (session) storeToken(session, false);
    if (hint) {
      try { sessionStorage.setItem('smartist_admin_email', atob(hint.replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) {}
    }
    const { ok, artists } = session ? await verifySession(session) : { ok: false, artists: [] };
    if (ok) { renderLoggedIn(null, artists); return; }
    // Say so here rather than falling through: `next` may be /workspaces, which
    // is not a slug, so the code below would fail to load a config and render a
    // bare login form with no hint that the sign-in was refused. The root config
    // is only for the form's own buttons — without it the error screen would
    // offer no way back in through the provider that just failed.
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    let rootCfg;
    try { rootCfg = await loadConfig(undefined, { light: true }); } catch (e) {}
    renderLogin(t('home.invalidLink'), rootCfg);
    return;
  }

  let cfg;
  try {
    cfg = await loadConfig(slugFromNext || undefined, { light: true });
    artistSlug = cfg.slug || slugFromNext;
    if (!artistSlug) {
      // Multi-tenant root: nothing to brand the page with. Signup is a link on
      // the form, so returning users are not pushed into onboarding.
      //
      // A reset link is the one arrival that must survive this: it carries no
      // slug, so returning here would drop the token and show a plain login
      // form — which is how the OAuth confirm link was broken earlier.
      if (reset) { renderSetPassword(reset, cfg, hint); return; }
      // Same for a failed OAuth sign-in: without this the error vanished and
      // the page looked as if nothing had happened.
      renderLogin(oauthError ? t('home.oauthErrorMsg') : null, cfg);
      return;
    }
    applyNav(cfg.name, cfg.config);
    document.title = 'smartist' + (cfg.name ? ' · ' + cfg.name : '');
  } catch {
    renderLogin();
    return;
  }

  if (oauthError) { renderLogin(t('home.oauthErrorMsg'), cfg); return; }
  if (invite)     { renderSetPassword(invite, cfg); return; }
  // Arrived from "Forgot password?". Landing here rather than on the dashboard
  // is the whole point: being logged in with the password you forgot still in
  // place is what made the old flow a dead end.
  if (reset)      { renderSetPassword(reset, cfg, hint); return; }

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

// The session token the OAuth callback set as a cookie, or null.
async function _redeemOAuthSession() {
  try {
    const r = await fetch('/api/auth/oauth-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) return null;
    return (await r.json()).token || null;
  } catch { return null; }
}

// A sign-in link names its account in `hint`; one without it cannot be redeemed.
async function verifyToken(token, hint) {
  if (!hint) return { ok: false, artists: [] };
  try {
    const r = await fetch('/api/auth/magic-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magic: token, hint }),
    });
    if (!r.ok) return { ok: false, artists: [] };
    const data = await r.json();
    if (!data.token) return { ok: false, artists: [] };
    storeToken(data.token, false);
    sessionStorage.setItem('smartist_admin_email', data.email || '');
    return { ok: true, artists: data.artists || [] };
  } catch { return { ok: false, artists: [] }; }
}

// Validate a stored session token on page load. The Bearer-authenticated
// my-artists endpoint returns the user's workspaces. Posting it to the
// password-login endpoint (as the magic flow does) would reject a valid JWT and
// silently log the user out — defeating "Remember me".
async function verifySession(token) {
  try {
    const r = await fetch('/api/auth/artists', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return { ok: false, artists: [] };
    const data = await r.json();
    return { ok: true, artists: data.artists || [] };
  } catch { return { ok: false, artists: [] }; }
}

// ── Logged-in state ───────────────────────────────────────────────────────────

function renderLoggedIn(cfg, artists) {
  const next = _loginNext || _safeNext(new URLSearchParams(window.location.search).get('next'));
  if (next) {
    window.location.href = next;
    return;
  }
  if (!artists || artists.length === 0) {
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

// A new session starts without any band's cached config.
function storeToken(token, remember) {
  Object.keys(sessionStorage)
    .filter(function(k) { return k.indexOf('artist_config_cache_') === 0; })
    .forEach(function(k) { sessionStorage.removeItem(k); });
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

  // An error passed in here is an arrival error — the sign-in that brought the
  // visitor to this page failed. It gets a banner above everything, because the
  // thin line under the password field is missed by someone whose eye is at the
  // top of a page they did not expect to be on. The inline .auth-error below
  // stays empty for the form's own messages, written as the visitor types.
  const bannerHtml = errorMsg
    ? '<div class="auth-banner" role="alert">' + errorMsg + '</div>'
    : '';

  el.innerHTML =
    '<div class="landing-login">' +
      bannerHtml +
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
      '<div class="auth-error" id="auth-error" role="alert"></div>' +
      '<button class="btn active auth-submit" id="pw-btn">' + t('home.signIn') + '</button>' +
      '<button class="reset-link" id="reset-toggle">' + t('home.forgotPassword') + '</button>' +
      '<div class="reset-form" id="reset-form" style="display:none">' +
        '<div class="auth-field">' +
          '<label class="auth-label" for="reset-email">' + t('home.emailAddressLabel') + '</label>' +
          '<input type="email" id="reset-email" placeholder="' + t('home.emailPlaceholder') + '" autocomplete="email">' +
        '</div>' +
        '<div class="auth-error" id="reset-msg" role="status"></div>' +
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

// Two arrivals share this screen: accepting an invite, and setting a password
// after forgetting one. Same form, different endpoint — `resetHint` is what
// tells them apart, because only the reset link carries the address it was
// issued for.
function renderSetPassword(token, cfg, resetHint) {
  const isReset = !!resetHint;
  const submit  = () => (isReset ? doSetPassword(token, resetHint, cfg) : doAcceptInvite(token, cfg));
  const label   = isReset ? t('home.savePassword') : t('home.createAccount');
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
      '<div class="auth-error" id="auth-error" role="alert"></div>' +
      '<button class="btn active auth-submit" id="accept-btn">' + label + '</button>' +
    '</div>';
  document.getElementById('pw-toggle-new').addEventListener('click', () => {
    const input = document.getElementById('pw-new');
    const btn   = document.getElementById('pw-toggle-new');
    const show  = input.type === 'password';
    input.type      = show ? 'text' : 'password';
    btn.textContent = show ? t('home.hidePw') : t('home.showPw');
  });
  document.getElementById('accept-btn').addEventListener('click', submit);
  document.getElementById('pw-new').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  setTimeout(() => document.getElementById('pw-new')?.focus(), 50);
}

// Setting the password is also what logs them in — they are here because they
// could not log in, so handing them back to the form would be absurd.
async function doSetPassword(token, hint, cfg) {
  const pw  = document.getElementById('pw-new').value;
  const btn = document.getElementById('accept-btn');
  const err = document.getElementById('auth-error');
  if (!pw) { err.textContent = t('home.enterPassword'); return; }
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  const restore = () => { btn.disabled = false; btn.textContent = t('home.savePassword'); };
  try {
    const r    = await fetch('/api/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, hint, password: pw }),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error || t('home.invalidLink'); restore(); return; }
    storeToken(data.token, false);
    sessionStorage.setItem('smartist_admin_email', data.email || '');
    renderLoggedIn(cfg, data.artists || []);
  } catch {
    err.textContent = t('home.connError');
    restore();
  }
}

async function doAcceptInvite(inviteToken, cfg) {
  const pw  = document.getElementById('pw-new').value;
  const btn = document.getElementById('accept-btn');
  const err = document.getElementById('auth-error');
  if (!pw) { err.textContent = t('home.enterPassword'); return; }
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const slug = cfg?.slug || artistSlug;
    const r    = await fetch(`/api/${slug}/members/accept-invite`, {
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
  const err = document.getElementById('auth-error');
  // Every login is a named user: the shared band password is retired.
  if (!email) { err.textContent = t('home.emailRequired'); document.getElementById('email-input')?.focus(); return; }
  if (!pw) return;
  const btn = document.getElementById('pw-btn');
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const cfg = await loadConfig(undefined, { light: true });
    if (cfg.slug) artistSlug = cfg.slug;
    const body = { email, password: pw, rememberMe: remember };
    // Email is the identity: /api/login finds the account across workspaces,
    // with or without a band in the URL.
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error || t('home.signInFailed'); btn.disabled = false; btn.textContent = t('home.signIn'); document.getElementById('pw-input')?.focus(); return; }
    storeToken(data.token, remember);
    sessionStorage.setItem('smartist_admin_email', data.email || '');
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
    const r    = await fetch(`/api/auth/${provider}-url`);
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
    // The account is found by address, whichever band this page shows.
    await fetch('/api/auth/request-reset', {
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
