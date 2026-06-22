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
  if (songs  === 0) return null; // covered by the "Add a song" task button
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
  var actionRow = next
    ? '<a href="' + b + next.href + '" class="dash-cta">' + next.label + '</a>' +
      (next.hint ? '<p class="dash-next-hint">' + next.hint + '</p>' : '')
    : '';

  var hasSongs = ((cfg.counts || {}).songs || 0) > 0;
  var taskRow =
    '<div class="dash-tasks">' +
      (hasSongs
        ? '<a href="' + b + '/songs" class="dash-task-btn">&#128269; Find a song</a>'
        : '<span class="dash-task-btn dash-task-btn--disabled" aria-disabled="true" title="Add songs first">&#128269; Find a song</span>') +
      '<a href="' + b + '/songs?new=1" class="dash-task-btn auth-action">&#65291; Add a song</a>' +
      (hasSongs
        ? '<a href="' + b + '/setlist" class="dash-task-btn auth-action">&#9776; Build a setlist</a>'
        : '<span class="dash-task-btn dash-task-btn--disabled auth-action" aria-disabled="true" title="Add songs first">&#9776; Build a setlist</span>') +
    '</div>';

  // Open by default while the workspace is empty — first thing new users see.
  var helpDismissed = false;
  try { helpDismissed = localStorage.getItem('smartist_help_dismissed') === '1'; } catch (_) {}
  var helpHtml = helpDismissed ? '' :
    '<details class="dash-help"' + (hasSongs ? '' : ' open') + '>' +
      '<button type="button" class="dash-help-close" id="dash-help-close" aria-label="Dismiss and don\'t show again">&times;</button>' +
      '<summary>New here? How smartist works</summary>' +
      '<ol>' +
        '<li><strong>Add your songs</strong> — keys, capos, lyrics and recordings live in <a href="' + b + '/songs">Songs</a>. Start with just a title; details can come later.</li>' +
        '<li><strong>Build a setlist</strong> — pick songs for your next show in <a href="' + b + '/setlist">Setlists</a>, then print it or share it with the band.</li>' +
        '<li><strong>Plan your gigs</strong> — dates and places go in <a href="' + b + '/gigs">Gigs</a>; you can link a setlist to each gig.</li>' +
        '<li><strong>On stage &amp; practice</strong> — every setlist and song has a full-screen stage view with lyrics and recordings, made for the phone on your mic stand. Share its link with band mates, new members or fans so they can work on the songs.</li>' +
      '</ol>' +
      '<p>Venues, organizers, your streaming links and PRO reporting live under <em>More</em> in the menu.</p>' +
    '</details>';

  el.innerHTML =
    helpHtml +
    taskRow +
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
    '</div>';

  var closeBtn = document.getElementById('dash-help-close');
  if (closeBtn) closeBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    try { localStorage.setItem('smartist_help_dismissed', '1'); } catch (_) {}
    var help = document.querySelector('.dash-help');
    if (help) help.remove();
  });

  var set = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
  var c = cfg.counts || {};
  set('dc-songs',      c.songs      !== undefined ? c.songs      : '—');
  set('dc-setlists',   c.setlists   !== undefined ? c.setlists   : '—');
  set('dc-gigs',       c.gigs       !== undefined ? c.gigs       : '—');
  set('dc-venues',     c.venues     !== undefined ? c.venues     : '—');
  set('dc-organizers', c.organizers !== undefined ? c.organizers : '—');
}
