var artistSlug = '';
var allVenues = [];
var editingId = null;
var hardDeleteId = null;

var venueTable;
var placeholderTable;

var _venuesTotal = 0;
var _venuesOffset = 0;
var _venuesQ = '';
var _venuesTimer = null;

var VENUE_COLUMNS = [
  { field: 'name',    label: 'Name',     width: '1.5fr', sortable: true, filterable: true },
  { field: 'city',    label: 'City',     width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'country', label: 'Country',  width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'postcode',label: 'Postcode', width: '90px',  sortable: true, filterable: true, muted: true },
  { field: 'size',    label: 'Capacity', width: '70px',  sortable: true, type: 'number',   muted: true },
  { field: 'status',  label: 'Status',   width: '90px',
    render: v => v.status ? `<span class="sl-badge">${escHtml(v.status)}</span>` : '' },
  { width: 'auto', actions: true, render: v => {
    if (v.deleted)                          return `<span class="sl-deleted-badge">deleted</span>`;
    if (v.category === 'placeholder')       return '';
    return `<button class="btn sl-del-btn" onclick="promptHardDelete(${v.id})">Delete</button>`;
  }},
];

initPage(async cfg => {
  artistSlug = cfg.slug;

  venueTable = createSortableList({
    containerId:    'venues-list',
    sortBarId:      'sort-bar',
    columns:        VENUE_COLUMNS,
    defaultSort:    'name',
    rowClass:       v => v.deleted ? 'deleted' : '',
    onRowClick:     v => openEditModal(v.id),
    emptyHint:      'No venues yet. Add one above.',
  });

  placeholderTable = createSortableList({
    containerId: 'placeholder-list',
    columns:     VENUE_COLUMNS,
    defaultSort: 'name',
    rowClass:    v => v.deleted ? 'deleted' : '',
    onRowClick:  v => openEditModal(v.id),
    emptyHint:   'None.',
  });

  const filterEl = document.getElementById('filter-input');
  if (filterEl) {
    filterEl.addEventListener('input', function() {
      clearTimeout(_venuesTimer);
      _venuesTimer = setTimeout(async function() {
        _venuesQ = filterEl.value.trim();
        _venuesOffset = 0;
        await loadVenues();
      }, 300);
    });
  }

  await loadVenues();
  initGeoFields('vm-city', 'vm-country', 'vm-postcode');

  var _venueDeepId = Number(new URLSearchParams(location.search).get('id'));
  if (_venueDeepId) openEditModal(_venueDeepId);
});

async function loadVenues() {
  const params = new URLSearchParams({ limit: 50, offset: _venuesOffset });
  if (_venuesQ) params.set('q', _venuesQ);
  const r = await fetch(`/api/${artistSlug}/venues?${params}`);
  const { rows, total } = await r.json();
  _venuesTotal = total;
  if (_venuesOffset === 0) {
    allVenues = rows;
  } else {
    allVenues = [...allVenues, ...rows];
  }
  placeholderTable.setData(allVenues.filter(v => v.category === 'placeholder'));
  venueTable.setData(allVenues.filter(v => v.category !== 'placeholder'));
  updateVenuesFooter();
}

async function loadMoreVenues() {
  _venuesOffset += 50;
  await loadVenues();
}

function updateVenuesFooter() {
  const footer  = document.getElementById('venues-footer');
  const counter = document.getElementById('venues-counter');
  const btn     = document.getElementById('venues-load-more-btn');
  if (!footer || !counter) return;
  counter.textContent = `Showing ${allVenues.length} of ${_venuesTotal} venue${_venuesTotal !== 1 ? 's' : ''}`;
  footer.style.display = _venuesTotal > 0 ? '' : 'none';
  if (btn) btn.style.display = allVenues.length < _venuesTotal ? '' : 'none';
}

function openAddModal() {
  editingId = null;
  document.getElementById('venue-modal-title').textContent = 'Add venue';
  ['name','postcode','city','country','category','email','website','comment'].forEach(f => {
    const el = document.getElementById(`vm-${f}`); if (el) el.value = '';
  });
  document.getElementById('vm-status').value = '';
  document.getElementById('vm-size').value   = '';
  document.getElementById('vm-delete-btn').style.display = 'none';
  document.getElementById('vm-gigs-section').style.display = 'none';
  setStatus('vm-status-msg', '');
  openModal('venue-modal');
}

function openEditModal(id) {
  const v = allVenues.find(x => x.id === id);
  if (!v) return;
  editingId = id;
  document.getElementById('venue-modal-title').textContent = 'Edit venue';
  document.getElementById('vm-name').value     = v.name          || '';
  document.getElementById('vm-postcode').value = v.postcode      || '';
  document.getElementById('vm-city').value     = v.city          || '';
  document.getElementById('vm-country').value  = v.country       || '';
  document.getElementById('vm-status').value   = v.status        || '';
  document.getElementById('vm-category').value = v.category      || '';
  document.getElementById('vm-email').value    = v.generic_email || '';
  document.getElementById('vm-website').value  = v.website       || '';
  document.getElementById('vm-size').value     = v.size          || '';
  document.getElementById('vm-comment').value  = v.comment       || '';
  document.getElementById('vm-delete-btn').style.display = v.deleted ? 'none' : '';
  setStatus('vm-status-msg', '');
  renderVenueGigs(id, v.name);
  openModal('venue-modal');
}

