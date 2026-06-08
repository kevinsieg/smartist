(async function() {
  var AUTH_TOKEN_KEY = 'setlist_token';

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
        '<p class="landing-lead">You don’t have any workspaces yet.</p>' +
        '<a href="/onboarding" class="btn btn--primary">Create your first workspace</a>';
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
      '<div class="workspace-actions">' +
        '<a href="/onboarding" class="btn btn--secondary">Create new workspace</a>' +
      '</div>';
  }

  function _renderUnauth() {
    var el = document.getElementById('workspaces-content');
    el.innerHTML =
      '<p class="landing-lead">You need to be logged in to see your workspaces.</p>' +
      '<a href="/login" class="btn btn--primary">Log in</a>';
  }

  // Init
  var authTok = _storedAuthToken();
  if (!authTok) { _renderUnauth(); return; }

  const r = await fetch('/api/config?action=my-artists', {
    headers: { Authorization: 'Bearer ' + authTok },
  });

  if (r.status === 401) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    _renderUnauth();
    return;
  }

  const d = await r.json();
  _renderList(d.artists || []);
})();
