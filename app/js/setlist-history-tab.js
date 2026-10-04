// Setlists page — the History tab: the saved setlists, their side panel,
// editing a saved set's songs, delete, share, duplicate and export.

function _getSetYear(s) {
  var gig = _histGigMap[s.gig_id];
  return (gig && gig.date)
    ? String(gig.date).slice(0, 4)
    : (s.gig_date ? String(s.gig_date).slice(0, 4) : 'Templates');
}

function _getVisibleSets(state) {
  return _histSets.filter(function(s) {
    var gig = _histGigMap[s.gig_id];
    if (state.setlist    && !(s.title || '').toLowerCase().includes(state.setlist))    return false;
    if (state.gig        && (!gig || !(gig.title || '').toLowerCase().includes(state.gig)))        return false;
    if (state.venue      && (!gig || !(gig.venue_name || '').toLowerCase().includes(state.venue)))      return false;
    if (state.organizer  && (!gig || !(gig.organizer_name || '').toLowerCase().includes(state.organizer))) return false;
    if (state.song !== undefined && state.song !== null && !state.song.has(s.id)) return false;
    return true;
  });
}

async function _resolveHistSongFilter(q) {
  if (!String(q).trim()) return new Set();
  try {
    // One request: the setlists holding a song whose title matches.
    var r = await apiFetch('/api/' + artistSlug + '/setlists?song_q=' + encodeURIComponent(q));
    var rows = r.ok ? await r.json() : [];
    return new Set(rows.map(function(o) { return o.id; }));
  } catch {
    return new Set();
  }
}

function _histDeselect() { if (_histView) _histView.deselect(); }
function _histSelect(sid) { if (_histView) _histView.select(sid); }

function _openHistPanelContent(item, panelEl) {
  var sid = String(item.id);
  var s   = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;
  var gig = _histGigMap[s.gig_id] || null;

  var gigBlock = gig
    ? '<div class="vsp-section-label">' + t('setlist.panelGig') + '</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:flex-start;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' +
          '<strong>' + escHtml(gig.title) + '</strong>' +
          (gig.date ? '<br><span style="color:var(--third-color);font-size:0.8rem">' + escHtml(formatDate(gig.date)) + '</span>' : '') +
        '</div>' +
        (_viewMode ? '' : '<button class="hist-nav-btn" data-onclick="navigate(\'/gigs?open=' + gig.id + '\')" title="' + t('setlist.openInGigs') + '">&#8599;</button>') +
      '</div>'
    : '<div class="vsp-section-label">' + t('setlist.panelGig') + '</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="color:var(--third-color)">' + t('setlist.panelNoGig') + '</div></div>';

  var venueBlock = (gig && gig.venue_id)
    ? '<div class="vsp-section-label">' + t('setlist.panelVenue') + '</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:center;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' +
          escHtml(gig.venue_name || '') +
          (gig.venue_city ? ', ' + escHtml(gig.venue_city) : '') +
        '</div>' +
        (_viewMode ? '' : '<button class="hist-nav-btn" data-onclick="navigate(\'/venues?open=' + gig.venue_id + '\')" title="' + t('setlist.openInVenues') + '">&#8599;</button>') +
      '</div>'
    : '';

  var orgBlock = (gig && gig.organizer_id)
    ? '<div class="vsp-section-label">' + t('setlist.panelOrganizer') + '</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:center;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' + escHtml(gig.organizer_name || '') + '</div>' +
        (_viewMode ? '' : '<button class="hist-nav-btn" data-onclick="navigate(\'/organizers?open=' + gig.organizer_id + '\')" title="' + t('setlist.openInOrganizers') + '">&#8599;</button>') +
      '</div>'
    : '';

  var commentBlock = s.comment
    ? '<div class="vsp-section-label">' + t('setlist.panelComment') + '</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="white-space:pre-wrap">' + escHtml(s.comment) + '</div></div>'
    : '';

  panelEl.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + escHtml(s.title || t('setlist.untitled')) + '</h2></div>' +
      '<button class="vsp-close" data-onclick="_histDeselect()" aria-label="' + t('setlist.closeBtn') + '">&#215;</button>' +
    '</div>' +
    '<div class="vsp-actions" style="margin-bottom:1rem;">' +
      (_viewMode ? '' :
        '<button class="btn icon-btn" data-tooltip="' + t('setlist.editTooltip') + '" data-onclick="_histEdit(' + onArg(sid) + ')">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/>' +
          '</svg>' +
        '</button>') +
      (_viewMode ? '' :
        '<button class="btn icon-btn" data-tooltip="' + t('setlist.duplicateTooltip') + '" data-onclick="_histDuplicate(' + onArg(sid) + ')">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
            '<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>' +
          '</svg>' +
        '</button>') +
      '<button class="btn" data-onclick="_histStage(' + onArg(sid) + ')">' + t('setlist.stageBtn') + '</button>' +
      (_viewMode ? '' :
        '<button class="btn share-btn" data-onclick="_histShareMenu(' + onArg(sid) + ', this)">' +
          SHARE_ICON + '<span style="margin-left:4px">' + t('setlist.shareBtn') + '</span>' +
        '</button>') +
    '</div>' +
    gigBlock + venueBlock + orgBlock + commentBlock +
    '<div id="hist-song-detail"></div>';

  // Expand accordion body to show songs (lazy-loads if not yet fetched)
  var body = document.getElementById('hist-body-' + sid);
  if (body && body.hidden) {
    body.hidden = false;
    var toggle = document.querySelector('[data-id="' + sid + '"] .hist-toggle');
    if (toggle) { toggle.innerHTML = '&#9660;'; toggle.setAttribute('aria-expanded', 'true'); }
    if (!_histLoadedSongs[sid]) body.innerHTML = skeletonHtml(3);
  }
  _loadAndRenderHistSongs(sid);
}

