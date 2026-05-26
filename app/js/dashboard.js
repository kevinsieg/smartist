var artistSlug = '';

initPage(async function(cfg, viewMode) {
  artistSlug = cfg.slug;
  document.title = cfg.name || 'Dashboard';
  renderDashboard(cfg, viewMode);
});

function renderDashboard(cfg, viewMode) {
  var el = document.getElementById('dash-content');
  if (!el) return;

  var actionRow = viewMode
    ? '<p class="dash-vm-cta"><a class="go-login" href="' + loginPageUrl() + '">Login</a> for full access.</p>'
    : '<a href="/setlist" class="dash-cta">+ Create setlist</a>';

  el.innerHTML =
    actionRow +
    '<div class="dash-grid">' +
      '<a href="/setlist" class="dash-card">' +
        '<span class="dash-card-label">Setlists</span>' +
        '<span class="dash-card-count" id="dc-setlists">—</span>' +
      '</a>' +
      '<a href="/songs" class="dash-card">' +
        '<span class="dash-card-label">Songs</span>' +
        '<span class="dash-card-count" id="dc-songs">—</span>' +
      '</a>' +
      '<a href="/gigs" class="dash-card">' +
        '<span class="dash-card-label">Gigs</span>' +
        '<span class="dash-card-count" id="dc-gigs">—</span>' +
      '</a>' +
      '<a href="/venues" class="dash-card">' +
        '<span class="dash-card-label">Venues</span>' +
        '<span class="dash-card-count" id="dc-venues">—</span>' +
      '</a>' +
      '<a href="/organizers" class="dash-card">' +
        '<span class="dash-card-label">Organizers</span>' +
        '<span class="dash-card-count" id="dc-organizers">—</span>' +
      '</a>' +
      '<a href="/gema-import" class="dash-card">' +
        '<span class="dash-card-label">PRO</span>' +
        '<span class="dash-card-count--muted">GEMA · Suisa · …</span>' +
      '</a>' +
      '<a href="/hub" class="dash-card">' +
        '<span class="dash-card-label">Hub</span>' +
        '<span class="dash-card-count--muted">streaming · socials</span>' +
      '</a>' +
      '<a href="/profile" class="dash-card">' +
        '<span class="dash-card-label">Profile</span>' +
        '<span class="dash-card-count--muted">settings · photo</span>' +
      '</a>' +
    '</div>' +
    (viewMode ? '' : '<button class="reset-link landing-logout" onclick="handleLogout()">logout</button>');

  var set = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
  var c = cfg.counts || {};
  set('dc-songs',      (cfg.songs || []).length);
  set('dc-setlists',   c.setlists   !== undefined ? c.setlists   : '—');
  set('dc-gigs',       c.gigs       !== undefined ? c.gigs       : '—');
  set('dc-venues',     c.venues     !== undefined ? c.venues     : '—');
  set('dc-organizers', c.organizers !== undefined ? c.organizers : '—');
}

function handleLogout() {
  doLogout();
  goToLogin();
}
