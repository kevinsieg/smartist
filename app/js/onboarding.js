(async function() {
  // Before anything renders: t() returns the key when the dictionary has not
  // landed, and no later pass repairs a string already inside generated HTML.
  // Resolves synchronously from localStorage on a repeat visit.
  if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }

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
    // apiFetch-exempt: a public availability check during sign-up, no session.
    const r = await fetch('/api/signup/check-slug?slug=' + encodeURIComponent(slug));
    const data = await r.json();
    return data.available === true;
  }

  function _renderExpired() {
    document.getElementById('onboarding-title').textContent = t('onboarding.expiredTitle');
    document.getElementById('onboarding-content').innerHTML =
      '<div class="landing-login">' +
        '<p class="auth-hint" style="margin-bottom:0.75rem">' + t('onboarding.expiredMsg') + '</p>' +
        '<a href="/signup" class="btn active auth-submit">' + t('onboarding.expiredCta') + '</a>' +
      '</div>';
  }

  function _renderForm(email) {
    var el = document.getElementById('onboarding-content');
    el.innerHTML =
      '<div class="landing-login">' +
        (email ? '<p class="auth-hint" style="margin-bottom:0.75rem">' + t('onboarding.settingUpFor', { email: '<strong>' + _esc(email) + '</strong>' }) + '</p>' : '') +
        '<div class="auth-field">' +
          '<label class="auth-label" for="ob-name">' + t('onboarding.nameLabel') + '</label>' +
          '<input id="ob-name" type="text" autocomplete="organization" autocapitalize="words" autocorrect="off" placeholder="' + _esc(t('onboarding.namePlaceholder')) + '" maxlength="200">' +
        '</div>' +
        '<div class="auth-field">' +
          '<label class="auth-label" for="ob-slug">' + t('onboarding.slugLabel') + '</label>' +
          '<div class="slug-wrap">' +
            '<span class="slug-prefix">smartist.studio/</span>' +
            '<input id="ob-slug" type="text" inputmode="url" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="my-band" maxlength="50">' +
          '</div>' +
          '<p class="slug-status" id="slug-status"></p>' +
        '</div>' +
        '<div class="auth-error" id="onboarding-error" role="alert"></div>' +
        '<button type="button" id="ob-submit" class="btn active auth-submit" disabled>' + t('onboarding.createBtn') + '</button>' +
      '</div>';

    var nameInput = document.getElementById('ob-name');
    var slugInput = document.getElementById('ob-slug');
    var slugStatus = document.getElementById('slug-status');
    var submitBtn = document.getElementById('ob-submit');

    async function _doSlugCheck() {
      var slug = slugInput.value.trim();
      if (!slug) { slugStatus.textContent = ''; submitBtn.disabled = true; return; }
      if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(slug)) {
        slugStatus.textContent = t('onboarding.slugFormatHint');
        submitBtn.disabled = true;
        return;
      }
      slugStatus.textContent = t('onboarding.slugChecking');
      try {
        const avail = await _checkSlug(slug);
        if (avail) {
          slugStatus.textContent = t('onboarding.slugAvailable');
          submitBtn.disabled = false;
        } else {
          slugStatus.textContent = t('onboarding.slugTaken');
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
    nameInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); slugInput.focus(); }
    });

    slugInput.addEventListener('input', function() {
      slugInput._touched = true;
      clearTimeout(_slugTimer);
      _slugTimer = setTimeout(_doSlugCheck, 400);
    });
    slugInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !submitBtn.disabled) submitBtn.click();
    });

    submitBtn.addEventListener('click', async function() {
      var name = nameInput.value.trim();
      var slug = slugInput.value.trim();
      submitBtn.disabled = true;
      submitBtn.textContent = t('onboarding.creating');
      _showError('');
      try {
        const r = await fetch('/api/signup', {
          method: 'POST',
          headers: Object.assign(
            { 'Content-Type': 'application/json' },
            _authTok ? { Authorization: 'Bearer ' + _authTok } : {}
          ),
          body: JSON.stringify({ token: _token, name, slug }),
        });
        const d = await r.json();
        if (!r.ok) {
          if (r.status === 409) {
            slugStatus.textContent = t('onboarding.slugTaken');
            submitBtn.disabled = true;
          } else {
            _showError(d.error || t('onboarding.errFallback'));
            submitBtn.disabled = false;
          }
          submitBtn.textContent = t('onboarding.createBtn');
          return;
        }
        sessionStorage.setItem(AUTH_TOKEN_KEY, d.token);
        window.location.href = '/' + slug + '/dashboard';
      } catch (err) {
        _showError(err.message || t('onboarding.errGeneric'));
        submitBtn.disabled = false;
        submitBtn.textContent = t('onboarding.createBtn');
      }
    });
  }

  // Init — token arrives in the fragment (kept out of server logs);
  // query param still accepted for older emailed links.
  var params     = new URLSearchParams(window.location.search);
  var hashParams = new URLSearchParams(window.location.hash.slice(1));
  _token = hashParams.get('token') || params.get('token') || null;
  if (_token) history.replaceState(null, '', window.location.pathname);

  if (_token) {
    // Sign-up mode: verify the token
    try {
      const r = await fetch('/api/signup/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: _token }),
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
    const r = await fetch('/api/auth/artists', {
      headers: { Authorization: 'Bearer ' + _authTok },
    });
    if (r.status === 401) { window.location.replace('/signup'); return; }
    _renderForm(null);
  }
})();
