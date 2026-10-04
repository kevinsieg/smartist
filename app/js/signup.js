(async function() {
  var _googleUrl   = null;
  var _facebookUrl = null;

  async function _loadOAuthUrls() {
    try {
      // Ask what this deployment offers before requesting URLs for it. Probing
      // blind costs two 503s in the console on every load of a deployment
      // without OAuth credentials, which buries real errors.
      const cRes = await fetch('/api/config');
      const cfg  = cRes.ok ? await cRes.json() : {};
      const want = [];
      if (cfg.googleLogin)   want.push(['google',   'google-url']);
      if (cfg.facebookLogin) want.push(['facebook', 'facebook-url']);
      if (!want.length) return;
      const results = await Promise.all(
        want.map(([, action]) => fetch('/api/config?action=' + action + '&mode=signup'))
      );
      for (let i = 0; i < want.length; i++) {
        if (!results[i].ok) continue;
        const d = await results[i].json();
        if (want[i][0] === 'google') _googleUrl = d.url; else _facebookUrl = d.url;
      }
    } catch {}
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _oauthHtml() {
    if (!_googleUrl && !_facebookUrl) return '';
    var html = '<div class="oauth-btns">';
    if (_googleUrl)   html += '<a class="btn oauth-btn" href="' + _esc(_googleUrl)   + '">' + _esc(t('signup.oauthGoogle'))   + '</a>';
    if (_facebookUrl) html += '<a class="btn oauth-btn" href="' + _esc(_facebookUrl) + '">' + _esc(t('signup.oauthFacebook')) + '</a>';
    return html + '</div>';
  }

  function _fillOAuthSlot() {
    var slot = document.getElementById('signup-oauth');
    if (slot) slot.innerHTML = _oauthHtml();
  }

  function _render(state) {
    var el = document.getElementById('signup-content');
    if (!el) return;

    if (state === 'sent') {
      el.innerHTML =
        '<div class="landing-login">' +
          '<p class="auth-hint" style="margin-bottom:0.5rem">' + _esc(t('signup.sentMsg')) + '</p>' +
          '<p class="auth-hint"><a href="/signup">' + _esc(t('signup.sentDifferent')) + '</a></p>' +
        '</div>';
      return;
    }

    var errorMsg = (typeof state === 'object' && state.type === 'error')
      ? _esc(state.msg || t('signup.errFallback')) : '';

    el.innerHTML =
      '<div class="landing-login">' +
        '<div id="signup-oauth">' + _oauthHtml() + '</div>' +
        '<div class="auth-field">' +
          '<label class="auth-label" for="signup-email">' + _esc(t('signup.emailLabel')) + '</label>' +
          '<input id="signup-email" type="email" autocomplete="email" placeholder="' + _esc(t('signup.emailPlaceholder')) + '">' +
        '</div>' +
        // Honeypot — visually hidden, bots fill it, server then skips the email
        '<input id="signup-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">' +
        '<div class="auth-error" id="signup-error" role="alert">' + errorMsg + '</div>' +
        '<button type="button" class="btn active auth-submit" id="signup-btn">' + _esc(t('signup.sendBtn')) + '</button>' +
        '<p class="auth-hint">' + _esc(t('signup.alreadyHave')) + ' <a href="/login">' + _esc(t('signup.loginLink')) + '</a></p>' +
      '</div>';

    document.getElementById('signup-btn').addEventListener('click', async function() {
      var email = document.getElementById('signup-email').value.trim();
      if (!email) return;
      var btn = document.getElementById('signup-btn');
      btn.disabled    = true;
      btn.textContent = t('signup.sending');
      try {
        await sendSignupLink(email, document.getElementById('signup-hp').value);
        _render('sent');
      } catch (err) {
        btn.disabled    = false;
        btn.textContent = t('signup.sendBtn');
        _render({ type: 'error', msg: err.message });
      }
    });

    document.getElementById('signup-email').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') document.getElementById('signup-btn').click();
    });
  }

  // The dictionary must be in hand before the first render: t() falls back to
  // the key, and nothing re-translates a string once it is inside generated
  // HTML. On a repeat visit this resolves synchronously from localStorage.
  if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }

  // Render the form immediately — the OAuth URLs come from two serverless
  // calls (slow on cold start) and slot in once they arrive.
  // Sent back here by the OAuth callback: a Facebook address it could not trust,
  // or too many sign-up attempts for one address.
  var arrival = new URLSearchParams(window.location.search).get('error');
  var ARRIVAL_MSG = { verify_email: 'signup.errVerifyEmail', rate_limited: 'signup.errRateLimited' };
  _render(ARRIVAL_MSG[arrival] ? { type: 'error', msg: t(ARRIVAL_MSG[arrival]) } : 'form');
  _loadOAuthUrls().then(_fillOAuthSlot);
})();
