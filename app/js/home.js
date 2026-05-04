let bandSlug = '';

async function init() {
  const params = new URLSearchParams(window.location.search);
  const magic  = params.get('magic');
  if (magic) history.replaceState(null, '', window.location.pathname);

  let cfg;
  try {
    cfg = await loadConfig();
    bandSlug = cfg.slug;
    applyNav(cfg.name, cfg.config);
    document.title = cfg.name || 'Band Tools';
  } catch {
    renderLogin();
    return;
  }

  if (magic) {
    const ok = await verifyToken(magic);
    if (ok) { sessionStorage.setItem('setlist_token', magic); renderLoggedIn(cfg); }
    else     { renderLogin('Invalid or expired login link.'); }
    return;
  }

  const token = sessionStorage.getItem('setlist_token');
  if (token && await verifyToken(token)) {
    renderLoggedIn(cfg);
  } else {
    sessionStorage.removeItem('setlist_token');
    renderLogin();
  }
}

async function verifyToken(token) {
  try {
    const r = await fetch(`/api/${bandSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: token }),
    });
    return r.ok;
  } catch { return false; }
}

// ── Logged-in state ───────────────────────────────────────────────────────────

function renderLoggedIn(cfg) {
  updateAuthIndicator();
  const el = document.getElementById('landing-auth');
  if (!el) return;
  el.innerHTML =
    '<nav class="landing-nav">' +
      '<a href="/setlist"         class="landing-nav-link">Setlist generator</a>' +
      '<a href="/setlist-history" class="landing-nav-link">Setlist history</a>' +
      '<a href="/songs"           class="landing-nav-link">Song catalogue</a>' +
      '<a href="/gema-import"     class="landing-nav-link">PRO</a>' +
    '</nav>' +
    '<button class="reset-link landing-logout" onclick="handleLogout()">logout</button>';
}

function handleLogout() {
  doLogout();
  renderLogin();
}

// ── Login form ────────────────────────────────────────────────────────────────

function renderLogin(errorMsg) {
  const el = document.getElementById('landing-auth');
  if (!el) return;

  el.innerHTML =
    '<div class="landing-login">' +
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
          '<input type="email" id="reset-email" placeholder="Band email address" autocomplete="email">' +
          '<button class="btn" id="reset-btn">Send link</button>' +
        '</div>' +
        '<div class="auth-error" id="reset-msg"></div>' +
      '</div>' +
    '</div>';

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

async function doLogin() {
  const pw  = document.getElementById('pw-input').value.trim();
  if (!pw) return;
  const btn = document.getElementById('pw-btn');
  const err = document.getElementById('auth-error');
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const cfg = await loadConfig();
    bandSlug = cfg.slug;
    const r = await fetch(`/api/${bandSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (!r.ok) throw new Error();
    sessionStorage.setItem('setlist_token', pw);
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
    if (!bandSlug) { const cfg = await loadConfig(); bandSlug = cfg.slug; }
    await fetch(`/api/${bandSlug}/request-reset`, {
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