function closeVenueModal() { delete _venueRefsCache[editingId]; closeModal('venue-modal'); }

var _venueRefsCache = {};

async function saveVenue() {
  const body = {
    name:          document.getElementById('vm-name').value.trim(),
    postcode:      document.getElementById('vm-postcode').value.trim() || null,
    city:          document.getElementById('vm-city').value.trim()     || null,
    country:       document.getElementById('vm-country').value.trim()  || null,
    status:        document.getElementById('vm-status').value          || null,
    category:      document.getElementById('vm-category').value.trim() || null,
    generic_email: document.getElementById('vm-email').value.trim()    || null,
    website:       document.getElementById('vm-website').value.trim()  || null,
    size:          Number(document.getElementById('vm-size').value)    || null,
    comment:       document.getElementById('vm-comment').value.trim()  || null,
  };
  setStatus('vm-status-msg', 'Saving…');
  const url = editingId ? `/api/${artistSlug}/venues/${editingId}` : `/api/${artistSlug}/venues`;
  const r   = await apiFetch(url, editingId ? 'PUT' : 'POST', body);
  const json = await r.json();
  if (!r.ok) { setStatus('vm-status-msg', json.error || 'Error', true); return; }
  if (editingId) delete _venueRefsCache[editingId];
  closeVenueModal();
  _venuesOffset = 0;
  await loadVenues();
}

async function renderVenueGigs(venueId, venueName) {
  const section = document.getElementById('vm-gigs-section');
  const list    = document.getElementById('vm-gigs-list');
  section.style.display = '';
  list.innerHTML = '<span style="color:var(--third-color);font-size:0.82rem;">Loading…</span>';

  if (!_venueRefsCache[venueId]) {
    try {
      const r = await fetch(`/api/${artistSlug}/venues/${venueId}?refs=1`);
      if (!r.ok) throw new Error(r.status);
      _venueRefsCache[venueId] = await r.json();
    } catch {
      list.innerHTML = '<span style="color:#e55;font-size:0.82rem;">Could not load gigs.</span>';
      return;
    }
  }
  const { refs } = _venueRefsCache[venueId];

  if (!refs.gigs.length) {
    list.innerHTML = '<span style="color:var(--third-color);font-size:0.82rem;">No gigs yet.</span>';
    return;
  }

  var n = refs.gigs.length;
  list.innerHTML = refs.gigs.map(function(g) {
    return '<div class="related-gig-item">' +
      (g.date ? escHtml(String(g.date).slice(0, 10)) + ' — ' : '') +
      escHtml(g.title) +
    '</div>';
  }).join('') +
  '<a class="related-link" href="#" style="display:block;margin-top:0.5rem;font-size:0.82rem" ' +
    'onclick="event.preventDefault();closeVenueModal();navigate(\'/gigs?venue=' + encodeURIComponent(venueName) + '\')">' +
    '→ All ' + n + ' gig' + (n !== 1 ? 's' : '') + ' at this venue' +
  '</a>';
}

async function softDeleteVenue() {
  if (!editingId) return;
  const r = await apiFetch(`/api/${artistSlug}/venues/${editingId}`, 'DELETE', {});
  if (r.ok) { closeVenueModal(); _venuesOffset = 0; await loadVenues(); }
}

async function promptHardDelete(id) {
  hardDeleteId = id;
  const r = await fetch(`/api/${artistSlug}/venues/${id}?refs=1`);
  const { refs } = await r.json();
  const gigCount = refs.gigs.length;
  document.getElementById('hd-refs-msg').textContent = gigCount > 0
    ? `This venue is linked to ${gigCount} gig(s).`
    : 'This venue has no linked gigs.';
  const opts = [];
  if (gigCount > 0) {
    opts.push(`<label><input type="checkbox" id="hd-cascade-gigs"> Also delete ${gigCount} linked gig(s)</label>`);
    opts.push(`<label><input type="checkbox" id="hd-cascade-setlists"> Also delete setlists linked to those gigs</label>`);
  }
  document.getElementById('hd-cascade-opts').innerHTML = opts.join('<br>');
  setStatus('hd-status', '');
  openModal('hard-delete-modal');
}

function closeHardDeleteModal() { closeModal('hard-delete-modal'); }

async function confirmHardDelete() {
  const cascade = [];
  if (document.getElementById('hd-cascade-gigs')?.checked)     cascade.push('gigs');
  if (document.getElementById('hd-cascade-setlists')?.checked) cascade.push('setlists');
  const r = await apiFetch(`/api/${artistSlug}/venues/${hardDeleteId}`, 'DELETE', { hard: true, cascade });
  if (r.ok) { closeHardDeleteModal(); _venuesOffset = 0; await loadVenues(); }
  else { const j = await r.json(); setStatus('hd-status', j.error || 'Error', true); }
}
