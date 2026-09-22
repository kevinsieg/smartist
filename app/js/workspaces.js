(async function() {
  var AUTH_TOKEN_KEY = 'smartist_token';

  // This page loads no common.js (it runs before a workspace is chosen, so
  // there is no band to build a nav from), which means getToken/clearToken are
  // not defined here — calling them threw and the page rendered nothing at all.
  // Same guarded-local-copy rule as share-utils.js and arrangement.js on stage.
  function _storedAuthToken() {
    try {
      return sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || null;
    } catch { return null; }
  }

  function _clearAuthToken() {
    try {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
      sessionStorage.removeItem('setlist_token');
    } catch {}
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _roleLabel(role) {
    if (role === 'admin')  return t('workspaces.roleAdmin');
    if (role === 'member') return t('workspaces.roleMember');
    return t('workspaces.roleViewer');
  }

  function _renderList(artists) {
    var el = document.getElementById('workspaces-content');
    if (!artists || artists.length === 0) {
      el.innerHTML =
        '<div class="landing-login">' +
          '<p class="auth-hint" style="margin-bottom:0.75rem">' + t('workspaces.noWorkspacesHint') + '</p>' +
          '<a href="/onboarding" class="btn active auth-submit">' + t('workspaces.createFirst') + '</a>' +
        '</div>';
      return;
    }

    var cards = artists.map(function(a) {
      return '<a class="workspace-card" href="/' + _esc(a.slug) + '/dashboard">' +
        '<span class="workspace-name">' + _esc(a.name) + '</span>' +
        '<span class="workspace-role">' + _esc(_roleLabel(a.role)) + '</span>' +
      '</a>';
    }).join('');

    el.innerHTML =
      '<div class="workspace-list">' + cards + '</div>' +
      '<a href="/onboarding" class="btn auth-submit" style="margin-top:0.5rem">' + t('workspaces.newWorkspace') + '</a>';
  }

  function _renderUnauth() {
    var el = document.getElementById('workspaces-content');
    el.innerHTML =
      '<div class="landing-login">' +
        '<p class="auth-hint" style="margin-bottom:0.75rem">' + t('workspaces.unauthHint') + '</p>' +
        '<a href="/login" class="btn active auth-submit">' + t('workspaces.loginBtn') + '</a>' +
      '</div>';
  }

  // Init
  var authTok = _storedAuthToken();
  if (!authTok) { _renderUnauth(); return; }

  var logoutEl = document.getElementById('ws-logout');
  if (logoutEl) {
    logoutEl.style.display = '';
    logoutEl.addEventListener('click', function(e) {
      e.preventDefault();
      _clearAuthToken();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      window.location.replace('/login');
    });
  }

  let d;
  try {
    const r = await fetch('/api/config?action=my-artists', {
      headers: { Authorization: 'Bearer ' + authTok },
    });
    if (r.status === 401) {
      // Do NOT clear the stored token here: a 401 can mean "this token type
      // can't list workspaces" (legacy bootstrap session), not "logged out".
      // Stray navigation must never destroy a valid session; truly expired
      // tokens get cleaned up by the login page itself.
      _renderUnauth();
      return;
    }
    d = await r.json();
  } catch {
    document.getElementById('workspaces-content').innerHTML =
      '<p class="auth-error">' + t('workspaces.loadError') + '</p>';
    return;
  }
  var artists = d.artists || [];
  var skipRedirect = sessionStorage.getItem('ws_skip_autoredirect');
  sessionStorage.removeItem('ws_skip_autoredirect');
  if (artists.length === 1 && !skipRedirect) {
    window.location.replace('/' + artists[0].slug + '/dashboard');
    return;
  }
  _renderList(artists);
})();