async function _renderHistoryTab() {
  var content = document.getElementById('setlist-content');
  if (!content) return;
  content.innerHTML = skeletonHtml(4);

  if (!_histLoaded) {
    try {
      // Both at once. Every gig of the band (?slim=1 is unpaged): the filters
      // and the edit panel's picker must know the gig of every setlist.
      var both = await Promise.all([
        apiFetch('/api/' + artistSlug + '/setlists'),
        apiFetch('/api/' + artistSlug + '/gigs?slim=1'),
      ]);
      _histSets = await both[0].json();
      if (!Array.isArray(_histSets)) _histSets = [];
      _histGigs = await both[1].json();
      if (!Array.isArray(_histGigs)) _histGigs = [];
      _histGigMap = {};
      _histGigs.forEach(function(g) { _histGigMap[g.id] = g; });
      _histLoaded = true;
    } catch {
      content.innerHTML = '<p style="text-align:center;color:var(--third-color);">' + t('setlist.couldNotLoadHistory') + '</p>';
      return;
    }
  }

  _histView = createListView({
    container:  content,
    filters: [
      { id: 'setlist', label: t('setlist.filterSetlist'), type: FILTER_TYPES.TEXT,       field: 'title' },
      { id: 'gig',     label: t('setlist.filterGig'),     type: FILTER_TYPES.TEXT,       field: 'gig.title' },
      { id: 'venue',   label: t('setlist.filterVenue'),   type: FILTER_TYPES.TEXT,       field: 'gig.venue_name' },
      { id: 'song',    label: t('setlist.filterSong'),    type: FILTER_TYPES.ASYNC_TEXT,
        resolve: _resolveHistSongFilter },
    ],
    getData:   _getVisibleSets,
    getTotal:  function() { return _histSets.length; },
    getItemId: function(s) { return s.id; },
    renderRow: _renderHistRow,
    emptyHtml: '<div style="text-align:center;padding:2.5rem 1rem;color:var(--third-color);">' +
      '<p style="margin-bottom:1rem;">' + t('setlist.noSetlists') + '</p>' +
      '<button class="btn active" data-onclick="switchTab(\'generator\')">' + t('setlist.buildFirst') + '</button>' +
      '</div>',
    groupBy:   _getSetYear,
    groupSort: function(a, b) { return b > a ? 1 : -1; },
    onOpen:    _openHistPanelContent,
    onRowClick: function(id, panels) {
      if (window.innerWidth <= 1024) {
        _toggleHistItemBody(String(id));
      } else {
        panels.openPanel(id);
      }
    },
  });

  var qp = new URLSearchParams(location.search);
  ['setlist', 'gig', 'venue', 'song'].forEach(function(k) {
    if (qp.get(k)) _histView.setFilterValue(k, qp.get(k));
  });

  if (_histPendingOpenId) {
    _histView.select(_histPendingOpenId);
    _histPendingOpenId = null;
  }

  requestAnimationFrame(function() {
    var hdr  = document.querySelector('.app-header');
    var tabs = document.getElementById('setlist-tabs');
    if (hdr && tabs) {
      var offset = hdr.getBoundingClientRect().height + tabs.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--songs-toolbar-top', offset + 'px');
    }
  });
}

