var artistSlug = '';
var allOrganizers = [];
var editingId = null;
var hardDeleteId = null;

var organizerTable;

var _orgsTotal = 0;
var _orgsOffset = 0;
var _orgsQ = '';
var _orgsTimer = null;
var _viewMode = false;

var ORGANIZER_COLUMNS = [
  { field: 'name',    label: 'Name',    width: '1.5fr', sortable: true, filterable: true },
  { field: 'type',    label: 'Type',    width: '90px',  sortable: true,
    render: o => o.type ? `<span class="sl-badge">${escHtml(o.type)}</span>` : '' },
  { field: 'city',    label: 'City',    width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'country', label: 'Country', width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'email',   label: 'Email',   width: '1fr',   sortable: true, filterable: true, muted: true },
  { width: 'auto', actions: true, render: function(o) {
    if (o.deleted) return '<span class="sl-deleted-badge">deleted</span>';
    if (_viewMode) return '';
    return '<button class="btn sl-del-btn" onclick="promptHardDelete(' + o.id + ')">Delete</button>';
  }},
];

initPage(async function(cfg, viewMode) {
  _viewMode = viewMode;
  artistSlug = cfg.slug;

  organizerTable = createSortableList({
    containerId:   'organizers-list',
    sortBarId:     'sort-bar',
    columns:       ORGANIZER_COLUMNS,
    defaultSort:   'name',
    rowClass:      o => o.deleted ? 'deleted' : '',
    onRowClick:    function(o) { return !_viewMode && openEditModal(o.id); },
    emptyHint:     'No organizers yet. Add one above.',
  });

  const filterEl = document.getElementById('filter-input');
  if (filterEl) {
    filterEl.addEventListener('input', function() {
      clearTimeout(_orgsTimer);
      _orgsTimer = setTimeout(async function() {
        _orgsQ = filterEl.value.trim();
        _orgsOffset = 0;
        await loadOrganizers();
      }, 300);
    });
  }

  await loadOrganizers();

  if (_viewMode) {
    applyViewMode();
    var notice = document.createElement('div');
    notice.className = 'view-mode-notice';
    notice.innerHTML = 'View mode — <a class="go-login" href="#">Login</a> for full access.';
    var page = document.querySelector('.app-page') || document.body;
    page.insertBefore(notice, page.firstChild);
  }

  initGeoFields('om-city', 'om-country');

  var _orgDeepId = Number(new URLSearchParams(location.search).get('id'));
  if (_orgDeepId) openEditModal(_orgDeepId);
});

async function loadOrganizers() {
  const params = new URLSearchParams({ limit: 50, offset: _orgsOffset });
  if (_orgsQ) params.set('q', _orgsQ);
  const r = await fetch(`/api/${artistSlug}/organizers?${params}`);
  const { rows, total } = await r.json();
  _orgsTotal = total;
  if (_orgsOffset === 0) {
    allOrganizers = rows;
  } else {
    allOrganizers = [...allOrganizers, ...rows];
  }
  organizerTable.setData(allOrganizers);
  updateOrgsFooter();
}

async function loadMoreOrganizers() {
  _orgsOffset += 50;
  await loadOrganizers();
}

function updateOrgsFooter() {
  const footer  = document.getElementById('organizers-footer');
  const counter = document.getElementById('organizers-counter');
  const btn     = document.getElementById('organizers-load-more-btn');
  if (!footer || !counter) return;
  counter.textContent = `Showing ${allOrganizers.length} of ${_orgsTotal} organizer${_orgsTotal !== 1 ? 's' : ''}`;
  footer.style.display = _orgsTotal > 0 ? '' : 'none';
  if (btn) btn.style.display = allOrganizers.length < _orgsTotal ? '' : 'none';
}

function openAddModal() {
  editingId = null;
  document.getElementById('organizer-modal-title').textContent = 'Add organizer';
  ['name','email','phone','website','city','country','comment'].forEach(f => {
    const el = document.getElementById(`om-${f}`); if (el) el.value = '';
  });
  document.getElementById('om-type').value = '';
  document.getElementById('om-delete-btn').style.display = 'none';
  document.getElementById('om-gigs-section').style.display = 'none';
  setStatus('om-status-msg', '');
  openModal('organizer-modal');
}

