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
    document.querySelectorAll('.home-logo').forEach(img => {
      if (cfg.config?.logoUrl) { img.src = cfg.config.logoUrl; img.alt = cfg.name || ''; }
    });
    document.querySelector('.home-tagline') &&
      (document.title = (cfg.name || 'Band Tools'));
  } catch {
    renderAuthSection(false);
    return;
  }

  if (magic) {
    const ok = await verifyToken(magic);
    if (ok) {
      sessionStorage.setItem('setlist_token', magic);
      renderAuthSection(true);
      return;
    }
    // fall through to show login form with error
    renderAuthSection(false, 'Invalid or expired login link.');
    return;
  }

  const token = sessionStorage.getItem('setlist_token');
  if (token) {
    const ok = await verifyToken(token);
    renderAuthSection(ok);
    if (!ok) sessionStorage.removeItem('setlist_token');
  } else {
    renderAuthSection(false);
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

function renderAuthSection(loggedIn, errorMsg) {
  const el = document.getElementById('home-auth');
  if (!el) return;

  if (loggedIn) {
    el.innerHTML =
      '<div class="home-logged-in">' +
        '<strong>&#10004; logged in</strong> &mdash; ' +
        '<button class="reset-link" onclick="doLogout()">logout</button>' +
      '</div>';
    return;
  }

  el.innerHTML =
    '<div class="auth-gate">' +
      '<p>Enter the band password to manage songs and setlists.</p>' +
      '<div class="auth-row">' +
        '<div class="pw-wrapper">' +
          '<input type="password" id="pw-input" placeholder="Password" autocomplete="current-password">' +
          '<button type="button" class="pw-toggle" id="pw-toggle">show</button>' +
        '</div>' +
        '<button class="btn" id="pw-btn">Login</button>' +
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

  setTimeout(() => document.getElementById('pw-input')?.focus(), 50);
}

async function doLogin() {
  const pw  = document.getElementById('pw-input').value.trim();
  if (!pw) return;
  const btn = document.getElementById('pw-btn');
  const err = document.getElementById('auth-error');
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const r = await fetch(`/api/${bandSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (!r.ok) throw new Error();
    sessionStorage.setItem('setlist_token', pw);
    updateAuthIndicator();
    renderAuthSection(true);
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
