(async function() {
  var _token    = null;  // signup token
  var _authTok  = null;  // session auth token (add-artist mode)
  var _email    = null;
  var _slugTimer = null;

  var AUTH_TOKEN_KEY = 'smartist_token';

  function _storedAuthToken() {
    return sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || null;
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _toSlug(s) {
    return s.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  function _showError(msg) {
    var el = document.getElementById('onboarding-error');
    if (el) el.textContent = msg || '';
  }

  async function _checkSlug(slug) {
    if (!slug || !/^[a-z0-9][a-z0-9-]{2,49}$/.test(slug)) return false;
    return checkSlug(slug);
  }

  function _renderExpired() {
    document.getElementById('onboarding-title').textContent = 'Link expired';
    document.getElementById('onboarding-content').innerHTML =
      '<div class="landing-login">' +
        '<p class="auth-hint" style="margin-bottom:0.75rem">This sign-up link has expired or already been used.</p>' +
        '<a href="/signup" class="btn active auth-submit">Request a new link</a>' +
      '</div>';
  }

  function _renderForm(email) {
    var el = document.getElementById('onboarding-content');
    el.innerHTML =
      '<div class="landing-login">' +
        (email ? '<p class="auth-hint" style="margin-bottom:0.75rem">Setting up workspace for <strong>' + _esc(email) + '</strong></p>' : '') +
        '<div class="auth-field">' +
          '<label class="auth-label" for="ob-name">Band / project name</label>' +
          '<input id="ob-name" type="text" autocomplete="organization" placeholder="My Band" maxlength="200">' +
        '</div>' +
        '<div class="auth-field">' +
          '<label class="auth-label" for="ob-slug">Workspace URL</label>' +
          '<div class="slug-wrap">' +
            '<span class="slug-prefix">smartist.studio/</span>' +
            '<input id="ob-slug" type="text" placeholder="my-band" maxlength="50">' +
          '</div>' +
          '<p class="slug-status" id="slug-status"></p>' +
        '</div>' +
        '<div class="auth-error" id="onboarding-error"></div>' +
        '<button type="button" id="ob-submit" class="btn active auth-submit" disabled>Create workspace</button>' +
      '</div>';

    var nameInput = document.getElementById('ob-name');
    var slugInput = document.getElementById('ob-slug');
    var slugStatus = document.getElementById('slug-status');
    var submitBtn = document.getElementById('ob-submit');

    async function _doSlugCheck() {
      var slug = slugInput.value.trim();
      if (!slug) { slugStatus.textContent = ''; submitBtn.disabled = true; return; }
      if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(slug)) {
        slugStatus.textContent = 'Use 3–50 lowercase letters, numbers, or hyphens';
        submitBtn.disabled = true;
        return;
      }
      slugStatus.textContent = 'Checking…';
      try {
        const avail = await _checkSlug(slug);
        if (avail) {
          slugStatus.textContent = '✓ Available';
          submitBtn.disabled = false;
        } else {
          slugStatus.textContent = 'Already taken — try another';
          submitBtn.disabled = true;
        }
      } catch {
        slugStatus.textContent = '';
        submitBtn.disabled = false;
      }
    }

    nameInput.addEventListener('input', function() {
      if (!slugInput._touched) slugInput.value = _toSlug(nameInput.value);
      clearTimeout(_slugTimer);
      _slugTimer = setTimeout(_doSlugCheck, 400);
    });

    slugInput.addEventListener('input', function() {
      slugInput._touched = true;
      clearTimeout(_slugTimer);
      _slugTimer = setTimeout(_doSlugCheck, 400);
    });

    submitBtn.addEventListener('click', async function() {
      var name = nameInput.value.trim();
      var slug = slugInput.value.trim();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';
      _showError('');
      try {
        const r = await fetch('/api/config', {
          method: 'POST',
          headers: Object.assign(
            { 'Content-Type': 'application/json' },
            _authTok ? { Authorization: 'Bearer ' + _authTok } : {}
          ),
          body: JSON.stringify({ action: 'signup', token: _token, name, slug }),
        });
        const d = await r.json();
        if (!r.ok) {
          if (r.status === 409) {
            slugStatus.textContent = 'Already taken — try another';
            submitBtn.disabled = true;
          } else {
            _showError(d.error || 'Sign-up failed');
            submitBtn.disabled = false;
          }
          submitBtn.textContent = 'Create workspace';
          return;
        }
        sessionStorage.setItem(AUTH_TOKEN_KEY, d.token);
        window.location.href = '/' + slug + '/dashboard';
      } catch (err) {
        _showError(err.message || 'Something went wrong');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create workspace';
      }
    });
  }

  // Init
  var params = new URLSearchParams(window.location.search);
  _token = params.get('token') || null;

  if (_token) {
    // Sign-up mode: verify the token
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-signup-token', token: _token }),
      });
      if (!r.ok) { _renderExpired(); return; }
      const d = await r.json();
      _email = d.email || null;
      _renderForm(_email);
    } catch { _renderExpired(); }
  } else {
    // Add-artist mode: check for existing session
    _authTok = _storedAuthToken();
    if (!_authTok) { window.location.replace('/signup'); return; }
    // Verify the session token is still valid
    const r = await fetch('/api/config?action=my-artists', {
      headers: { Authorization: 'Bearer ' + _authTok },
    });
    if (r.status === 401) { window.location.replace('/signup'); return; }
    _renderForm(null);
  }
})();