function openEditModal(id) {
  const o = allOrganizers.find(x => x.id === id);
  if (!o) return;
  editingId = id;
  document.getElementById('organizer-modal-title').textContent = 'Edit organizer';
  document.getElementById('om-name').value    = o.name    || '';
  document.getElementById('om-type').value    = o.type    || '';
  document.getElementById('om-email').value   = o.email   || '';
  document.getElementById('om-phone').value   = o.phone   || '';
  document.getElementById('om-website').value = o.website || '';
  document.getElementById('om-city').value    = o.city    || '';
  document.getElementById('om-country').value = o.country || '';
  document.getElementById('om-comment').value = o.comment || '';
  document.getElementById('om-delete-btn').style.display = o.deleted ? 'none' : '';
  setStatus('om-status-msg', '');
  renderOrganizerGigs(id, o.name);
  openModal('organizer-modal');
}

var _orgRefsCache = {};

function closeOrgModal() { delete _orgRefsCache[editingId]; closeModal('organizer-modal'); }

async function renderOrganizerGigs(orgId, orgName) {
  const section = document.getElementById('om-gigs-section');
  const list    = document.getElementById('om-gigs-list');
  section.style.display = '';
  list.innerHTML = '<span style="color:var(--third-color);font-size:0.82rem;">Loading…</span>';

  if (!_orgRefsCache[orgId]) {
    try {
      const r = await fetch(`/api/${artistSlug}/organizers/${orgId}?refs=1`);
      if (!r.ok) throw new Error(r.status);
      _orgRefsCache[orgId] = await r.json();
    } catch {
      list.innerHTML = '<span style="color:#e55;font-size:0.82rem;">Could not load gigs.</span>';
      return;
    }
  }
  const { refs } = _orgRefsCache[orgId];

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
    'onclick="event.preventDefault();closeOrgModal();navigate(\'/gigs?organizer=' + encodeURIComponent(orgName) + '\')">' +
    '→ All ' + n + ' gig' + (n !== 1 ? 's' : '') + ' by this organizer' +
  '</a>';
}

async function saveOrganizer() {
  const body = {
    name:    document.getElementById('om-name').value.trim(),
    type:    document.getElementById('om-type').value    || null,
    email:   document.getElementById('om-email').value.trim()   || null,
    phone:   document.getElementById('om-phone').value.trim()   || null,
    website: document.getElementById('om-website').value.trim() || null,
    city:    document.getElementById('om-city').value.trim()    || null,
    country: document.getElementById('om-country').value.trim() || null,
    comment: document.getElementById('om-comment').value.trim() || null,
  };
  setStatus('om-status-msg', 'Saving…');
  const url = editingId ? `/api/${artistSlug}/organizers/${editingId}` : `/api/${artistSlug}/organizers`;
  const r   = await apiFetch(url, editingId ? 'PUT' : 'POST', body);
  const json = await r.json();
  if (!r.ok) { setStatus('om-status-msg', json.error || 'Error', true); return; }
  if (editingId) delete _orgRefsCache[editingId];
  closeOrgModal();
  _orgsOffset = 0;
  await loadOrganizers();
}

async function softDeleteOrganizer() {
  if (!editingId) return;
  const r = await apiFetch(`/api/${artistSlug}/organizers/${editingId}`, 'DELETE', {});
  if (r.ok) { closeOrgModal(); _orgsOffset = 0; await loadOrganizers(); }
}

async function promptHardDelete(id) {
  hardDeleteId = id;
  const r = await fetch(`/api/${artistSlug}/organizers/${id}?refs=1`);
  const { refs } = await r.json();
  const gigCount = refs.gigs.length;
  document.getElementById('hd-refs-msg').textContent = gigCount > 0
    ? `This organizer is linked to ${gigCount} gig(s).`
    : 'This organizer has no linked gigs.';
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
  const r = await apiFetch(`/api/${artistSlug}/organizers/${hardDeleteId}`, 'DELETE', { hard: true, cascade });
  if (r.ok) { closeHardDeleteModal(); _orgsOffset = 0; await loadOrganizers(); }
  else { const j = await r.json(); setStatus('hd-status', j.error || 'Error', true); }
}