function _renderHistRow(s) {
  var gig       = _histGigMap[s.gig_id];
  var gigName   = (gig && gig.title)      || s.gig_name  || '';
  var gigDate   = (gig && gig.date)       || s.gig_date  || '';
  var venueName = (gig && gig.venue_name) || s.gig_venue || '';

  var count = s.song_count != null ? Number(s.song_count) : 0;
  var countBadge = '<span class="hist-badge hist-badge--count">' + count + ' ' + t(count !== 1 ? 'setlist.songs' : 'setlist.song') + '</span>';
  var dateBadge  = gigDate
    ? '<span class="hist-badge hist-badge--date">' + formatDate(gigDate, 'short') + '</span>'
    : '';

  var orgName = (gig && gig.organizer_name) || '';
  var headerLinks = [];
  if (gigName)   headerLinks.push(gig && gig.id
    ? '<span class="hist-meta-link" data-onclick="event.stopPropagation();navigate(\'/gigs?open=' + gig.id + '\')">' + escHtml(gigName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(gigName) + '</span>');
  if (venueName) headerLinks.push(gig && gig.venue_id
    ? '<span class="hist-meta-link" data-onclick="event.stopPropagation();navigate(\'/venues?open=' + gig.venue_id + '\')">' + escHtml(venueName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(venueName) + '</span>');
  if (orgName)   headerLinks.push(gig && gig.organizer_id
    ? '<span class="hist-meta-link" data-onclick="event.stopPropagation();navigate(\'/organizers?open=' + gig.organizer_id + '\')">' + escHtml(orgName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(orgName) + '</span>');

  var sid = String(s.id);
  return '<div class="hist-item" data-id="' + escHtml(sid) + '">' +
    '<div class="hist-item-header">' +
      '<div class="hist-item-main">' +
        '<div class="hist-item-titlerow">' +
          '<span class="hist-item-title">' + escHtml(s.title || t('setlist.untitled')) + '</span>' +
          '<div class="hist-item-badges">' + countBadge + dateBadge + '</div>' +
        '</div>' +
        (s.comment ? '<div class="hist-item-comment">' + escHtml(s.comment) + '</div>' : '') +
        (headerLinks.length ? '<div class="hist-meta-links hist-meta-links--header">' + headerLinks.join('') + '</div>' : '') +
      '</div>' +
      '<button class="hist-toggle" data-onclick="event.stopPropagation();_toggleHistItemBody(' + onArg(sid) + ')" title="' + t('setlist.showSongs') + '" aria-label="' + escHtml(t('setlist.showSongs')) + '" aria-expanded="false" aria-controls="hist-body-' + escHtml(sid) + '">&#9654;</button>' +
      '<button class="hist-details-btn" data-onclick="event.stopPropagation();_histSelect(' + onArg(sid) + ')" title="' + t('setlist.detailsBtn') + '" aria-label="' + t('setlist.detailsBtn') + '">&#8801;</button>' +
    '</div>' +
  '</div>' +
  '<div class="hist-body" id="hist-body-' + escHtml(sid) + '" hidden></div>';
}

function _toggleHistItemBody(sid) {
  sid = String(sid);
  var body   = document.getElementById('hist-body-' + sid);
  var toggle = document.querySelector('[data-id="' + sid + '"] .hist-toggle');
  if (!body) return;
  if (body.hidden) {
    body.hidden = false;
    if (toggle) { toggle.innerHTML = '&#9660;'; toggle.setAttribute('aria-expanded', 'true'); }
    if (!_histLoadedSongs[sid]) body.innerHTML = skeletonHtml(3);
    _loadAndRenderHistSongs(sid);
  } else {
    body.hidden = true;
    if (toggle) { toggle.innerHTML = '&#9654;'; toggle.setAttribute('aria-expanded', 'false'); }
  }
}

async function _loadHistSongs(sid) {
  sid = String(sid);
  if (_histLoadedSongs[sid]) return;
  try {
    var detail = await apiFetch('/api/' + artistSlug + '/setlists/' + sid).then(function(r) { return r.json(); });
    var songs = Array.isArray(detail) ? detail : (detail.songs || []);
    _histLoadedSongs[sid] = songs.slice().sort(function(a, b) { return (a.position || 0) - (b.position || 0); });
  } catch {
    // leave cache unset so the caller can retry on transient failures
  }
}

async function _loadAndRenderHistSongs(sid) {
  sid = String(sid);
  var body = document.getElementById('hist-body-' + sid);
  if (!body) return;

  await _loadHistSongs(sid);

  // If row was removed while loading, accordion body may no longer exist
  body = document.getElementById('hist-body-' + sid);
  if (!body) return;

  var loaded = _histLoadedSongs[sid];
  if (!loaded || !loaded.length) {
    body.innerHTML = '<p style="color:var(--third-color);font-size:0.82rem;padding:0.5rem 0.25rem">' + t('setlist.noSongsInSet') + '</p>';
    return;
  }

  var total = 0;
  var rows = loaded.map(function(song, i) {
    total += song.length_min || 4;
    return '<div class="hist-song-row" data-song-id="' + song.id + '" data-onclick="_openSongPanel(' + onArg(sid) + ',' + Number(song.id) + ')">' +
      '<span class="hist-song-pos">' + (i + 1) + '.</span>' +
      '<button type="button" class="hist-song-name">' + escHtml(song.title || '') + '</button>' +
      (song.key ? '<span class="hist-song-key">' + escHtml(formatKey(song.key)) + '</span>' : '') +
      '<span class="hist-song-len">' + formatLength(song.length_min) + '</span>' +
      (!_viewMode ? '<button class="hist-song-edit-btn" data-onclick="event.stopPropagation();navigate(\'/songs?id=' + Number(song.id) + '\')" title="' + t('setlist.openInSongsShort') + '" aria-label="' + t('setlist.openInSongsShort') + '">&#8599;</button>' : '') +
    '</div>';
  }).join('');

  body.innerHTML = rows + '<div class="hist-songs-total">' + t('setlist.total', { duration: formatLength(total) }) + '</div>';
}

function _histCancelEdit(sid) {
  _editSongs  = null;
  _editingSid = null;
  if (_histView) _histView.select(String(sid));
}

function _renderEditSongsList(sid) {
  var ul = document.getElementById('hist-edit-songs-ul');
  if (!ul) return;
  if (!_editSongs || !_editSongs.length) {
    ul.innerHTML = '<li style="color:var(--third-color);font-size:0.82rem;padding:0.4rem 0;list-style:none;">' + t('setlist.noSongsInSet') + '</li>';
    _refreshEditAddDropdown(sid);
    return;
  }
  var n = _editSongs.length;
  ul.innerHTML = _editSongs.map(function(song, i) {
    var isFirst = i === 0, isLast = i === n - 1;
    return '<li class="song-item" draggable="true" data-index="' + i + '">' +
      '<span class="drag-handle" aria-hidden="true">⠿</span>' +
      '<span class="song-num">' + (i + 1) + '.</span>' +
      '<div class="song-main">' +
        '<div class="song-top">' +
          '<span class="song-title">' + escHtml(song.title || '') + '</span>' +
          '<span class="song-time">' + formatLength(song.length_min) + '</span>' +
        '</div>' +
        (song.key ? '<div class="song-meta"><span>' + escHtml(formatKey(song.key)) + '</span></div>' : '') +
      '</div>' +
      '<div class="song-actions">' +
        '<button class="move-btn" data-onclick="_histEditMoveSong(' + i + ',-1,' + onArg(sid) + ')" ' + (isFirst ? 'disabled' : '') + ' aria-label="' + t('setlist.moveUp') + '">↑</button>' +
        '<button class="move-btn" data-onclick="_histEditMoveSong(' + i + ',1,' + onArg(sid) + ')" ' + (isLast ? 'disabled' : '') + ' aria-label="' + t('setlist.moveDown') + '">↓</button>' +
        '<button class="move-btn" data-remove data-onclick="_histEditRemoveSong(' + i + ',' + onArg(sid) + ')" title="' + t('setlist.removeTitle') + '" aria-label="' + escHtml(t('setlist.removeSong', { title: song.title || '' })) + '">&#215;</button>' +
      '</div>' +
    '</li>';
  }).join('');
  _refreshEditAddDropdown(sid);
}

function _refreshEditAddDropdown(sid) {
  var sel = document.getElementById('hist-edit-add-select');
  if (!sel) return;
  var inSetIds = new Set((_editSongs || []).map(function(s) { return s.id; }));
  var available = allSongs
    .filter(function(s) { return s.active && !inSetIds.has(s.id); })
    .sort(function(a, b) { return (a.title || '').localeCompare(b.title || ''); });
  sel.innerHTML = '<option value="">' + t('setlist.addSongPlaceholder') + '</option>' +
    available.map(function(s) { return '<option value="' + s.id + '">' + escHtml(s.title || '') + '</option>'; }).join('');
}

function _histEditMoveSong(index, dir, sid) {
  if (!_editSongs) return;
  var newIndex = index + dir;
  if (newIndex < 0 || newIndex >= _editSongs.length) return;
  var tmp = _editSongs[index];
  _editSongs[index] = _editSongs[newIndex];
  _editSongs[newIndex] = tmp;
  _renderEditSongsList(sid);
  focusSongAfterMove(document.getElementById('hist-edit-songs-ul'), newIndex, dir);
  announce(t('setlist.movedTo', { title: _editSongs[newIndex].title || '', pos: newIndex + 1, total: _editSongs.length }));
}

function _histEditRemoveSong(index, sid) {
  if (!_editSongs) return;
  var removed = _editSongs.splice(index, 1)[0];
  _renderEditSongsList(sid);
  focusSongAfterRemove(document.getElementById('hist-edit-songs-ul'), index, document.getElementById('hist-edit-add-select'));
  if (removed) announce(t('setlist.removedSong', { title: removed.title || '' }));
}

function _histEditAddSong(sel, sid) {
  var songId = Number(sel.value);
  if (!songId) return;
  var song = allSongs.find(function(s) { return s.id === songId; });
  if (!song || (_editSongs && _editSongs.some(function(s) { return s.id === songId; }))) return;
  if (!_editSongs) _editSongs = [];
  _editSongs.push(song);
  _renderEditSongsList(sid);
}

function _initEditSongsDnd(sid) {
  var ul = document.getElementById('hist-edit-songs-ul');
  if (!ul) return;
  var dragSrcIndex = null;
  ul.addEventListener('dragstart', function(e) {
    var li = e.target.closest('li[data-index]');
    if (!li) return;
    dragSrcIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  ul.addEventListener('dragend', function() {
    ul.querySelectorAll('.song-item').forEach(function(el) {
      el.classList.remove('dragging', 'drag-over');
    });
  });
  ul.addEventListener('dragover', function(e) {
    e.preventDefault();
    var li = e.target.closest('li[data-index]');
    if (!li) return;
    ul.querySelectorAll('.song-item').forEach(function(el) { el.classList.remove('drag-over'); });
    if (Number(li.dataset.index) !== dragSrcIndex) li.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
  });
  ul.addEventListener('drop', function(e) {
    e.preventDefault();
    var li = e.target.closest('li[data-index]');
    if (!li || dragSrcIndex === null || !_editSongs) return;
    var destIndex = Number(li.dataset.index);
    if (dragSrcIndex === destIndex) return;
    var moved = _editSongs.splice(dragSrcIndex, 1)[0];
    _editSongs.splice(destIndex, 0, moved);
    dragSrcIndex = null;
    _renderEditSongsList(sid);
  });
}

async function _histEdit(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var inner = document.getElementById('view-side-panel-inner');
  if (!inner) return;

  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + t('setlist.editPanelTitle') + '</h2></div>' +
      '<button class="vsp-close" data-onclick="_histCancelEdit(' + onArg(sid) + ')" aria-label="' + t('setlist.cancelBtn') + '">×</button>' +
    '</div>' +
    skeletonHtml(3);

  await _loadHistSongs(sid);
  _editSongs = (_histLoadedSongs[sid] || []).slice();

  var gigOptions = '<option value="">' + t('setlist.noGig') + '</option>' +
    _histGigs.filter(function(g) {
      // A deleted gig is offered only while this setlist is linked to it.
      return !g.deleted || String(g.id) === String(s.gig_id);
    }).map(function(g) {
      var sel = String(g.id) === String(s.gig_id) ? ' selected' : '';
      var label = escHtml(g.title || '') + (g.date ? ' — ' + formatDate(g.date) : '');
      return '<option value="' + g.id + '"' + sel + '>' + label + '</option>';
    }).join('');

  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + t('setlist.editPanelTitle') + '</h2></div>' +
      '<button class="vsp-close" data-onclick="_histCancelEdit(' + onArg(sid) + ')" aria-label="' + t('setlist.cancelBtn') + '">×</button>' +
    '</div>' +
    '<div style="padding:0 1rem 1rem;">' +
      '<div class="modal-field">' +
        '<label for="hist-edit-title">' + t('setlist.nameLabel') + '</label>' +
        '<input type="text" id="hist-edit-title" value="' + escHtml(s.title || '') + '" autocomplete="off">' +
      '</div>' +
      '<div class="modal-field">' +
        '<label for="hist-edit-gig">' + t('setlist.editGigLabel') + '</label>' +
        '<select id="hist-edit-gig">' + gigOptions + '</select>' +
      '</div>' +
      '<div class="modal-field">' +
        '<label for="hist-edit-comment">' + t('setlist.editCommentLabel') + '</label>' +
        '<textarea id="hist-edit-comment" placeholder="' + t('setlist.editCommentPlaceholder') + '">' + escHtml(s.comment || '') + '</textarea>' +
      '</div>' +
      '<div class="modal-field">' +
        '<label for="hist-edit-add-select" id="hist-edit-songs-label">' + t('setlist.editSongsLabel') + '</label>' +
        '<ul id="hist-edit-songs-ul" class="song-list" aria-labelledby="hist-edit-songs-label" style="margin:0;padding:0;"></ul>' +
        '<div class="add-song-row" style="margin-top:0.5rem;">' +
          '<select id="hist-edit-add-select" aria-label="' + t('setlist.addSongLabel') + '" data-onchange="_histEditAddSong(this,' + onArg(sid) + ')">' +
            '<option value="">' + t('setlist.addSongPlaceholder') + '</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="status-msg" id="hist-edit-error"></div>' +
      '<div class="modal-actions" id="hist-edit-actions">' +
        '<button class="btn active" id="hist-edit-save" data-onclick="_saveHistEdit(' + onArg(sid) + ')">' + t('setlist.saveBtn') + '</button>' +
        '<button class="btn" data-onclick="_histCancelEdit(' + onArg(sid) + ')">' + t('setlist.cancelBtn') + '</button>' +
        '<button class="btn" style="margin-left:auto;color:#e55;" data-onclick="_promptDeleteSetlist(' + onArg(sid) + ')">' + t('setlist.deleteBtn') + '</button>' +
      '</div>' +
    '</div>';

  _editingSid = sid;
  _renderEditSongsList(sid);
  _initEditSongsDnd(sid);
  document.getElementById('hist-edit-title').focus();
}

async function _saveHistEdit(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var titleVal = (document.getElementById('hist-edit-title').value || '').trim();
  var gigId    = document.getElementById('hist-edit-gig').value || null;
  var comment  = (document.getElementById('hist-edit-comment').value || '').trim() || null;
  var token    = getToken();

  if (!titleVal) {
    var errEl = document.getElementById('hist-edit-error');
    if (errEl) { errEl.textContent = t('setlist.editNameRequired'); errEl.className = 'status-msg error'; }
    document.getElementById('hist-edit-title').focus();
    return;
  }

  var saveBtn = document.getElementById('hist-edit-save');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = t('setlist.editSaving'); }

  var songIds = (_editSongs || []).map(function(song) { return song.id; });

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists/' + sid, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ title: titleVal, gig_id: gigId ? Number(gigId) : null, comment: comment, song_ids: songIds })
    });

    if (r.status === 401) {
      clearToken();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      var errEl3 = document.getElementById('hist-edit-error');
      if (errEl3) { errEl3.textContent = t('setlist.editSessionExpired'); errEl3.className = 'status-msg error'; }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('setlist.saveBtn'); }
      return;
    }

    if (!r.ok) {
      var errEl4 = document.getElementById('hist-edit-error');
      if (errEl4) { errEl4.textContent = t('setlist.editSaveFailed'); errEl4.className = 'status-msg error'; }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('setlist.saveBtn'); }
      return;
    }

    // Update in-memory caches
    s.title      = titleVal;
    s.gig_id     = gigId ? Number(gigId) : null;
    s.comment    = comment;
    s.song_count = songIds.length;
    var updGig   = s.gig_id ? _histGigMap[s.gig_id] : null;
    s.gig_name   = updGig ? (updGig.title      || '') : null;
    s.gig_date   = updGig ? (updGig.date        || '') : null;
    s.gig_venue  = updGig ? (updGig.venue_name  || '') : null;
    _histLoadedSongs[sid] = (_editSongs || []).map(function(song, i) {
      return Object.assign({}, song, { position: i + 1 });
    });
    _editSongs = null;

    var okEl = document.getElementById('hist-edit-error');
    if (okEl) {
      okEl.textContent = t('setlist.editSaved');
      okEl.className = 'status-msg success';
      okEl.style.display = 'block';
      okEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    setTimeout(function() {
      if (_histView) {
        _histView.refresh();
        _histView.select(sid);
      }
    }, 900);
  } catch {
    var errEl5 = document.getElementById('hist-edit-error');
    if (errEl5) { errEl5.textContent = t('setlist.editNetworkError'); errEl5.className = 'status-msg error'; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('setlist.saveBtn'); }
  }
}

