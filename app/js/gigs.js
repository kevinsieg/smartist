var artistSlug = '';
var allGigs = [];
var allVenues = [];
var allOrganizers = [];
var editingId = null;
var hardDeleteId = null;

var upcomingTable;
var pastTable;
var _gigsTotal = 0;
var _gigsOffset = 0;

var _gigFilters = { gig: '', venue: '', organizer: '', setlist: '', song: '' };
var _gigAllSetlists = [];
var _gigSongTimer = null;
var _gigSongMatchGigIds = null;  // null = no filter; Set<gigId>
var cfg = null;
var _viewMode = false;

var GIG_COLUMNS = [
  { field: 'date',           label: 'Date',      width: '100px', sortable: true, type: 'date' },
  { field: 'title',          label: 'Title',     width: '1fr',   sortable: true, filterable: true },
  { field: 'type',           label: 'Type',      width: '80px',
    render: g => g.type ? `<span class="sl-badge">${escHtml(g.type)}</span>` : '' },
  { field: 'venue_name',     label: 'Venue',     width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'organizer_name', label: 'Organizer', width: '1fr',   sortable: true, filterable: true, muted: true },
  { width: 'auto', actions: true, render: function(g) {
    if (g.deleted) return '<span class="sl-deleted-badge">deleted</span>';
    var setsBtn = '<button class="btn sl-sets-btn" title="View setlists" style="margin-left:0.35rem"' +
      ' onclick="navigate(\'/setlist?view=history&gig=' + encodeURIComponent(g.title) + '\')">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="5" y="2" width="14" height="20" rx="2"/>' +
      '<line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>' +
      '</svg></button>';
    if (_viewMode) return setsBtn;
    return '<button class="btn sl-del-btn" onclick="promptHardDelete(' + g.id + ')">Delete</button>' + setsBtn;
  }},
];

initPage(async function(config, viewMode) {
  cfg = config;
  _viewMode = viewMode;
  artistSlug = cfg.slug;

  upcomingTable = createSortableList({
    containerId:    'upcoming-list',
    sortBarId:      'sort-bar',
    columns:        GIG_COLUMNS,
    defaultSort:    'date',
    defaultSortDir: -1,
    rowClass:       function(g) { return g.deleted ? 'deleted' : ''; },
    onRowClick:     function(g) { return !_viewMode && !g.deleted && openEditModal(g.id); },
    emptyHint:      'No upcoming gigs.',
  });

  pastTable = createSortableList({
    containerId:     'past-list',
    sortBarId:       'sort-bar',
    columns:         GIG_COLUMNS,
    defaultSort:     'date',
    defaultSortDir:  -1,
    separateDeleted: true,
    rowClass:        function(g) { return g.deleted ? 'deleted' : ''; },
    onRowClick:      function(g) { return !_viewMode && !g.deleted && openEditModal(g.id); },
    emptyHint:       'No past gigs.',
  });

  await loadGigs();

  if (_viewMode) {
    applyViewMode();
    var notice = document.createElement('div');
    notice.className = 'view-mode-notice';
    notice.innerHTML = 'View mode — <a href="/">Login</a> for full access.';
    var page = document.querySelector('.app-page') || document.body;
    page.insertBefore(notice, page.firstChild);
  }

  // Fetch setlists for cross-entity filter
  try {
    var setsRes = await fetch('/api/' + artistSlug + '/setlists');
    _gigAllSetlists = await setsRes.json();
    if (!Array.isArray(_gigAllSetlists)) _gigAllSetlists = [];
  } catch { _gigAllSetlists = []; }

  // Wire filter inputs
  ['gig', 'venue', 'organizer', 'setlist'].forEach(function(field) {
    var el = document.getElementById('gig-f-' + field);
    if (!el) return;
    el.addEventListener('input', function(e) {
      _gigFilters[field] = e.target.value.toLowerCase();
      _applyGigsFilter();
    });
  });
  document.getElementById('gig-f-song').addEventListener('input', function(e) {
    _gigFilters.song = e.target.value;
    _runGigSongFilter(e.target.value.trim().toLowerCase());
  });

  // Deep-link: pre-fill filters from URL params
  var qp = new URLSearchParams(location.search);
  if (qp.get('venue'))     { document.getElementById('gig-f-venue').value     = qp.get('venue');     _gigFilters.venue     = qp.get('venue').toLowerCase(); }
  if (qp.get('organizer')) { document.getElementById('gig-f-organizer').value = qp.get('organizer'); _gigFilters.organizer = qp.get('organizer').toLowerCase(); }
  if (qp.get('setlist'))   { document.getElementById('gig-f-setlist').value   = qp.get('setlist');   _gigFilters.setlist   = qp.get('setlist').toLowerCase(); }
  if (qp.get('song'))      { document.getElementById('gig-f-song').value      = qp.get('song');      _runGigSongFilter(qp.get('song').toLowerCase()); }
  if (qp.get('id'))        { openEditModal(Number(qp.get('id'))); }
  _applyGigsFilter();

  // Set sticky offset
  requestAnimationFrame(function() {
    var hdr = document.querySelector('.app-header');
    if (hdr) document.documentElement.style.setProperty('--songs-toolbar-top', hdr.getBoundingClientRect().height + 'px');
  });
});

