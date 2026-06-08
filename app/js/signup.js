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

  function _render(state) {
    var el = document.getElementById('signup-content');
    if (!el) return;

    if (state === 'sent') {
      el.innerHTML =
        '<p class="landing-lead">Check your email for a sign-up link.</p>' +
        '<p><a href="/signup">Use a different email</a></p>';
      return;
    }

    var oauthHtml = '';
    if (_googleUrl)   oauthHtml += '<a class="btn btn--oauth" href="' + _esc(_googleUrl)   + '">Continue with Google</a>';
    if (_facebookUrl) oauthHtml += '<a class="btn btn--oauth" href="' + _esc(_facebookUrl) + '">Continue with Facebook</a>';
    if (oauthHtml)    oauthHtml  = '<div class="oauth-btns">' + oauthHtml + '</div><div class="or-divider">or</div>';

    var errorHtml = (typeof state === 'object' && state.type === 'error')
      ? '<p class="form-error" id="signup-error">' + _esc(state.msg || 'Something went wrong') + '</p>'
      : '';

    el.innerHTML =
      oauthHtml +
      '<form id="signup-form">' +
        '<label for="signup-email">Email</label>' +
        '<input id="signup-email" type="email" autocomplete="email" placeholder="you@example.com" required>' +
        '<button type="submit" class="btn btn--primary">Send sign-up link</button>' +
        errorHtml +
      '</form>' +
      '<p class="form-hint">Already have an account? <a href="/login">Log in</a></p>';

    document.getElementById('signup-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var email = document.getElementById('signup-email').value.trim();
      var btn   = e.target.querySelector('button[type="submit"]');
      btn.disabled    = true;
      btn.textContent = 'Sending…';
      try {
        await sendSignupLink(email);
        _render('sent');
      } catch (err) {
        btn.disabled    = false;
        btn.textContent = 'Send sign-up link';
        _render({ type: 'error', msg: err.message });
      }
    });
  }

  await _loadOAuthUrls();
  _render('form');
})();