function _promptDeleteSetlist(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var gigNote = '';
  if (s.gig_id && s.gig_name) {
    var gigLabel = escHtml(s.gig_name) + (s.gig_date ? ' (' + formatDate(s.gig_date) + ')' : '');
    if (s.gig_venue) gigLabel += ' — ' + escHtml(s.gig_venue);
    gigNote = '<p style="font-size:0.82rem;color:var(--third-color);margin:0.5rem 0 0;">' + t('setlist.deleteLinkedGig', { gigLabel: gigLabel }) + '</p>';
  }

  var actionsEl = document.getElementById('hist-edit-actions');
  if (!actionsEl) return;
  actionsEl.innerHTML =
    '<p style="font-size:0.85rem;margin:0;">' + t('setlist.deleteConfirmMsg', { title: escHtml(s.title || t('setlist.untitled')) }) + '</p>' +
    gigNote +
    '<div style="display:flex;gap:0.5rem;margin-top:0.75rem;">' +
      '<button class="btn active" style="background:#e55;border-color:#e55;" data-onclick="_confirmDeleteSetlist(' + onArg(sid) + ')">' + t('setlist.deleteBtn') + '</button>' +
      '<button class="btn" data-onclick="_cancelDeleteSetlist(' + onArg(sid) + ')">' + t('setlist.keepIt') + '</button>' +
    '</div>';
}

