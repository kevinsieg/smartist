(async function() {
  var AUTH_TOKEN_KEY = 'smartist_token';

  function _storedAuthToken() {
    return sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || null;
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _roleLabel(role) {
    if (role === 'admin')  return 'Admin';
    if (role === 'member') return 'Member';
    return 'Viewer';
  }

  function _renderList(artists) {
    var el = document.getElementById('workspaces-content');
    if (!artists || artists.length === 0) {
      el.innerHTML =
        '<div class="landing-login">' +
          '<p class="auth-hint" style="margin-bottom:0.75rem">You don\'t have any workspaces yet.</p>' +
          '<a href="/onboarding" class="btn active auth-submit">Create your first workspace</a>' +
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
      '<a href="/onboarding" class="btn auth-submit" style="margin-top:0.5rem">+ New workspace</a>';
  }

  function _renderUnauth() {
    var el = document.getElementById('workspaces-content');
    el.innerHTML =
      '<div class="landing-login">' +
        '<p class="auth-hint" style="margin-bottom:0.75rem">You need to be logged in to see your workspaces.</p>' +
        '<a href="/login" class="btn active auth-submit">Log in</a>' +
      '</div>';
  }

  // Init
  var authTok = _storedAuthToken();
  if (!authTok) { _renderUnauth(); return; }

  let d;
  try {
    const r = await fetch('/api/config?action=my-artists', {
      headers: { Authorization: 'Bearer ' + authTok },
    });
    if (r.status === 401) {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
      _renderUnauth();
      return;
    }
    d = await r.json();
  } catch {
    document.getElementById('workspaces-content').innerHTML =
      '<p class="auth-error">Could not load workspaces. Please try again.</p>';
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
