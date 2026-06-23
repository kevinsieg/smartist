var artistSlug = '';
var allGigs = [];
var allVenues = [];
var allOrganizers = [];
var editingId = null;
var upcomingTable;
var pastTable;
var _gigsTotal = 0;
var _gigsOffset = 0;

var _gigFilters = { gig: '', venue: '', setlist: '', song: '' };
var _gigAllSetlists = [];
var _gigSongTimer = null;
var _gigSongMatchGigIds = null;  // null = no filter; Set<gigId>
var cfg = null;

// ── Gig poster image utilities ────────────────────────────────────────────

function _loadImage(file) {
  return new Promise(function(resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function() { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = function() { URL.revokeObjectURL(url); reject(new Error(t('gigs.couldNotLoadImage'))); };
    img.src = url;
  });
}

function _canvasToJpegBlob(canvas, quality) {
  return new Promise(function(resolve) {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
}

async function generatePosterBlob(file) {
  var img = await _loadImage(file);
  var limits = [0, 2048, 1600, 1200]; // 0 = natural size first
  for (var i = 0; i < limits.length; i++) {
    var maxEdge = limits[i] || Math.max(img.naturalWidth, img.naturalHeight);
    var scale   = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    var canvas  = document.createElement('canvas');
    canvas.width  = Math.round(img.naturalWidth  * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    var blob = await _canvasToJpegBlob(canvas, 0.85);
    if (blob.size <= 5 * 1024 * 1024) return blob;
  }
  // Last resort: 1200px max, quality 0.6
  var canvas2 = document.createElement('canvas');
  var s2 = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  canvas2.width  = Math.round(img.naturalWidth  * s2);
  canvas2.height = Math.round(img.naturalHeight * s2);
  canvas2.getContext('2d').drawImage(img, 0, 0, canvas2.width, canvas2.height);
  return _canvasToJpegBlob(canvas2, 0.6);
}

async function generateThumbBlob(file) {
  var img  = await _loadImage(file);
  var size = Math.min(img.naturalWidth, img.naturalHeight);
  var sx   = (img.naturalWidth  - size) / 2;
  var sy   = (img.naturalHeight - size) / 2;
  var c    = document.createElement('canvas');
  c.width  = c.height = 72;
  c.getContext('2d').drawImage(img, sx, sy, size, size, 0, 0, 72, 72);
  return _canvasToJpegBlob(c, 0.85);
}

async function uploadPoster(gigId, file) {
  setStatus('gm-poster-status', t('gigs.processingImage'));
  try {
    var [posterBlob, thumbBlob] = await Promise.all([
      generatePosterBlob(file),
      generateThumbBlob(file),
    ]);
    setStatus('gm-poster-status', t('gigs.uploading'));
    var r1 = await apiFetch('/api/' + artistSlug + '/gigs/' + gigId + '?action=poster-url', 'POST', {
      contentType: 'image/jpeg',
    });
    if (!r1.ok) {
      var e1 = await r1.json();
      throw new Error(e1.error || t('gigs.couldNotGetUploadUrl'));
    }
    var urls = await r1.json();
    var [pr, tr] = await Promise.all([
      fetch(urls.posterUploadUrl, { method: 'PUT', body: posterBlob, headers: { 'Content-Type': 'image/jpeg' } }),
      fetch(urls.thumbUploadUrl,  { method: 'PUT', body: thumbBlob,  headers: { 'Content-Type': 'image/jpeg' } }),
    ]);
    if (!pr.ok || !tr.ok) throw new Error(t('gigs.uploadStorageFailed', { status: !pr.ok ? pr.status : tr.status }));
    var r2 = await apiFetch('/api/' + artistSlug + '/gigs/' + gigId + '?action=poster', 'PUT', {
      posterUrl: urls.posterPublicUrl,
      thumbUrl:  urls.thumbPublicUrl,
    });
    if (!r2.ok) {
      var e2 = await r2.json();
      throw new Error(e2.error || t('gigs.couldNotSavePoster'));
    }
    var gig = allGigs.find(function(g) { return g.id === gigId; });
    if (gig) { gig.poster_url = urls.posterPublicUrl; gig.thumb_url = urls.thumbPublicUrl; }
    renderGigs();
    renderPosterRow(gig);
    setStatus('gm-poster-status', '');
  } catch (err) {
    setStatus('gm-poster-status', err.message || t('gigs.uploadFailed'), true);
  }
}

async function removePoster(gigId) {
  setStatus('gm-poster-status', t('gigs.removing'));
  try {
    var r = await apiFetch('/api/' + artistSlug + '/gigs/' + gigId + '?action=poster', 'DELETE');
    if (!r.ok) {
      var e = await r.json();
      throw new Error(e.error || t('gigs.couldNotRemovePoster'));
    }
    var gig = allGigs.find(function(g) { return g.id === gigId; });
    if (gig) { gig.poster_url = null; gig.thumb_url = null; }
    renderGigs();
    renderPosterRow(gig);
    setStatus('gm-poster-status', '');
  } catch (err) {
    setStatus('gm-poster-status', err.message || t('gigs.removeFailed'), true);
  }
}

function renderPosterRow(g) {
  var row = document.getElementById('gm-poster-row');
  if (!row) return;
  if (!g) { row.innerHTML = ''; return; }
  if (g.thumb_url) {
    row.innerHTML =
      '<div class="gig-poster-row">' +
        '<img class="gig-poster-thumb" src="' + escHtml(g.thumb_url) + '">' +
        '<div class="gig-poster-actions">' +
          '<button class="btn" type="button" onclick="document.getElementById(\'gm-poster-input\').click()">' + t('gigs.replaceBtn') + '</button>' +
          '<button class="btn" type="button" id="gm-poster-remove-btn" onclick="confirmRemovePoster()">' + t('gigs.removeBtn') + '</button>' +
        '</div>' +
      '</div>';
  } else {
    row.innerHTML =
      '<button class="btn" type="button" onclick="document.getElementById(\'gm-poster-input\').click()">' + t('gigs.uploadPosterBtn') + '</button>';
  }
}

function confirmRemovePoster() {
  var btn = document.getElementById('gm-poster-remove-btn');
  if (!btn) return;
  if (btn.dataset.confirm === '1') {
    removePoster(editingId);
  } else {
    btn.textContent = t('gigs.confirmRemoveBtn');
    btn.dataset.confirm = '1';
    setTimeout(function() {
      if (btn.isConnected) { btn.textContent = t('gigs.removeBtn'); delete btn.dataset.confirm; }
    }, 3000);
  }
}

async function handlePosterSelect(file) {
  if (!file || !editingId) return;
  var allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!allowed.has(file.type)) {
    setStatus('gm-poster-status', t('gigs.imageTypeError'), true);
    document.getElementById('gm-poster-input').value = '';
    return;
  }
  await uploadPoster(editingId, file);
  document.getElementById('gm-poster-input').value = '';
}

var GIG_COLUMNS = [
  { field: 'thumb_url', label: '', width: '44px', sortable: false,
    render: function(g) {
      if (g.thumb_url) {
        return '<div class="gig-thumb-wrap" data-poster="' + escHtml(g.poster_url) + '" onclick="event.stopPropagation();openLightbox(this.dataset.poster)">' +
               '<img class="gig-thumb" src="' + escHtml(g.thumb_url) + '" loading="lazy"></div>';
      }
      return '<div class="gig-thumb-placeholder gig-thumb-add" onclick="event.stopPropagation();openEditModal(' + g.id + ')" title="' + t('gigs.uploadPosterBtn') + '"></div>';
    }
  },
  { field: 'date', get label() { return t('gigs.colDate'); }, width: '75px', sortable: true, type: 'date',
    render: g => { if (!g.date) return '—'; var d = String(g.date); return d.slice(8, 10) + '/' + d.slice(5, 7); } },
  { field: 'title',      get label() { return t('gigs.colTitle'); },  width: '1fr',   sortable: true, filterable: true },
  { field: 'type',       get label() { return t('gigs.colType'); },   width: '80px',
    render: g => g.type ? `<span class="sl-badge">${escHtml(g.type)}</span>` : '' },
  { field: 'venue_name', get label() { return t('gigs.colVenue'); },  width: '1fr',   sortable: true, filterable: true, muted: true },
  { width: 'auto', actions: true, render: function(g) {
    if (g.deleted) return '<span class="sl-deleted-badge">' + t('gigs.deletedBadge') + '</span>' +
      '<button class="btn sl-edit-btn" title="' + t('gigs.permanentlyDeleteTitle') + '" style="color:#e55;" onclick="event.stopPropagation();deleteGigFromPopup(' + g.id + ')">' + t('gigs.eraseBtn') + '</button>';
    var hasSetlist = _gigAllSetlists.some(function(s) { return s.gig_id === g.id; });
    var setsBtn = hasSetlist ? '<button class="btn sl-sets-btn" title="' + t('gigs.viewSetlistsTitle') + '" onclick="event.stopPropagation();openGigSetlists(' + g.id + ')">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="5" y="2" width="14" height="20" rx="2"/>' +
      '<line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>' +
      '</svg></button>' : '';
    return '<button class="btn sl-edit-btn" title="' + t('gigs.editTitle') + '" onclick="event.stopPropagation();openEditModal(' + g.id + ')">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/></svg></button>' + setsBtn;
  }},
];

var _gigLightboxEl = null;

function _ensureLightbox() {
  if (_gigLightboxEl) return;
  _gigLightboxEl = document.createElement('div');
  _gigLightboxEl.className = 'gig-lightbox';
  _gigLightboxEl.innerHTML = '<img class="gig-lightbox-img" src="" alt="Poster">';
  _gigLightboxEl.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeLightbox(); });
  document.body.appendChild(_gigLightboxEl);
}

function openLightbox(url) {
  if (!url) return;
  _ensureLightbox();
  _gigLightboxEl.querySelector('.gig-lightbox-img').src = url;
  _gigLightboxEl.style.display = 'flex';
}

function closeLightbox() {
  if (_gigLightboxEl) _gigLightboxEl.style.display = 'none';
}

function _insertYearDividers(containerId) {
  var el = document.getElementById(containerId);
  if (!el) return;
  var rows = el.querySelectorAll('.sl-row:not(.deleted)');
  var lastYear = null;
  rows.forEach(function(row) {
    var gig = allGigs.find(function(g) { return g.id === Number(row.dataset.id); });
    var year = (gig && gig.date) ? String(gig.date).slice(0, 4) : null;
    if (!year || year === lastYear) return;
    var divider = document.createElement('div');
    divider.className = 'gigs-year-divider';
    divider.textContent = year;
    el.insertBefore(divider, row);
    lastYear = year;
  });
}

initPage(async function(config) {
  cfg = config;
  artistSlug = cfg.slug;
  _gigFilters = { gig: '', venue: '', setlist: '', song: '' };
  _gigSongMatchGigIds = null;

  // Set up calendar links immediately — no need to wait for gigs to load
  var _icsPath = '/api/' + artistSlug + '/gigs?format=ics';
  var _calEl = document.getElementById('gig-cal-subscribe');
  if (_calEl) {
    _calEl.href = 'webcal://' + location.host + _icsPath;
    _calEl.style.display = '';
  }
  var _copyEl = document.getElementById('gig-cal-copy');
  if (_copyEl) {
    _copyEl.dataset.url = location.protocol + '//' + location.host + _icsPath;
    _copyEl.addEventListener('click', function() {
      navigator.clipboard.writeText(this.dataset.url).then(function() {
        _copyEl.textContent = t('gigs.copiedMsg');
        setTimeout(function() { _copyEl.textContent = t('gigs.copyLink'); }, 2000);
      });
    });
  }

  var _gigCols = window.innerWidth < 640
    ? GIG_COLUMNS.filter(function(c) { return c.field !== 'venue_name' && c.field !== 'type'; })
    : GIG_COLUMNS;

  upcomingTable = createSortableList({
    containerId:    'upcoming-list',
    sortBarId:      'sort-bar',
    columns:        _gigCols,
    defaultSort:    'date',
    defaultSortDir: -1,
    rowClass:       function(g) { return g.deleted ? 'deleted' : ''; },
    onExpand:       function(g) { return expandGig(g); },
    emptyHint:      t('gigs.noUpcomingGigs'),
  });

  pastTable = createSortableList({
    containerId:     'past-list',
    sortBarId:       'sort-bar',
    columns:         _gigCols,
    defaultSort:     'date',
    defaultSortDir:  -1,
    separateDeleted: true,
    rowClass:        function(g) { return g.deleted ? 'deleted' : ''; },
    onExpand:        function(g) { return expandGig(g); },
    emptyHint:       t('gigs.noPastGigs'),
  });

  await loadGigs();

  // Re-insert year dividers after sort bar re-renders the past list
  var _sortBarEl = document.getElementById('sort-bar');
  if (_sortBarEl) {
    _sortBarEl.addEventListener('click', function(e) {
      if (e.target.closest('.sort-btn')) setTimeout(function() { _insertYearDividers('past-list'); }, 0);
    });
  }

  // Fetch setlists for cross-entity filter
  try {
    var setsRes = await apiFetch('/api/' + artistSlug + '/setlists');
    _gigAllSetlists = await setsRes.json();
    if (!Array.isArray(_gigAllSetlists)) _gigAllSetlists = [];
  } catch { _gigAllSetlists = []; }

  // Filter toggle
  var _filterPanelOpen = false;
  function _openFilterPanel() {
    _filterPanelOpen = true;
    var panel = document.getElementById('gig-filter-panel');
    var arrow = document.getElementById('gig-filter-arrow');
    var toggle = document.getElementById('gig-filter-toggle');
    if (panel) panel.style.display = '';
    if (arrow) arrow.textContent = '▴';
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
  }
  function _updateFilterBadge() {
    var count = ['gig', 'venue', 'setlist', 'song'].filter(function(k) { return !!_gigFilters[k]; }).length;
    var badge  = document.getElementById('gig-filter-badge');
    var toggle = document.getElementById('gig-filter-toggle');
    if (badge)  { badge.textContent = count; badge.style.display = count > 0 ? '' : 'none'; }
    if (toggle) toggle.classList.toggle('has-active', count > 0);
  }
  var _toggleEl = document.getElementById('gig-filter-toggle');
  if (_toggleEl) _toggleEl.addEventListener('click', function() {
    _filterPanelOpen = !_filterPanelOpen;
    var panel = document.getElementById('gig-filter-panel');
    var arrow = document.getElementById('gig-filter-arrow');
    if (panel) panel.style.display = _filterPanelOpen ? '' : 'none';
    if (arrow) arrow.textContent = _filterPanelOpen ? '▴' : '▾';
    _toggleEl.setAttribute('aria-expanded', _filterPanelOpen ? 'true' : 'false');
  });

  // Wire filter inputs
  ['gig', 'venue', 'setlist'].forEach(function(field) {
    var el = document.getElementById('gig-f-' + field);
    if (!el) return;
    el.addEventListener('input', function(e) {
      _gigFilters[field] = e.target.value.toLowerCase();
      _applyGigsFilter();
      _updateFilterBadge();
    });
  });
  var songEl = document.getElementById('gig-f-song');
  if (songEl) songEl.addEventListener('input', function(e) {
    _gigFilters.song = e.target.value;
    _runGigSongFilter(e.target.value.trim().toLowerCase());
    _updateFilterBadge();
  });

  // Deep-link: pre-fill filters from URL params
  var qp = new URLSearchParams(location.search);
  var _venueEl = document.getElementById('gig-f-venue');
  var _setlistEl = document.getElementById('gig-f-setlist');
  var _songDlEl = document.getElementById('gig-f-song');
  if (qp.get('venue')   && _venueEl)   { _venueEl.value   = qp.get('venue');   _gigFilters.venue   = qp.get('venue').toLowerCase(); }
  if (qp.get('setlist') && _setlistEl) { _setlistEl.value = qp.get('setlist'); _gigFilters.setlist = qp.get('setlist').toLowerCase(); }
  if (qp.get('song')    && _songDlEl)  { _songDlEl.value  = qp.get('song');    _runGigSongFilter(qp.get('song').toLowerCase()); }
  if (qp.get('venue') || qp.get('setlist') || qp.get('song')) _openFilterPanel();
  if (qp.get('id')) { openEditModal(Number(qp.get('id'))); }
  else { openDeepLinkedRow('open'); }
  _applyGigsFilter();
  _updateFilterBadge();

  onEnterSave(document.getElementById('gig-modal'), saveGig);

  // Set sticky offset
  requestAnimationFrame(function() {
    var hdr = document.querySelector('.app-header');
    if (hdr) document.documentElement.style.setProperty('--songs-toolbar-top', hdr.getBoundingClientRect().height + 'px');
  });
}, { fullConfig: true }); // song filter needs cfg.songs

async function loadGigs() {
  _gigsOffset = 0;
  const r = await apiFetch(`/api/${artistSlug}/gigs?limit=50&offset=0`);
  const { rows, total } = await r.json();
  _gigsTotal = total;
  allGigs = rows;
  renderGigs();
  updateGigsFooter();
}

function renderGigs() {
  _applyGigsFilter();
}

function _applyGigsFilter() {
  var f = _gigFilters;
  var visible = allGigs.filter(function(g) {
    if (f.gig      && !(g.title          || '').toLowerCase().includes(f.gig))      return false;
    if (f.venue    && !(g.venue_name     || '').toLowerCase().includes(f.venue))    return false;
if (f.setlist) {
      var hasSet = _gigAllSetlists.some(function(s) {
        return s.gig_id === g.id && (s.name || '').toLowerCase().includes(f.setlist);
      });
      if (!hasSet) return false;
    }
    if (_gigSongMatchGigIds !== null && !_gigSongMatchGigIds.has(g.id)) return false;
    return true;
  });
  var today = new Date().toISOString().slice(0, 10);
  upcomingTable.setData(visible.filter(function(g) { return !g.deleted && g.date >= today; }));
  pastTable.setData(visible.filter(function(g) { return g.deleted || !g.date || g.date < today; }));
  _insertYearDividers('past-list');
  var countEl = document.getElementById('gig-filter-count');
  if (countEl) countEl.textContent = visible.length + ' / ' + allGigs.length;

  var emptyCta = document.getElementById('gigs-empty-cta');
  if (emptyCta) emptyCta.remove();
  if (!allGigs.length) {
    var upList = document.getElementById('upcoming-list');
    if (upList) {
      var ctaDiv = document.createElement('div');
      ctaDiv.id = 'gigs-empty-cta';
      ctaDiv.style.cssText = 'text-align:center;padding:1.5rem 1rem;color:var(--third-color);';
      ctaDiv.innerHTML = '<p style="margin-bottom:1rem;">' + t('gigs.noGigsYet') + '</p>' +
        (getToken() ? '<button class="btn active" onclick="openAddModal()">' + t('gigs.addFirstGigBtn') + '</button>' : '');
      upList.appendChild(ctaDiv);
    }
  }
}

async function _runGigSongFilter(q) {
  clearTimeout(_gigSongTimer);
  if (!q) { _gigSongMatchGigIds = null; _applyGigsFilter(); return; }
  _gigSongTimer = setTimeout(async function() {
    var matchingSongs = (cfg && cfg.songs || []).filter(function(s) {
      return (s.title || '').toLowerCase().includes(q);
    });
    if (!matchingSongs.length) { _gigSongMatchGigIds = new Set(); _applyGigsFilter(); return; }
    try {
      var results = await Promise.all(
        matchingSongs.map(function(s) {
          return fetch('/api/' + artistSlug + '/songs/' + s.id + '/setlists').then(function(r) { return r.json(); });
        })
      );
      var setlistIds = new Set(results.reduce(function(acc, objs) { return acc.concat(objs.map(function(o) { return o.id; })); }, []));
      _gigSongMatchGigIds = new Set(
        _gigAllSetlists.filter(function(s) { return setlistIds.has(s.id) && s.gig_id; }).map(function(s) { return s.gig_id; })
      );
    } catch {
      _gigSongMatchGigIds = new Set();
    }
    _applyGigsFilter();
  }, 400);
}

async function loadMoreGigs() {
  _gigsOffset += 50;
  const r = await apiFetch(`/api/${artistSlug}/gigs?limit=50&offset=${_gigsOffset}`);
  const { rows } = await r.json();
  allGigs = [...allGigs, ...rows];
  renderGigs();
  updateGigsFooter();
}

function updateGigsFooter() {
  const footer  = document.getElementById('gigs-footer');
  const counter = document.getElementById('gigs-counter');
  const btn     = document.getElementById('gigs-load-more-btn');
  if (!footer || !counter) return;
  counter.textContent = t(_gigsTotal !== 1 ? 'gigs.showingGigs_other' : 'gigs.showingGigs_one', { shown: allGigs.length, total: _gigsTotal });
  footer.style.display = _gigsTotal > 0 ? '' : 'none';
  if (btn) btn.style.display = allGigs.length < _gigsTotal ? '' : 'none';
}

var _venueTypeahead = null;

async function ensureVenuesLoaded() {
  if (allVenues.length) return;
  const r = await apiFetch(`/api/${artistSlug}/venues?slim=1`);
  allVenues = await r.json();
}

function wireVenueTypeahead(selectedId) {
  const input  = document.getElementById('gm-venue-input');
  const hidden = document.getElementById('gm-venue-id');

  if (selectedId) {
    const v = allVenues.find(x => x.id === selectedId);
    input.value  = v ? (v.name + (v.city ? ` (${v.city})` : '')) : '';
    hidden.value = selectedId;
  } else {
    input.value = ''; hidden.value = '';
  }

  if (_venueTypeahead) { _venueTypeahead.updateItems(allVenues); return; }

  _venueTypeahead = createTypeahead(input, {
    items:    allVenues,
    labelFn:  v => v.name + (v.city ? ` (${v.city})` : ''),
    onSelect: v => { hidden.value = v.id; input.value = v.name + (v.city ? ` (${v.city})` : ''); },
    onCreate: text => openVenueQc(text),
  });

  input.addEventListener('input', () => { if (!input.value.trim()) hidden.value = ''; });
}

function openVenueQc(prefill) {
  document.getElementById('gm-venue-qc-name').value = prefill || '';
  document.getElementById('gm-venue-qc-city').value = '';
  setStatus('gm-venue-qc-status', '');
  document.getElementById('gm-venue-qc').classList.add('open');
  document.getElementById('gm-venue-qc-name').focus();
}

function closeVenueQc() {
  document.getElementById('gm-venue-qc').classList.remove('open');
}

async function quickCreateVenue() {
  const name = document.getElementById('gm-venue-qc-name').value.trim();
  const city = document.getElementById('gm-venue-qc-city').value.trim();
  if (!name) { setStatus('gm-venue-qc-status', t('gigs.nameRequired'), true); return; }
  setStatus('gm-venue-qc-status', t('gigs.saving'));
  const r = await apiFetch(`/api/${artistSlug}/venues`, 'POST', { name, city: city || null });
  const json = await r.json();
  if (!r.ok) { setStatus('gm-venue-qc-status', json.error || t('gigs.errorFallback'), true); return; }
  allVenues.push(json);
  if (_venueTypeahead) _venueTypeahead.updateItems(allVenues);
  document.getElementById('gm-venue-input').value = json.name + (json.city ? ` (${json.city})` : '');
  document.getElementById('gm-venue-id').value    = json.id;
  closeVenueQc();
}

var _organizerTypeahead = null;

async function ensureOrganizersLoaded() {
  if (allOrganizers.length) return;
  const r = await apiFetch(`/api/${artistSlug}/organizers?slim=1`);
  allOrganizers = await r.json();
}

function wireOrganizerTypeahead(selectedId) {
  const input  = document.getElementById('gm-organizer-input');
  const hidden = document.getElementById('gm-organizer-id');

  if (selectedId) {
    const o = allOrganizers.find(x => x.id === selectedId);
    input.value  = o ? (o.name + (o.city ? ` (${o.city})` : '')) : '';
    hidden.value = selectedId;
  } else {
    input.value = ''; hidden.value = '';
  }

  if (_organizerTypeahead) { _organizerTypeahead.updateItems(allOrganizers); return; }

  _organizerTypeahead = createTypeahead(input, {
    items:    allOrganizers,
    labelFn:  o => o.name + (o.city ? ` (${o.city})` : ''),
    onSelect: o => { hidden.value = o.id; input.value = o.name + (o.city ? ` (${o.city})` : ''); },
    onCreate: text => openOrganizerQc(text),
  });

  input.addEventListener('input', () => { if (!input.value.trim()) hidden.value = ''; });
}

function openOrganizerQc(prefill) {
  document.getElementById('gm-organizer-qc-name').value = prefill || '';
  document.getElementById('gm-organizer-qc-city').value = '';
  setStatus('gm-organizer-qc-status', '');
  document.getElementById('gm-organizer-qc').classList.add('open');
  document.getElementById('gm-organizer-qc-name').focus();
}

function closeOrganizerQc() {
  document.getElementById('gm-organizer-qc').classList.remove('open');
}

async function quickCreateOrganizer() {
  const name = document.getElementById('gm-organizer-qc-name').value.trim();
  const city = document.getElementById('gm-organizer-qc-city').value.trim();
  if (!name) { setStatus('gm-organizer-qc-status', t('gigs.nameRequired'), true); return; }
  setStatus('gm-organizer-qc-status', t('gigs.saving'));
  const r = await apiFetch(`/api/${artistSlug}/organizers`, 'POST', { name, city: city || null });
  const json = await r.json();
  if (!r.ok) { setStatus('gm-organizer-qc-status', json.error || t('gigs.errorFallback'), true); return; }
  allOrganizers.push(json);
  if (_organizerTypeahead) _organizerTypeahead.updateItems(allOrganizers);
  document.getElementById('gm-organizer-input').value = json.name + (json.city ? ` (${json.city})` : '');
  document.getElementById('gm-organizer-id').value    = json.id;
  closeOrganizerQc();
}

async function openAddModal() {
  editingId = null;
  document.getElementById('gig-modal-title').textContent = t('gigs.addGig');
  ['title', 'date', 'location', 'time-start', 'time-end', 'link', 'comment'].forEach(f => {
    const el = document.getElementById(`gm-${f}`); if (el) el.value = '';
  });
  document.getElementById('gm-type').value = '';
  await ensureVenuesLoaded();
  wireVenueTypeahead(null);
  document.getElementById('gm-venue-qc').classList.remove('open');
  await ensureOrganizersLoaded();
  wireOrganizerTypeahead(null);
  document.getElementById('gm-organizer-qc').classList.remove('open');
  document.getElementById('gm-soft-delete-btn').style.display = 'none';
  document.getElementById('gm-related').style.display = 'none';
  setStatus('gm-status', '');
  var ps = document.getElementById('gm-poster-section');
  if (ps) ps.style.display = 'none';
  openModal('gig-modal');
}

async function openEditModal(id) {
  const g = allGigs.find(x => x.id === id);
  if (!g) return;
  editingId = id;
  document.getElementById('gig-modal-title').textContent = t('gigs.editGig');
  document.getElementById('gm-title').value      = g.title || '';
  document.getElementById('gm-date').value       = g.date ? String(g.date).slice(0, 10) : '';
  document.getElementById('gm-type').value       = g.type || '';
  document.getElementById('gm-location').value   = g.location || '';
  document.getElementById('gm-time-start').value = g.time_start || '';
  document.getElementById('gm-time-end').value   = g.time_end || '';
  document.getElementById('gm-link').value       = g.additional_link || '';
  document.getElementById('gm-comment').value    = g.comment || '';
  await ensureVenuesLoaded();
  wireVenueTypeahead(g.venue_id);
  document.getElementById('gm-venue-qc').classList.remove('open');
  await ensureOrganizersLoaded();
  wireOrganizerTypeahead(g.organizer_id);
  document.getElementById('gm-organizer-qc').classList.remove('open');
  document.getElementById('gm-soft-delete-btn').style.display = '';
  setStatus('gm-status', '');
  renderGigRelated(id);
  var ps = document.getElementById('gm-poster-section');
  if (ps) {
    ps.style.display = '';
    setStatus('gm-poster-status', '');
    renderPosterRow(g);
  }
  openModal('gig-modal');
}

function closeGigModal() { closeModal('gig-modal'); }

function _downloadGigIcs(id) {
  var g = allGigs.find(function(x) { return x.id === id; });
  if (!g || !g.date) return;
  var d = String(g.date).slice(0, 10).replace(/-/g, '');
  var dtstart, dtend;
  if (g.time_start) {
    var ts = g.time_start.slice(0, 5).replace(':', '');
    dtstart = 'DTSTART:' + d + 'T' + ts + '00';
    if (g.time_end) {
      dtend = 'DTEND:' + d + 'T' + g.time_end.slice(0, 5).replace(':', '') + '00';
    } else {
      var eh = (Number(ts.slice(0, 2)) + 2) % 24;
      dtend = 'DTEND:' + d + 'T' + String(eh).padStart(2, '0') + ts.slice(2) + '00';
    }
  } else {
    var next = new Date(g.date); next.setDate(next.getDate() + 1);
    dtstart = 'DTSTART;VALUE=DATE:' + d;
    dtend   = 'DTEND;VALUE=DATE:' + next.toISOString().slice(0, 10).replace(/-/g, '');
  }
  function esc(s) { return (s||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n'); }
  var loc  = [g.venue_name, g.location].filter(Boolean).join(', ');
  var desc = [
    g.type            ? 'Type: ' + g.type           : '',
    g.additional_link ? 'Link: ' + g.additional_link : '',
    g.comment || '',
  ].filter(Boolean).join('\\n');
  var now  = new Date().toISOString().replace(/[-:.]/g,'').slice(0,15) + 'Z';
  var ics  = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Smartist//EN',
    'CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT',
    'UID:gig-' + g.id + '@smartist', 'DTSTAMP:' + now,
    dtstart, dtend, 'SUMMARY:' + esc(g.title),
    loc  ? 'LOCATION:'    + esc(loc)  : '',
    desc ? 'DESCRIPTION:' + esc(desc) : '',
    'END:VEVENT','END:VCALENDAR'].filter(Boolean).join('\r\n');
  var url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  var a = document.createElement('a');
  a.href = url;
  a.download = (g.title || 'gig').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.ics';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function expandGig(g) {
  var rows = [];
  if (g.venue_name)      rows.push([t('gigs.expandVenue'),     escHtml(g.venue_name)]);
  if (!g.venue_name && g.location) rows.push([t('gigs.expandLocation'), escHtml(g.location)]);
  if (g.organizer_name) rows.push([t('gigs.expandOrganizer'), escHtml(g.organizer_name)]);
  if (g.type)            rows.push([t('gigs.expandType'),      escHtml(g.type.charAt(0).toUpperCase() + g.type.slice(1))]);
  if (g.time_start)      rows.push([t('gigs.expandTime'),      escHtml(g.time_start.slice(0, 5)) + (g.time_end ? ' – ' + escHtml(g.time_end.slice(0, 5)) : '')]);
  if (g.additional_link) rows.push([t('gigs.expandLink'),      '<a href="' + escHtml(safeUrl(g.additional_link)) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">' + escHtml(g.additional_link) + '</a>']);
  if (g.comment) rows.push([t('gigs.expandNotes'), escHtml(g.comment)]);
  if (g.additional_text) rows.push([t('gigs.expandInfo'),      escHtml(g.additional_text)]);
  var html = rows.map(function(r) {
    return '<div class="expansion-row"><span class="expansion-label expansion-key">' + r[0] + '</span><span>' + r[1] + '</span></div>';
  }).join('');
  if (!html) html = '<span style="color:var(--third-color);font-size:0.82rem;">' + t('gigs.noDetails') + '</span>';
  if (g.date) html += '<div style="margin-top:0.6rem">' +
    '<button class="btn" style="font-size:0.78rem;padding:0.2rem 0.65rem;min-height:0" ' +
    'onclick="event.stopPropagation();_downloadGigIcs(' + g.id + ')" title="' + t('gigs.downloadIcsTitle') + '">' +
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
    t('gigs.addToCalendar') + '</button></div>';
  return html;
}

async function openGigSetlists(gigId) {
  var titleEl = document.getElementById('sd-title');
  var body    = document.getElementById('sd-body');
  titleEl.textContent = t('gigs.setlistsTitle');
  body.innerHTML = skeletonHtml(2);
  openModal('setlist-detail-modal');
  if (!_gigRefsCache[gigId]) {
    try {
      const r = await apiFetch('/api/' + artistSlug + '/gigs/' + gigId + '?refs=1');
      if (!r.ok) throw new Error(r.status);
      _gigRefsCache[gigId] = await r.json();
    } catch {
      body.innerHTML = '<span style="color:#e55;font-size:0.85rem;">' + t('gigs.couldNotLoadSetlists') + '</span>';
      return;
    }
  }
  const refs = _gigRefsCache[gigId].refs;
  if (!refs.setlists.length) {
    body.innerHTML = '<span style="color:var(--third-color);font-size:0.85rem;">' + t('gigs.noSetlistsYet') + '</span>';
    return;
  }
  var single = refs.setlists.length === 1;
  if (single) titleEl.textContent = refs.setlists[0].title || t('gigs.setlistsTitle');
  body.innerHTML = refs.setlists.map(function(s) {
    var songs = (refs.setlistSongs || []).filter(function(ss) { return ss.setlist_id === s.id; });
    var hdr  = single ? '' : '<div class="expansion-label" style="margin:0.6rem 0 0.3rem;">' + escHtml(s.title || 'Setlist') + '</div>';
    var list = songs.length
      ? '<ol style="margin:0 0 0.5rem;padding-left:1.4rem;line-height:1.9;font-size:0.9rem;">' +
          songs.map(function(ss) { return '<li>' + escHtml(ss.title) + '</li>'; }).join('') +
          '</ol>'
      : '<p style="color:var(--third-color);font-size:0.85rem;margin-bottom:0.5rem;">' + t('gigs.emptySetlist') + '</p>';
    return hdr + list;
  }).join('');
}

function deleteGigFromPopup(id) {
  id = id || editingId;
  closeGigModal();
  openHardDeleteModal({
    title: t('gigs.permanentlyDeleteGig'),
    refsUrl: '/api/' + artistSlug + '/gigs/' + id + '?refs=1',
    deleteUrl: '/api/' + artistSlug + '/gigs/' + id,
    buildRefsMsg: function(refs) {
      if (!refs.setlists.length) return t('gigs.noLinkedSetlists');
      return t('gigs.linkedSetlists') + '<ul style="margin:0.3rem 0 0;padding-left:1.2rem;">' +
        refs.setlists.map(function(s) { return '<li>' + escHtml(s.title || t('gigs.untitledSetlist')) + '</li>'; }).join('') +
        '</ul>';
    },
    buildCascadeOpts: function(refs) {
      return refs.setlists.length
        ? '<label><input type="checkbox" id="hd-cascade-setlists"> ' + t('gigs.alsoDeleteSetlists', { count: refs.setlists.length }) + '</label>'
        : '';
    },
    getCascade: function() {
      var c = [];
      if (document.getElementById('hd-cascade-setlists')?.checked) c.push('setlists');
      return c;
    },
    onSuccess: async function() { delete _gigRefsCache[id]; await loadGigs(); },
  });
}

async function saveGig() {
  const venueVal = document.getElementById('gm-venue-id').value;
  const orgVal = document.getElementById('gm-organizer-id').value;
  const body = {
    title:           document.getElementById('gm-title').value.trim(),
    date:            document.getElementById('gm-date').value || null,
    type:            document.getElementById('gm-type').value || null,
    venue_id:        venueVal ? Number(venueVal) : null,
    organizer_id:    orgVal   ? Number(orgVal)   : null,
    time_start:      document.getElementById('gm-time-start').value || null,
    time_end:        document.getElementById('gm-time-end').value   || null,
    location:        document.getElementById('gm-location').value.trim()  || null,
    additional_link: document.getElementById('gm-link').value.trim()      || null,
    comment:         document.getElementById('gm-comment').value.trim()   || null,
  };
  setStatus('gm-status', t('gigs.saving'));
  const url = editingId ? `/api/${artistSlug}/gigs/${editingId}` : `/api/${artistSlug}/gigs`;
  const r   = await apiFetch(url, editingId ? 'PUT' : 'POST', body);
  const json = await r.json();
  if (!r.ok) { setStatus('gm-status', json.error || t('gigs.errorFallback'), true); return; }
  closeGigModal();
  await loadGigs();
  if (editingId) delete _gigRefsCache[editingId];
}

var _gigRefsCache = {};

async function renderGigRelated(gigId) {
  const section = document.getElementById('gm-related');
  const content = document.getElementById('gm-related-content');
  section.style.display = '';
  content.innerHTML = skeletonHtml(2);

  if (!_gigRefsCache[gigId]) {
    try {
      const r = await apiFetch(`/api/${artistSlug}/gigs/${gigId}?refs=1`);
      if (!r.ok) throw new Error(r.status);
      _gigRefsCache[gigId] = await r.json();
    } catch {
      content.innerHTML = '<span style="color:#e55;font-size:0.82rem;">' + t('gigs.couldNotLoadRelated') + '</span>';
      return;
    }
  }
  const { refs } = _gigRefsCache[gigId];

  const venuePart = refs.venue
    ? `<div class="related-row">${t('gigs.expandVenue')} &nbsp;<strong>${escHtml(refs.venue.name)}${refs.venue.city ? `, ${escHtml(refs.venue.city)}` : ''}</strong><a href="/venues" class="related-link">↗</a></div>`
    : '';

  const orgPart = refs.organizer
    ? `<div class="related-row">${t('gigs.expandOrganizer')} &nbsp;<strong>${escHtml(refs.organizer.name)}</strong><a href="/organizers" class="related-link">↗</a></div>`
    : '';

  const setlistPart = refs.setlists.length
    ? `<div class="related-row">${t('gigs.setlistsTitle')} &nbsp;${refs.setlists.map(s => `<a href="/${_artistSlug}/stage?id=${s.id}" target="_blank" style="font-size:0.82rem;margin-right:0.5rem;">${escHtml(s.title || t('gigs.untitledSetlist'))}</a>`).join(' · ')}</div>`
    : '';

  content.innerHTML = venuePart + orgPart + setlistPart
    || '<span style="color:var(--third-color);font-size:0.82rem;">' + t('gigs.noRelatedRecords') + '</span>';
}