function _cancelDeleteSetlist(sid) {
  sid = String(sid);
  var actionsEl = document.getElementById('hist-edit-actions');
  if (!actionsEl) return;
  actionsEl.innerHTML =
    '<button class="btn active" id="hist-edit-save" data-onclick="_saveHistEdit(' + onArg(sid) + ')">' + t('setlist.saveBtn') + '</button>' +
    '<button class="btn" data-onclick="_histCancelEdit(' + onArg(sid) + ')">' + t('setlist.cancelBtn') + '</button>' +
    '<button class="btn" style="margin-left:auto;color:#e55;" data-onclick="_promptDeleteSetlist(' + onArg(sid) + ')">' + t('setlist.deleteBtn') + '</button>';
}

async function _confirmDeleteSetlist(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var token = getToken();
  var actionsEl = document.getElementById('hist-edit-actions');
  if (actionsEl) actionsEl.innerHTML = '<p style="font-size:0.85rem;color:var(--third-color);margin:0;">' + t('setlist.deleting') + '</p>';

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists/' + sid, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) throw new Error('Failed');
    _histSets = _histSets.filter(function(x) { return String(x.id) !== sid; });
    delete _histLoadedSongs[sid];
    _editSongs = null;
    _editingSid = null;
    if (_histView) _histView.refresh();
  } catch {
    if (actionsEl) actionsEl.innerHTML = '<p style="font-size:0.85rem;color:#e55;margin:0;">' + t('setlist.deleteFailed') + '</p>' +
      '<button class="btn" style="margin-top:0.5rem;" data-onclick="_cancelDeleteSetlist(' + onArg(sid) + ')">' + t('setlist.backBtn') + '</button>';
  }
}

