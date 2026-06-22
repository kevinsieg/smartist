(async function() {
  var _googleUrl   = null;
  var _facebookUrl = null;

  async function _loadOAuthUrls() {
    try {
      const [gRes, fbRes] = await Promise.all([
        fetch('/api/config?action=google-url&mode=signup'),
        fetch('/api/config?action=facebook-url&mode=signup'),
      ]);
      if (gRes.ok)  { const d = await gRes.json();  _googleUrl   = d.url; }
      if (fbRes.ok) { const d = await fbRes.json(); _facebookUrl = d.url; }
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
        '<div class="auth-error" id="signup-error">' + errorMsg + '</div>' +
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

  // Render the form immediately — the OAuth URLs come from two serverless
  // calls (slow on cold start) and slot in once they arrive.
  _render('form');
  _loadOAuthUrls().then(_fillOAuthSlot);
})();
