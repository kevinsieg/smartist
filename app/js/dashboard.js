var artistSlug = '';

initPage(async function(cfg) {
  artistSlug = cfg.slug;
  document.title = cfg.name || 'Dashboard';
  renderDashboard(cfg);
});

function _nextAction(cfg) {
  var c      = cfg.counts  || {};
  var songs  = c.songs     || 0;
  var sets   = c.setlists  || 0;
  var gigs   = c.gigs      || 0;
  var venues = c.venues    || 0;
  if (songs  === 0) return { href: '/songs',  label: 'Add your first songs',     hint: 'Songs are the foundation — everything else builds from them.' };
  if (sets   === 0) return { href: '/setlist', label: 'Build your first setlist', hint: 'You have ' + songs + ' song' + (songs !== 1 ? 's' : '') + '. Group them into a setlist.' };
  if (gigs   === 0) return { href: '/gigs',   label: 'Log a gig',                hint: 'Track where and when you\'ve performed.' };
  if (venues === 0) return { href: '/venues', label: 'Add your venues',           hint: 'Link gigs to venues to build your performance map.' };
  return               { href: '/setlist', label: '+ Create setlist',             hint: null };
}

function renderDashboard(cfg) {
  var el = document.getElementById('dash-content');
  if (!el) return;

  var b = '/' + artistSlug;
  var next = _nextAction(cfg);
  var actionRow =
    '<a href="' + b + next.href + '" class="dash-cta">' + next.label + '</a>' +
    (next.hint ? '<p class="dash-next-hint">' + next.hint + '</p>' : '');

  el.innerHTML =
    actionRow +
    '<div class="dash-grid">' +
      '<a href="' + b + '/setlist" class="dash-card">' +
        '<span class="dash-card-label">Setlists</span>' +
        '<span class="dash-card-count" id="dc-setlists">—</span>' +
      '</a>' +
      '<a href="' + b + '/songs" class="dash-card">' +
        '<span class="dash-card-label">Songs</span>' +
        '<span class="dash-card-count" id="dc-songs">—</span>' +
      '</a>' +
      '<a href="' + b + '/gigs" class="dash-card">' +
        '<span class="dash-card-label">Gigs</span>' +
        '<span class="dash-card-count" id="dc-gigs">—</span>' +
      '</a>' +
      '<a href="' + b + '/venues" class="dash-card">' +
        '<span class="dash-card-label">Venues</span>' +
        '<span class="dash-card-count" id="dc-venues">—</span>' +
      '</a>' +
      '<a href="' + b + '/organizers" class="dash-card">' +
        '<span class="dash-card-label">Organizers</span>' +
        '<span class="dash-card-count" id="dc-organizers">—</span>' +
      '</a>' +
      '<a href="' + b + '/pro-import" class="dash-card">' +
        '<span class="dash-card-label">PRO</span>' +
        '<span class="dash-card-count--muted">GEMA · Suisa · …</span>' +
      '</a>' +
      '<a href="' + b + '/hub" class="dash-card">' +
        '<span class="dash-card-label">Hub</span>' +
        '<span class="dash-card-count--muted">streaming · socials</span>' +
      '</a>' +
      '<a href="' + b + '/profile" class="dash-card">' +
        '<span class="dash-card-label">Profile</span>' +
        '<span class="dash-card-count--muted">settings · photo</span>' +
      '</a>' +
    '</div>' +
    '<button class="reset-link landing-logout" onclick="handleLogout()">logout</button>';

  var set = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
  var c = cfg.counts || {};
  set('dc-songs',      c.songs      !== undefined ? c.songs      : '—');
  set('dc-setlists',   c.setlists   !== undefined ? c.setlists   : '—');
  set('dc-gigs',       c.gigs       !== undefined ? c.gigs       : '—');
  set('dc-venues',     c.venues     !== undefined ? c.venues     : '—');
  set('dc-organizers', c.organizers !== undefined ? c.organizers : '—');
}

function handleLogout() {
  doLogout();
  goToLogin();
}