function _closeSongPanel() {
  document.querySelectorAll('.hist-song-row--active').forEach(function(el) {
    el.classList.remove('hist-song-row--active');
  });
  if (_histView) _histView.deselect();
}

function _openSongPanel(setlistSid, songId) {
  setlistSid = String(setlistSid);
  songId = Number(songId);

  var songs = _histLoadedSongs[setlistSid] || [];
  var song = songs.find(function(s) { return s.id === songId; });
  if (!song) return;

  // Toggle off if same song clicked again
  var prev = document.querySelector('.hist-song-row--active');
  if (prev && Number(prev.dataset.songId) === songId) {
    _closeSongPanel();
    return;
  }

  // Highlight active row
  document.querySelectorAll('.hist-song-row--active').forEach(function(el) { el.classList.remove('hist-song-row--active'); });
  var rowEl = document.querySelector('.hist-song-row[data-song-id="' + songId + '"]');
  if (rowEl) rowEl.classList.add('hist-song-row--active');

  // Open panel with song-only content — no gig/venue/organizer meta
  var panel = document.getElementById('view-side-panel');
  var inner = document.getElementById('view-side-panel-inner');
  if (!panel || !inner) return;

  var s = _histSets.find(function(x) { return String(x.id) === setlistSid; });
  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + escHtml((s && s.title) || t('setlist.untitled')) + '</h2></div>' +
      '<button class="vsp-close" data-onclick="_closeSongPanel()" aria-label="' + t('setlist.closeBtn') + '">&#215;</button>' +
    '</div>' +
    '<div id="hist-song-detail"></div>';

  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    var content = document.getElementById('setlist-content');
    if (content) content.classList.add('side-panel-open');
    if (window.innerWidth <= 1024) document.body.style.overflow = 'hidden';
  }

  var detail = document.getElementById('hist-song-detail');
  if (!detail) return;

  // Build field cells using displayFields if configured
  var displayFields = (bandConfig && bandConfig.displayFields) || [];
  var fieldMap = {};
  displayFields.forEach(function(f) { fieldMap[f.field] = f.label; });

  function cellVal(field) {
    if (field.startsWith('extra.')) return song.extra && song.extra[field.slice(6)];
    return song[field];
  }

  var defaultFields = ['key', 'genre', 'energy', 'length_min', 'extra.lead', 'extra.banjoCapo', 'extra.gitCapo'];
  var shownFields = displayFields.length ? displayFields.map(function(f) { return f.field; }) : defaultFields;
  if (shownFields.indexOf('length_min') === -1) shownFields = shownFields.concat(['length_min']);
  shownFields = shownFields.filter(function(f) { return !songFieldHidden(bandConfig, f); });

  var cells = shownFields.map(function(field) {
    var val = cellVal(field);
    if (val === null || val === undefined || val === '') return '';
    var label = fieldMap[field] || field.replace('extra.', '').replace(/_/g, ' ');
    var display = field === 'length_min' ? formatLength(val) : field === 'key' ? escHtml(formatKey(String(val))) : escHtml(String(val));
    return '<div class="vsp-cell">' +
      '<div class="vsp-cell-label">' + escHtml(label) + '</div>' +
      '<div class="vsp-cell-value">' + display + '</div>' +
    '</div>';
  }).filter(Boolean).join('');

  var commentBlock = song.comment
    ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="white-space:pre-wrap;color:var(--third-color);font-size:0.82rem">' + escHtml(song.comment) + '</div></div>'
    : '';

  // Lyrics are not in the song list: fetched with the song's details below.
  var hasLyrics = !!(song.has_lyrics || song.lyrics);
  var lyricsBlock = hasLyrics
    ? '<div class="vsp-section-label">' + t('setlist.lyricsLabel') + '</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" id="hist-song-lyrics" style="white-space:pre-wrap;font-size:0.8rem;max-height:12rem;overflow-y:auto">' +
        (song.lyrics ? escHtml(song.lyrics) : t('common.loading')) + '</div></div>'
    : '';

  detail.innerHTML =
    '<div class="vsp-section-label">' + escHtml(song.title || '') + '</div>' +
    (cells || '') +
    commentBlock + lyricsBlock +
    '<div class="vsp-actions" style="margin-top:0.75rem;">' +
      '<button class="btn" data-onclick="navigate(\'/songs?id=' + Number(song.id) + '\')">' + t('setlist.openInSongs') + '</button>' +
    '</div>';
  if (hasLyrics && song.lyrics === undefined) {
    loadSongLyrics(_artistSlug, song).then(function(text) {
      var el = document.getElementById('hist-song-lyrics');
      if (el) el.textContent = text;
    }).catch(function() {
      var el = document.getElementById('hist-song-lyrics');
      if (el) el.textContent = '';
    });
  }
}