async function loadGigs() {
  _gigsOffset = 0;
  const r = await fetch(`/api/${artistSlug}/gigs?limit=50&offset=0`);
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
    if (f.organizer && !(g.organizer_name || '').toLowerCase().includes(f.organizer)) return false;
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
  var countEl = document.getElementById('gig-filter-count');
  if (countEl) countEl.textContent = visible.length + ' / ' + allGigs.length;
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
  const r = await fetch(`/api/${artistSlug}/gigs?limit=50&offset=${_gigsOffset}`);
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
  counter.textContent = `Showing ${allGigs.length} of ${_gigsTotal} gig${_gigsTotal !== 1 ? 's' : ''}`;
  footer.style.display = _gigsTotal > 0 ? '' : 'none';
  if (btn) btn.style.display = allGigs.length < _gigsTotal ? '' : 'none';
}

var _venueTypeahead = null;

async function ensureVenuesLoaded() {
  if (allVenues.length) return;
  const r = await fetch(`/api/${artistSlug}/venues?slim=1`);
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
  if (!name) { setStatus('gm-venue-qc-status', 'Name required', true); return; }
  setStatus('gm-venue-qc-status', 'Saving…');
  const r = await apiFetch(`/api/${artistSlug}/venues`, 'POST', { name, city: city || null });
  const json = await r.json();
  if (!r.ok) { setStatus('gm-venue-qc-status', json.error || 'Error', true); return; }
  allVenues.push(json);
  if (_venueTypeahead) _venueTypeahead.updateItems(allVenues);
  document.getElementById('gm-venue-input').value = json.name + (json.city ? ` (${json.city})` : '');
  document.getElementById('gm-venue-id').value    = json.id;
  closeVenueQc();
}

var _organizerTypeahead = null;

async function ensureOrganizersLoaded() {
  if (allOrganizers.length) return;
  const r = await fetch(`/api/${artistSlug}/organizers?slim=1`);
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
  if (!name) { setStatus('gm-organizer-qc-status', 'Name required', true); return; }
  setStatus('gm-organizer-qc-status', 'Saving…');
  const r = await apiFetch(`/api/${artistSlug}/organizers`, 'POST', { name, city: city || null });
  const json = await r.json();
  if (!r.ok) { setStatus('gm-organizer-qc-status', json.error || 'Error', true); return; }
  allOrganizers.push(json);
  if (_organizerTypeahead) _organizerTypeahead.updateItems(allOrganizers);
  document.getElementById('gm-organizer-input').value = json.name + (json.city ? ` (${json.city})` : '');
  document.getElementById('gm-organizer-id').value    = json.id;
  closeOrganizerQc();
}

