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
  if (sets   === 0) return { href: '/setlist', label: t('dashboard.ctaBuildFirstSetlist'), hint: t('dashboard.hintSongs' + (songs !== 1 ? '_other' : '_one'), { count: songs }) };
  if (gigs   === 0) return { href: '/gigs',   label: t('dashboard.ctaLogGig'),             hint: t('dashboard.hintGig') };
  if (venues === 0) return { href: '/venues', label: t('dashboard.ctaAddVenues'),           hint: t('dashboard.hintVenues') };
  return               { href: '/setlist', label: t('dashboard.ctaCreateSetlist'),          hint: null };
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
  var addSongsFirst = t('dashboard.addSongsFirst');
  var taskRow =
    '<div class="dash-tasks">' +
      (hasSongs
        ? '<a href="' + b + '/songs" class="dash-task-btn">&#128269; ' + t('dashboard.taskFindSong') + '</a>'
        : '<span class="dash-task-btn dash-task-btn--disabled" aria-disabled="true" title="' + addSongsFirst + '">&#128269; ' + t('dashboard.taskFindSong') + '</span>') +
      '<a href="' + b + '/songs?new=1" class="dash-task-btn auth-action">&#65291; ' + t('dashboard.taskAddSong') + '</a>' +
      (hasSongs
        ? '<a href="' + b + '/setlist" class="dash-task-btn auth-action">&#9776; ' + t('dashboard.taskBuildSetlist') + '</a>'
        : '<span class="dash-task-btn dash-task-btn--disabled auth-action" aria-disabled="true" title="' + addSongsFirst + '">&#9776; ' + t('dashboard.taskBuildSetlist') + '</span>') +
    '</div>';

  // Open by default while the workspace is empty — first thing new users see.
  var helpDismissed = false;
  try { helpDismissed = localStorage.getItem('smartist_help_dismissed') === '1'; } catch (_) {}
  var helpHtml = helpDismissed ? '' :
    '<details class="dash-help"' + (hasSongs ? '' : ' open') + '>' +
      '<button type="button" class="dash-help-close" id="dash-help-close" aria-label="' + t('dashboard.helpDismiss') + '">&times;</button>' +
      '<summary>' + t('dashboard.helpTitle') + '</summary>' +
      '<ol>' +
        '<li>' + t('dashboard.helpLi1', { songsLink: '<a href="' + b + '/songs">' + t('nav.songs') + '</a>' }) + '</li>' +
        '<li>' + t('dashboard.helpLi2', { setlistsLink: '<a href="' + b + '/setlist">' + t('nav.setlists') + '</a>' }) + '</li>' +
        '<li>' + t('dashboard.helpLi3', { gigsLink: '<a href="' + b + '/gigs">' + t('nav.gigs') + '</a>' }) + '</li>' +
        '<li>' + t('dashboard.helpLi4') + '</li>' +
      '</ol>' +
      '<p>' + t('dashboard.helpMore') + '</p>' +
    '</details>';

  el.innerHTML =
    helpHtml +
    taskRow +
    actionRow +
    '<div class="dash-grid">' +
      '<a href="' + b + '/setlist" class="dash-card">' +
        '<span class="dash-card-label">' + t('nav.setlists') + '</span>' +
        '<span class="dash-card-count" id="dc-setlists">—</span>' +
      '</a>' +
      '<a href="' + b + '/songs" class="dash-card">' +
        '<span class="dash-card-label">' + t('nav.songs') + '</span>' +
        '<span class="dash-card-count" id="dc-songs">—</span>' +
      '</a>' +
      '<a href="' + b + '/gigs" class="dash-card">' +
        '<span class="dash-card-label">' + t('nav.gigs') + '</span>' +
        '<span class="dash-card-count" id="dc-gigs">—</span>' +
      '</a>' +
      '<a href="' + b + '/venues" class="dash-card">' +
        '<span class="dash-card-label">' + t('nav.venues') + '</span>' +
        '<span class="dash-card-count" id="dc-venues">—</span>' +
      '</a>' +
      '<a href="' + b + '/organizers" class="dash-card">' +
        '<span class="dash-card-label">' + t('nav.organizers') + '</span>' +
        '<span class="dash-card-count" id="dc-organizers">—</span>' +
      '</a>' +
      '<a href="' + b + '/pro-import" class="dash-card">' +
        '<span class="dash-card-label">' + t('nav.pro') + '</span>' +
        '<span class="dash-card-count--muted">' + t('dashboard.cardProMuted') + '</span>' +
      '</a>' +
      '<a href="' + b + '/hub" class="dash-card">' +
        '<span class="dash-card-label">' + t('nav.hub') + '</span>' +
        '<span class="dash-card-count--muted">' + t('dashboard.cardHubMuted') + '</span>' +
      '</a>' +
      '<a href="' + b + '/profile" class="dash-card">' +
        '<span class="dash-card-label">' + t('nav.profile') + '</span>' +
        '<span class="dash-card-count--muted">' + t('dashboard.cardProfileMuted') + '</span>' +
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