function _histStage(sid) {
  window.open('/' + _artistSlug + '/stage?id=' + sid, '_blank');
}

async function _histExportPdf(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  await _loadHistSongs(sid);
  var cfg = await loadConfig(undefined, { light: true });
  printSetlistSongs(_histLoadedSongs[sid] || [], (s && s.title) || '', cfg);
}

function _histShareMenu(sid, btn) {
  sid = String(sid);
  var existing = document.getElementById('share-menu-popup');
  if (existing) {
    existing.remove();
    if (existing.dataset.sid === sid) return;
  }

  var menu = document.createElement('div');
  menu.id = 'share-menu-popup';
  menu.className = 'share-menu';
  menu.dataset.sid = sid;
  menu.innerHTML =
    '<div class="share-menu-item" data-onclick="_histExportPdf(' + onArg(sid) + ');closeShareMenu()">' +
      '<span class="share-menu-icon">⎙</span><span class="share-menu-label">' + t('setlist.shareMenuExportPdf') + '</span>' +
    '</div>' +
    '<div class="share-menu-item" data-onclick="_histCopyLink(' + onArg(sid) + ')">' +
      '<span class="share-menu-icon">⧉</span><span class="share-menu-label">' + t('setlist.shareMenuCopyLink') + '</span>' +
    '</div>' +
    '<div class="share-menu-item" data-onclick="closeShareMenu();_histShare(' + onArg(sid) + ')">' +
      '<span class="share-menu-icon">✉</span><span class="share-menu-label">' + t('setlist.shareMenuEmail') + '</span>' +
    '</div>';

  var rect = btn.getBoundingClientRect();
  menu.style.cssText = 'position:fixed;top:' + (rect.bottom + 6) + 'px;left:' + rect.left + 'px';
  document.body.appendChild(menu);
  // Shift left if overflowing right edge
  var overflow = menu.getBoundingClientRect().right - (window.innerWidth - 8);
  if (overflow > 0) menu.style.left = Math.max(8, rect.left - overflow) + 'px';

  function closeMenu(e) {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  }
  setTimeout(function() { document.addEventListener('click', closeMenu); }, 0);
}

