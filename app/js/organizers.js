var artistSlug = '';
var allOrganizers = [];
var editingId = null;

var organizerTable;

var _orgsTotal = 0;
var _orgsOffset = 0;
var _orgsQ = '';
var _orgsTimer = null;

var ORGANIZER_COLUMNS = [
  { field: 'name',    get label() { return t('venues.colName'); },    width: '1.5fr', sortable: true, filterable: true },
  { field: 'type',    get label() { return t('organizers.fieldType'); },    width: '90px',  sortable: true,
    render: o => o.type ? `<span class="sl-badge">${escHtml(o.type)}</span>` : '' },
  { field: 'city',    get label() { return t('venues.colCity'); },    width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'country', get label() { return t('venues.colCountry'); }, width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'email',   get label() { return t('venues.fieldEmail'); }, width: '1fr',   sortable: true, filterable: true, muted: true },
  { width: 'auto', actions: true, render: function(o) {
    if (o.deleted) return '<span class="sl-deleted-badge">' + t('gigs.deletedBadge') + '</span>';
    return '<button class="btn sl-edit-btn" title="' + t('organizers.editBtnTitle') + '" onclick="event.stopPropagation();openEditModal(' + o.id + ')">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/></svg></button>';
  }},
];

initPage(async function(cfg) {
  artistSlug = cfg.slug;

  organizerTable = createSortableList({
    containerId:   'organizers-list',
    sortBarId:     'sort-bar',
    columns:       ORGANIZER_COLUMNS,
    defaultSort:   'name',
    rowClass:      o => o.deleted ? 'deleted' : '',
    onExpand:      o => expandOrganizer(o),
    emptyHint:     t('organizers.noOrganizersYet'),
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

  initGeoFields('om-city', 'om-country');
  onEnterSave(document.getElementById('organizer-modal'), saveOrganizer);

  var _orgDeepId = Number(new URLSearchParams(location.search).get('id'));
  if (_orgDeepId) openEditModal(_orgDeepId);
  else { openDeepLinkedRow('open'); }
});

async function loadOrganizers() {
  const params = new URLSearchParams({ limit: 50, offset: _orgsOffset });
  if (_orgsQ) params.set('q', _orgsQ);
  const r = await apiFetch(`/api/${artistSlug}/organizers?${params}`);
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
  counter.textContent = t(_orgsTotal !== 1 ? 'organizers.showing_other' : 'organizers.showing_one', { shown: allOrganizers.length, total: _orgsTotal });
  footer.style.display = _orgsTotal > 0 ? '' : 'none';
  if (btn) btn.style.display = allOrganizers.length < _orgsTotal ? '' : 'none';
}

function openAddModal() {
  editingId = null;
  document.getElementById('organizer-modal-title').textContent = t('organizers.addTitle');
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
  document.getElementById('organizer-modal-title').textContent = t('organizers.editTitle');
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

async function expandOrganizer(o) {
  if (!_orgRefsCache[o.id]) {
    try {
      const r = await apiFetch('/api/' + artistSlug + '/organizers/' + o.id + '?refs=1');
      if (!r.ok) throw new Error(r.status);
      _orgRefsCache[o.id] = await r.json();
    } catch {
      return '<span style="color:#e55;font-size:0.82rem;">' + t('venues.couldNotLoadGigs') + '</span>';
    }
  }
  const refs = _orgRefsCache[o.id].refs;
  if (!refs.gigs.length) {
    return '<div class="expansion-label">' + t('organizers.gigsOrganised') + '</div>' +
      '<span style="color:var(--third-color);font-size:0.82rem;">' + t('venues.noGigsYet') + '</span>';
  }
  var n = refs.gigs.length;
  var rows = refs.gigs.slice(0, 10).map(function(g) {
    var venue = g.venue_name
      ? ' <span style="color:var(--third-color)">@ ' + escHtml(g.venue_name) + (g.venue_city ? ', ' + escHtml(g.venue_city) : '') + '</span>'
      : '';
    return '<div style="padding:0.1rem 0;font-size:0.82rem;">' +
      (g.date ? escHtml(String(g.date).slice(0, 10)) + ' — ' : '') +
      escHtml(g.title) + venue + '</div>';
  }).join('');
  var link = '<a class="expansion-more-link" href="#" onclick="event.preventDefault();navigate(\'/gigs?organizer=' +
    encodeURIComponent(o.name).replace(/'/g, '%27') + '\')">' + t(n !== 1 ? 'organizers.allGigsLink_other' : 'organizers.allGigsLink_one', { n: n }) + '</a>';
  return '<div class="expansion-label">' + t('organizers.gigsOrganised') + '</div>' + rows + link;
}

function deleteOrgFromPopup() {
  var id = editingId;
  closeOrgModal();
  openHardDeleteModal({
    title: t('organizers.deleteTitle'),
    refsUrl: '/api/' + artistSlug + '/organizers/' + id + '?refs=1',
    deleteUrl: '/api/' + artistSlug + '/organizers/' + id,
    buildRefsMsg: function(refs) {
      return refs.gigs.length > 0
        ? t('organizers.linkedGigs', { n: refs.gigs.length })
        : t('organizers.noLinkedGigs');
    },
    buildCascadeOpts: function(refs) {
      if (!refs.gigs.length) return '';
      return '<label><input type="checkbox" id="hd-cascade-gigs"> ' + t('organizers.deleteCascadeGigs', { n: refs.gigs.length }) + '</label><br>' +
        '<label><input type="checkbox" id="hd-cascade-setlists"> ' + t('organizers.deleteCascadeSetlists') + '</label>';
    },
    getCascade: function() {
      var c = [];
      if (document.getElementById('hd-cascade-gigs')?.checked)     c.push('gigs');
      if (document.getElementById('hd-cascade-setlists')?.checked) c.push('setlists');
      return c;
    },
    onSuccess: async function() { _orgsOffset = 0; await loadOrganizers(); },
  });
}

async function renderOrganizerGigs(orgId, orgName) {
  const section = document.getElementById('om-gigs-section');
  const list    = document.getElementById('om-gigs-list');
  section.style.display = '';
  list.innerHTML = skeletonHtml(2);

  if (!_orgRefsCache[orgId]) {
    try {
      const r = await apiFetch(`/api/${artistSlug}/organizers/${orgId}?refs=1`);
      if (!r.ok) throw new Error(r.status);
      _orgRefsCache[orgId] = await r.json();
    } catch {
      list.innerHTML = '<span style="color:#e55;font-size:0.82rem;">' + t('venues.couldNotLoadGigs') + '</span>';
      return;
    }
  }
  const { refs } = _orgRefsCache[orgId];

  if (!refs.gigs.length) {
    list.innerHTML = '<span style="color:var(--third-color);font-size:0.82rem;">' + t('venues.noGigsYet') + '</span>';
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
    'onclick="event.preventDefault();closeOrgModal();navigate(\'/gigs?organizer=' + encodeURIComponent(orgName).replace(/'/g, '%27') + '\')">' +
    t(n !== 1 ? 'organizers.allGigsLink_other' : 'organizers.allGigsLink_one', { n: n }) +
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
  setStatus('om-status-msg', t('venues.savingMsg'));
  const url = editingId ? `/api/${artistSlug}/organizers/${editingId}` : `/api/${artistSlug}/organizers`;
  const r   = await apiFetch(url, editingId ? 'PUT' : 'POST', body);
  const json = await r.json();
  if (!r.ok) { setStatus('om-status-msg', json.error || t('gigs.errorFallback'), true); return; }
  if (editingId) delete _orgRefsCache[editingId];
  closeOrgModal();
  _orgsOffset = 0;
  await loadOrganizers();
}