async function openAddModal() {
  editingId = null;
  document.getElementById('gig-modal-title').textContent = 'Add gig';
  ['title', 'date', 'time-start', 'time-end', 'link', 'comment'].forEach(f => {
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
  openModal('gig-modal');
}

async function openEditModal(id) {
  const g = allGigs.find(x => x.id === id);
  if (!g) return;
  editingId = id;
  document.getElementById('gig-modal-title').textContent = 'Edit gig';
  document.getElementById('gm-title').value      = g.title || '';
  document.getElementById('gm-date').value       = g.date ? String(g.date).slice(0, 10) : '';
  document.getElementById('gm-type').value       = g.type || '';
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
  openModal('gig-modal');
}

function closeGigModal() { closeModal('gig-modal'); }

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
    additional_link: document.getElementById('gm-link').value.trim()    || null,
    comment:         document.getElementById('gm-comment').value.trim() || null,
  };
  setStatus('gm-status', 'Saving…');
  const url = editingId ? `/api/${artistSlug}/gigs/${editingId}` : `/api/${artistSlug}/gigs`;
  const r   = await apiFetch(url, editingId ? 'PUT' : 'POST', body);
  const json = await r.json();
  if (!r.ok) { setStatus('gm-status', json.error || 'Error', true); return; }
  closeGigModal();
  await loadGigs();
  if (editingId) delete _gigRefsCache[editingId];
}

var _gigRefsCache = {};

async function renderGigRelated(gigId) {
  const section = document.getElementById('gm-related');
  const content = document.getElementById('gm-related-content');
  section.style.display = '';
  content.innerHTML = '<span style="color:var(--third-color);font-size:0.82rem;">Loading…</span>';

  if (!_gigRefsCache[gigId]) {
    try {
      const r = await fetch(`/api/${artistSlug}/gigs/${gigId}?refs=1`);
      if (!r.ok) throw new Error(r.status);
      _gigRefsCache[gigId] = await r.json();
    } catch {
      content.innerHTML = '<span style="color:#e55;font-size:0.82rem;">Could not load related data.</span>';
      return;
    }
  }
  const { refs } = _gigRefsCache[gigId];

  const venuePart = refs.venue
    ? `<div class="related-row">Venue &nbsp;<strong>${escHtml(refs.venue.name)}${refs.venue.city ? `, ${escHtml(refs.venue.city)}` : ''}</strong><a href="/venues" class="related-link">↗</a></div>`
    : '';

  const orgPart = refs.organizer
    ? `<div class="related-row">Organizer &nbsp;<strong>${escHtml(refs.organizer.name)}</strong><a href="/organizers" class="related-link">↗</a></div>`
    : '';

  const setlistPart = refs.setlists.length
    ? `<div class="related-row">Setlists &nbsp;${refs.setlists.map(s => `<a href="/stage?id=${s.id}" target="_blank" style="font-size:0.82rem;margin-right:0.5rem;">${escHtml(s.title || '(untitled)')}</a>`).join(' · ')}</div>`
    : '';

  content.innerHTML = venuePart + orgPart + setlistPart
    || '<span style="color:var(--third-color);font-size:0.82rem;">No related records.</span>';
}

async function softDeleteGig() {
  if (!editingId) return;
  const r = await apiFetch(`/api/${artistSlug}/gigs/${editingId}`, 'DELETE', {});
  if (r.ok) { closeGigModal(); await loadGigs(); }
}

async function promptHardDelete(id) {
  hardDeleteId = id;
  const r = await fetch(`/api/${artistSlug}/gigs/${id}?refs=1`);
  const { refs } = await r.json();
  const setlistCount = refs.setlists.length;
  document.getElementById('hd-refs-msg').textContent = setlistCount > 0
    ? `This gig has ${setlistCount} linked setlist(s).`
    : 'This gig has no linked setlists.';
  document.getElementById('hd-cascade-opts').innerHTML = setlistCount > 0
    ? `<label><input type="checkbox" id="hd-cascade-setlists"> Also delete ${setlistCount} linked setlist(s)</label>`
    : '';
  setStatus('hd-status', '');
  openModal('hard-delete-modal');
}

function closeHardDeleteModal() { closeModal('hard-delete-modal'); }

async function confirmHardDelete() {
  const cascade = [];
  if (document.getElementById('hd-cascade-setlists')?.checked) cascade.push('setlists');
  const r = await apiFetch(`/api/${artistSlug}/gigs/${hardDeleteId}`, 'DELETE', { hard: true, cascade });
  if (r.ok) { closeHardDeleteModal(); await loadGigs(); }
  else { const j = await r.json(); setStatus('hd-status', j.error || 'Error', true); }
}