function _histCopyLink(sid) {
  var url = location.origin + '/' + _artistSlug + '/stage?id=' + sid;
  var menu = document.getElementById('share-menu-popup');
  var item = menu && menu.querySelectorAll('.share-menu-item')[1];
  if (item) item.innerHTML = '<span class="share-menu-icon">✓</span><span class="share-menu-label">' + t('setlist.shareMenuCopied') + '</span>';
  navigator.clipboard.writeText(url).catch(function() {
    if (item) item.innerHTML = '<span class="share-menu-icon">⧉</span><span class="share-menu-label">' + t('setlist.shareMenuCopyLink') + '</span>';
  });
  setTimeout(function() { if (menu && menu.parentNode) menu.remove(); }, 900);
}

function _histShare(sid) {
  sid = String(sid);
  var inner = document.getElementById('view-side-panel-inner');
  if (!inner) return;

  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + t('setlist.sharePanelTitle') + '</h2></div>' +
      '<button class="vsp-close" data-onclick="_histCancelEdit(' + onArg(sid) + ')" aria-label="' + t('setlist.cancelBtn') + '">×</button>' +
    '</div>' +
    '<p style="padding:0 1rem;font-size:0.84rem;color:var(--third-color);">' + t('setlist.shareSendPdf') + '</p>' +
    '<div style="padding:0 1rem;">' +
      '<div class="modal-field"><label for="hist-share-email">' + t('setlist.shareEmailLabel') + '</label>' +
        '<input type="email" id="hist-share-email" placeholder="' + t('setlist.shareEmailPlaceholder') + '"></div>' +
      '<div class="status-msg" id="hist-share-status"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn active" id="hist-share-send" data-onclick="_histShareSend(' + onArg(sid) + ')">' + t('setlist.shareSendBtn') + '</button>' +
        '<button class="btn" data-onclick="_histCancelEdit(' + onArg(sid) + ')">' + t('setlist.cancelBtn') + '</button>' +
      '</div>' +
    '</div>';

  setTimeout(function() { var el = document.getElementById('hist-share-email'); if (el) el.focus(); }, 50);
}

async function _histShareSend(sid) {
  sid = String(sid);
  var email = (document.getElementById('hist-share-email').value || '').trim();
  var st = document.getElementById('hist-share-status');

  if (!email) {
    if (st) { st.textContent = t('setlist.shareEnterEmail'); st.className = 'status-msg error'; }
    document.getElementById('hist-share-email').focus();
    return;
  }

  var token = getToken();
  if (!token) { window.location.assign(loginPageUrl()); return; }

  var btn = document.getElementById('hist-share-send');
  if (btn) { btn.disabled = true; btn.textContent = t('setlist.shareSending'); }
  if (st) { st.textContent = ''; st.className = 'status-msg'; }

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists/' + Number(sid) + '/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ email: email })
    });

    if (r.status === 401) {
      clearToken();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      if (st) { st.textContent = t('setlist.shareWrongPassword'); st.className = 'status-msg error'; }
      if (btn) { btn.disabled = false; btn.textContent = t('setlist.shareSendBtn'); }
      return;
    }

    if (r.ok) {
      sessionStorage.setItem(AUTH_TOKEN_KEY, token);
      if (st) { st.textContent = t('setlist.shareSentTo', { email: email }); st.className = 'status-msg success'; st.style.display = 'block'; }
      if (btn) btn.disabled = true;
      setTimeout(function() { _histCancelEdit(sid); }, 1800);
    } else {
      var errData = await r.json().catch(function() { return {}; });
      if (st) { st.textContent = errData.error || t('setlist.shareGenericFailed'); st.className = 'status-msg error'; }
      if (btn) { btn.disabled = false; btn.textContent = t('setlist.shareSendBtn'); }
    }
  } catch {
    if (st) { st.textContent = t('setlist.shareNetworkError'); st.className = 'status-msg error'; }
    if (btn) { btn.disabled = false; btn.textContent = t('setlist.shareSendBtn'); }
  }
}

async function _histDuplicate(sid) {
  sid = String(sid);
  var token = getToken();

  var dupBtn = document.querySelector('.vsp-actions button[onclick*="_histDuplicate"]');

  if (!token) {
    if (dupBtn) {
      dupBtn.insertAdjacentHTML('afterend', '<span id="dup-status" style="font-size:0.78rem;color:var(--third-color);display:block;margin-top:0.4rem;">' + t('setlist.dupLoginFirst') + '</span>');
    }
    return;
  }

  if (dupBtn) { dupBtn.disabled = true; dupBtn.textContent = '…'; }

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists/' + Number(sid) + '/duplicate', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (r.status === 401) {
      clearToken();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = t('setlist.duplicateTooltip'); }
      return;
    }

    if (r.ok) {
      var created = await r.json();
      _histSets.unshift(created);
      if (_histView) {
        _histView.refresh();
        _histView.select(String(created.id));
      }
    } else {
      if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = t('setlist.duplicateTooltip'); }
    }
  } catch {
    if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = t('setlist.duplicateTooltip'); }
  }
}
