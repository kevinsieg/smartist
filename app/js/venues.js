// `value` is the data value stored in the DB and used as the filter/select key — never
// translated. Only the user-visible `label` is translated (re-evaluated per render).
window.VENUE_STATUSES = [
  { value: 'prospect',  get label() { return t('venues.statusProspect'); } },
  { value: 'contacted', get label() { return t('venues.statusContacted'); } },
  { value: 'confirmed', get label() { return t('venues.statusConfirmed'); } },
  { value: 'active',    get label() { return t('venues.statusActive'); } },
  { value: 'declined',  get label() { return t('venues.statusDeclined'); } },
];

window.VENUE_CATEGORIES = [
  { value: 'association',  get label() { return t('venues.categoryAssociation'); } },
  { value: 'club',         get label() { return t('venues.categoryClub'); } },
  { value: 'festival',     get label() { return t('venues.categoryFestival'); } },
  { value: 'placeholder',  get label() { return t('venues.categoryPlaceholder'); } },
  { value: 'private',      get label() { return t('venues.categoryPrivate'); } },
  { value: 'pub',          get label() { return t('venues.categoryPub'); } },
  { value: 'restaurant',   get label() { return t('venues.categoryRestaurant'); } },
  { value: 'street',       get label() { return t('venues.categoryStreet'); } },
];

var VENUE_STATUSES   = window.VENUE_STATUSES;
var VENUE_CATEGORIES = window.VENUE_CATEGORIES;

function _venueStatusLabel(value) {
  var s = VENUE_STATUSES.find(function(x) { return x.value === value; });
  return s ? s.label : value;
}

function populateSelects() {
  function fill(id, items) {
    var el = document.getElementById(id);
    if (!el) return;
    items.forEach(function(c) {
      el.insertAdjacentHTML('beforeend', '<option value="' + c.value + '">' + c.label + '</option>');
    });
  }
  fill('filter-status',   VENUE_STATUSES);
  fill('filter-category', VENUE_CATEGORIES);
  fill('vm-status',       VENUE_STATUSES);
  fill('vm-category',     VENUE_CATEGORIES);
}

// ── Duplicate detection ────────────────────────────────────────────────────

function _venueNormName(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function _sortWords(s) {
  return s.split(' ').filter(Boolean).sort().join(' ');
}

function _levenshtein(a, b) {
  var m = a.length, n = b.length;
  var dp = [];
  for (var i = 0; i <= m; i++) { dp[i] = [i]; }
  for (var j = 0; j <= n; j++) { dp[0][j] = j; }
  for (var i = 1; i <= m; i++)
    for (var j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// Soundex: English/French phonetic encoding. "Smith"/"Smyth"→S530, "Jon"/"John"→J500.
function _soundex(word) {
  var TABLE = {b:1,f:1,p:1,v:1, c:2,g:2,j:2,k:2,q:2,s:2,x:2,z:2, d:3,t:3, l:4, m:5,n:5, r:6};
  var s = word.replace(/[^a-z]/g, '');
  if (!s) return '';
  var code = s[0].toUpperCase(), prev = TABLE[s[0]] || 0;
  for (var i = 1; i < s.length && code.length < 4; i++) {
    var c = TABLE[s[i]];
    if (c && c !== prev) code += c;
    if (s[i] !== 'h' && s[i] !== 'w') prev = c || 0;
  }
  while (code.length < 4) code += '0';
  return code;
}

// Cologne Phonetics (Kölner Phonetik): designed for German.
// "Meyer"/"Meier"→07, "Schmidt"/"Schmitt"→863, "Müller"/"Mueller"→657.
function _cologne(word) {
  var s = word.toUpperCase()
    .replace(/Ä/g,'A').replace(/Ö/g,'O').replace(/Ü/g,'U')
    .replace(/ß/g,'SS').replace(/[^A-Z]/g,'');
  if (!s) return '';
  var raw = [];
  for (var i = 0; i < s.length; i++) {
    var ch = s[i], prev = s[i-1] || '', next = s[i+1] || '', c;
    switch (ch) {
      case 'A': case 'E': case 'I': case 'J': case 'O': case 'U': case 'Y': c = '0'; break;
      case 'H':  c = '';  break;
      case 'B':  c = '1'; break;
      case 'P':  c = next === 'H' ? '3' : '1'; break;
      case 'D': case 'T': c = 'CSZ'.indexOf(next) >= 0 ? '8' : '2'; break;
      case 'F': case 'V': case 'W': c = '3'; break;
      case 'G': case 'K': case 'Q': c = '4'; break;
      case 'C':
        if (i === 0) c = 'AHKLOQRUX'.indexOf(next) >= 0 ? '4' : '8';
        else if ('SZ'.indexOf(prev) >= 0) c = '8';
        else c = 'AHKOQUX'.indexOf(next) >= 0 ? '4' : '8';
        break;
      case 'X':  c = 'CKQ'.indexOf(prev) >= 0 ? '8' : '48'; break;
      case 'L':  c = '5'; break;
      case 'M': case 'N': c = '6'; break;
      case 'R':  c = '7'; break;
      case 'S': case 'Z': c = '8'; break;
      default:   c = '';
    }
    if (c) { for (var k = 0; k < c.length; k++) raw.push(c[k]); }
  }
  return raw
    .filter(function(c, i) { return c !== raw[i - 1]; })
    .filter(function(c, i) { return i === 0 || c !== '0'; })
    .join('');
}

// Articles/prepositions that carry no disambiguation value.
var _STOP = {
  le:1,la:1,les:1,de:1,du:1,des:1,au:1,aux:1,l:1,d:1,et:1,en:1,a:1,  // French
  the:1,at:1,of:1,                                                       // English
  der:1,die:1,das:1,dem:1,den:1,am:1,an:1,im:1,in:1,von:1,vor:1,       // German
  zu:1,zum:1,zur:1,bei:1,
};

// Returns Soundex key (EN/FR) and Cologne key (DE). Matching on either counts.
function _phoneticKeys(normed) {
  var words = normed.split(' ').filter(function(w) { return w.length > 1 && !_STOP[w]; });
  if (!words.length) return { sdx: '', col: '' };
  return {
    sdx: words.map(_soundex).sort().join(' '),
    col: words.map(_cologne).sort().join(' '),
  };
}

function _venuesSimilar(na, nb) {
  if (!na || !nb) return false;
  var maxLen = Math.max(na.length, nb.length);
  var sa = _sortWords(na), sb = _sortWords(nb);
  var ka = _phoneticKeys(na), kb = _phoneticKeys(nb);
  return na === nb
    || sa === sb                               // same words, different order
    || (ka.sdx && ka.sdx === kb.sdx)           // Soundex match (EN/FR)
    || (ka.col && ka.col === kb.col)           // Cologne match (DE)
    || na.includes(nb) || nb.includes(na)
    || _levenshtein(na, nb) / maxLen < 0.25
    || _levenshtein(sa, sb) / maxLen < 0.25;
}

function findVenueDuplicate(name, excludeId) {
  var na = _venueNormName(name);
  if (!na) return null;
  return allVenues.find(function(v) {
    if (v.deleted || v.id === excludeId) return false;
    return _venuesSimilar(na, _venueNormName(v.name));
  }) || null;
}

var _dupCheckTimer = null;

function checkVenueDuplicate() {
  clearTimeout(_dupCheckTimer);
  _dupCheckTimer = setTimeout(function() {
    var name  = document.getElementById('vm-name').value.trim();
    var msgEl = document.getElementById('vm-dup-warning');
    if (!msgEl) return;
    var match = name.length > 1 ? findVenueDuplicate(name, editingId) : null;
    if (match) {
      msgEl.innerHTML = t('venues.possibleDuplicate') + ' <strong>' + escHtml(match.name) + '</strong>'
        + (match.city ? ' (' + escHtml(match.city) + ')' : '')
        + ' — <a href="#" onclick="event.preventDefault();closeVenueModal();openEditModal(' + match.id + ')">' + t('venues.openLink') + '</a>';
      msgEl.style.display = '';
    } else {
      msgEl.style.display = 'none';
    }
  }, 300);
}

function _buildGeoQuery() {
  var parts = [
    document.getElementById('vm-street-number')?.value.trim(),
    document.getElementById('vm-street')?.value.trim(),
    document.getElementById('vm-city')?.value.trim(),
    document.getElementById('vm-postcode')?.value.trim(),
    document.getElementById('vm-country')?.value.trim(),
  ].filter(Boolean);
  return parts.join(' ');
}

function _showGeoPreview(lat, lng) {
  _pendingLat = lat;
  _pendingLng = lng;
  _geocodeAccepted = true;
  var previewEl = document.getElementById('vm-geocode-preview');
  if (!previewEl) return;
  previewEl.style.display = '';
  window.loadLeaflet(function() {
    var mapEl = document.getElementById('vm-geocode-map');
    if (!mapEl) return;
    if (_previewMap) {
      _previewMap.setView([lat, lng], 13);
      if (_previewMarker) _previewMarker.setLatLng([lat, lng]);
      return;
    }
    _previewMap = L.map(mapEl, { zoomControl: true, attributionControl: false }).setView([lat, lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(_previewMap);
    _previewMarker = L.circleMarker([lat, lng], { radius: 7, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.9 }).addTo(_previewMap);
    setTimeout(function() { _previewMap.invalidateSize(); }, 50);
  });
}

function _hideGeoPreview() {
  var previewEl = document.getElementById('vm-geocode-preview');
  if (previewEl) previewEl.style.display = 'none';
  if (_previewMap) { _previewMap.remove(); _previewMap = null; _previewMarker = null; }
}

function _triggerGeocode() {
  clearTimeout(_geocodeTimer);
  var query = _buildGeoQuery();
  if (!query) return;
  _geocodeTimer = setTimeout(function() {
    window.geocodeAddress(query).then(function(result) {
      if (result) {
        _showGeoPreview(result.lat, result.lng);
      }
    });
  }, 600);
}

function reGeocodeVenue() {
  _geocodeAccepted = false;
  _hideGeoPreview();
  _triggerGeocode();
}

function discardGeocode() {
  _pendingLat = null;
  _pendingLng = null;
  _geocodeAccepted = false;
  _hideGeoPreview();
}

var artistSlug = '';
var allVenues = [];
var editingId = null;

var venueTable;
var placeholderTable;

var _venuesTotal = 0;
var _venuesOffset = 0;
var _venuesQ = '';
var _venuesStatus = '';
var _venuesCategory = '';
var _venuesCountry = '';
var _venuesTimer = null;
var _pendingLat = null;
var _pendingLng = null;
var _geocodeAccepted = false;
var _previewMap = null;
var _previewMarker = null;
var _geocodeTimer = null;
var _venueActiveTab = 'list';
var _mapReady = false;

function _showMapContainers() {
  window.scrollTo(0, 0);
  var searchEl = document.getElementById('map-search-bar');
  var tabsEl   = document.getElementById('venues-tabs');
  var mapEl    = document.getElementById('map-view');

  // Anchor below the sticky tabs (which visually sit below the fixed nav bar).
  // getBoundingClientRect().bottom returns the visual viewport position, accounting
  // for sticky offset — which is what we need for position:fixed children.
  var anchor = 0;
  if (tabsEl && tabsEl.offsetHeight > 0) {
    anchor = tabsEl.getBoundingClientRect().bottom;
  } else {
    var hdr = document.querySelector('.app-header');
    if (hdr) anchor = hdr.getBoundingClientRect().bottom;
  }

  if (searchEl) {
    searchEl.style.top = anchor + 'px';
    searchEl.style.display = '';
    anchor += searchEl.getBoundingClientRect().height; // force reflow to get actual height
  }
  if (mapEl) {
    mapEl.style.top = anchor + 'px';
    mapEl.style.display = 'flex';
  }
}

function _hideMapContainers() {
  var searchEl = document.getElementById('map-search-bar');
  var mapEl    = document.getElementById('map-view');
  if (searchEl) searchEl.style.display = 'none';
  if (mapEl)    mapEl.style.display    = 'none';
}

function switchVenueTab(view) {
  _venueActiveTab = view;
  history.pushState(null, '', view === 'map' ? '/venues?view=map' : '/venues');
  document.querySelectorAll('#venues-tabs .setlist-tab').forEach(function(t) {
    t.classList.toggle('setlist-tab--active', t.dataset.tab === view);
  });
  var listEl = document.getElementById('venues-list-view');
  if (listEl) listEl.style.display = view === 'map' ? 'none' : '';
  if (view === 'map') {
    _showMapContainers();
    if (!_mapReady) {
      _mapReady = true;
      if (window.initMap) window.initMap(artistSlug);
    } else if (window.showMap) {
      window.showMap();
    }
  } else {
    _hideMapContainers();
  }
}

var VENUE_COLUMNS = [
  { field: 'name',    get label() { return t('venues.colName'); },     width: '1.5fr', sortable: true, filterable: true },
  { field: 'postcode',get label() { return t('venues.colPostcode'); }, width: '90px',  sortable: true, filterable: true, muted: true },
  { field: 'city',    get label() { return t('venues.colCity'); },     width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'country', get label() { return t('venues.colCountry'); },  width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'size',    get label() { return t('venues.colCapacity'); }, width: '70px',  sortable: true, type: 'number',   muted: true },
  { field: 'status',  get label() { return t('venues.colStatus'); },   width: '90px',
    render: v => v.status ? `<span class="sl-badge">${escHtml(_venueStatusLabel(v.status))}</span>` : '' },
  { width: 'auto', actions: true, render: function(v) {
    if (v.deleted)                    return '<span class="sl-deleted-badge">' + t('venues.deletedBadge') + '</span>';
    if (v.category === 'placeholder') return '';
    if (isViewMode())                 return '';  // read-only: every mutation 401s
    return '<button class="btn sl-edit-btn" title="' + t('venues.editTitle') + '" onclick="event.stopPropagation();openEditModal(' + v.id + ')">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/></svg></button>';
  }},
];

initPage(async function(cfg) {
  populateSelects();
  artistSlug = cfg.slug;

  var tabsEl = document.getElementById('venues-tabs');
  if (tabsEl) {
    tabsEl.style.display = '';
    var hdr = document.querySelector('.app-header');
    if (hdr) document.documentElement.style.setProperty('--venues-tabs-top', hdr.getBoundingClientRect().height + 'px');
  }
  var initView = new URLSearchParams(location.search).get('view') || 'list';
  if (initView === 'map') {
    var listEl = document.getElementById('venues-list-view');
    if (listEl) listEl.style.display = 'none';
    _venueActiveTab = 'map';
    document.querySelectorAll('#venues-tabs .setlist-tab').forEach(function(t) {
      t.classList.toggle('setlist-tab--active', t.dataset.tab === 'map');
    });
    _showMapContainers();
    _mapReady = true;
    if (window.initMap) window.initMap(artistSlug);
    else window._pendingMapSlug = artistSlug;
  }

  venueTable = createSortableList({
    containerId:    'venues-list',
    sortBarId:      'sort-bar',
    columns:        VENUE_COLUMNS,
    defaultSort:    'name',
    rowClass:       v => v.deleted ? 'deleted' : '',
    onRowClick:     v => { if (!v.deleted) openVenueGigsModal(v); },
    emptyHint:      t('venues.noVenuesYet'),
  });

  placeholderTable = createSortableList({
    containerId: 'placeholder-list',
    columns:     VENUE_COLUMNS,
    defaultSort: 'name',
    rowClass:    v => v.deleted ? 'deleted' : '',
    onRowClick:  v => { if (!v.deleted) openVenueGigsModal(v); },
    emptyHint:   t('venues.none'),
  });

  const filterEl   = document.getElementById('filter-input');
  const statusEl   = document.getElementById('filter-status');
  const categoryEl = document.getElementById('filter-category');

  if (filterEl) {
    filterEl.addEventListener('input', function() {
      clearTimeout(_venuesTimer);
      _venuesTimer = setTimeout(async function() {
        if (!_confirmDiscardBulk()) return;
        _venuesQ = filterEl.value.trim();
        _venuesOffset = 0;
        await loadVenues();
      }, 300);
    });
  }

  if (statusEl) {
    statusEl.addEventListener('change', async function() {
      if (!_confirmDiscardBulk()) return;
      _venuesStatus = statusEl.value;
      _venuesOffset = 0;
      await loadVenues();
    });
  }

  if (categoryEl) {
    categoryEl.addEventListener('change', async function() {
      if (!_confirmDiscardBulk()) return;
      _venuesCategory = categoryEl.value;
      _venuesOffset = 0;
      await loadVenues();
    });
  }

  var countryEl = document.getElementById('filter-country');
  if (countryEl) {
    countryEl.addEventListener('change', async function() {
      if (!_confirmDiscardBulk()) return;
      _venuesCountry = countryEl.value;
      _venuesOffset = 0;
      await loadVenues();
    });
  }

  // Put the right skeleton on screen before the first request answers — otherwise the
  // list view renders first and visibly flips to the bulk table a moment later.
  renderVenueBulk();
  _renderLetterBar();

  await loadVenues();

  initGeoFields('vm-city', 'vm-country', 'vm-postcode');
  ['vm-city', 'vm-country', 'vm-street', 'vm-postcode'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('blur', _triggerGeocode);
  });
  onEnterSave(document.getElementById('venue-modal'), saveVenue);

  var _venueDeepId = Number(new URLSearchParams(location.search).get('id'));
  if (_venueDeepId) openEditModal(_venueDeepId);
  else { openDeepLinkedRow('open'); }
});

async function openVenueFromMap(id) {
  switchVenueTab('list');
  if (allVenues.find(function(v) { return v.id === id; })) {
    setTimeout(function() { openEditModal(id); }, 100);
    return;
  }
  // Venue not in current paginated load — fetch it directly
  try {
    const r = await apiFetch('/api/' + artistSlug + '/venues/' + id + '?refs=1');
    if (!r.ok) return;
    const data = await r.json();
    allVenues.push(data.venue);
    setTimeout(function() { openEditModal(id); }, 100);
  } catch {}
}

// ── Bulk edit (CRM fields) ────────────────────────────────────────────────
// Spreadsheet-style editing of the fields that change while booking. Name, address
// and contact data stay in the modal. Saving sends one PATCH for all changed rows.

var VENUE_BULK_KEY = 'venues_bulk_edit';
var _venueDirty = new Set();
var _venueBulkSortState = { field: 'name', dir: 1 };
var _venuesPageSize = 0;   // read lazily: this file is also evaluated without a DOM in tests
var _venuesLetter = '';

// Anything that reloads the table throws away unsaved edits — ask first, every time.
function _confirmDiscardBulk() {
  if (!_venueDirty.size) return true;
  if (!confirm(t('venues.bulkDiscardConfirm'))) return false;
  _venueDirty.clear();
  return true;
}

var BULK_COLUMNS = [
  { field: 'name',               get label() { return t('venues.colName'); },           type: 'ro',     sortable: true },
  { field: 'city',               get label() { return t('venues.colCity'); },           type: 'ro',     sortable: true },
  { field: 'status',             get label() { return t('venues.colStatus'); },         type: 'select', sortable: true, options: function() { return VENUE_STATUSES; } },
  { field: 'category',           get label() { return t('venues.fieldCategory'); },     type: 'select', sortable: true, options: function() { return VENUE_CATEGORIES; } },
  { field: 'last_communication', get label() { return t('venues.colLastContact'); },    type: 'date',   sortable: true },
  { field: 'booking_channel',    get label() { return t('venues.colBookingChannel'); }, type: 'select', options: function() { return BOOKING_CHANNELS; } },
  { field: 'deadline',           get label() { return t('venues.colDeadline'); },       type: 'date',   sortable: true },
  { field: 'remuneration',       get label() { return t('venues.colRemuneration'); },   type: 'text' },
  { field: 'season',             get label() { return t('venues.colSeason'); },         type: 'text',   sortable: true },
  { field: 'preferred_period',   get label() { return t('venues.colPreferredPeriod'); },type: 'text',   sortable: true },
  { field: 'comment',            get label() { return t('venues.colComment'); },        type: 'text' },
];

var BOOKING_CHANNELS = [
  { value: 'email',           get label() { return t('venues.channelEmail'); } },
  { value: 'contactForm',     get label() { return t('venues.channelContactForm'); } },
  { value: 'applicationForm', get label() { return t('venues.channelApplicationForm'); } },
  { value: 'facebook',        get label() { return t('venues.channelFacebook'); } },
  { value: 'phone',           get label() { return t('venues.channelPhone'); } },
];

function isVenueBulkEdit() {
  return localStorage.getItem(VENUE_BULK_KEY) === '1' && !isMobile() && !isViewMode();
}

function toggleVenueBulkEdit() {
  if (!_confirmDiscardBulk()) return;
  if (isVenueBulkEdit()) localStorage.removeItem(VENUE_BULK_KEY);
  else                   localStorage.setItem(VENUE_BULK_KEY, '1');
  renderVenueBulk();
}

async function sortVenueBulk(field) {
  if (!_confirmDiscardBulk()) return;
  if (_venueBulkSortState.field === field) _venueBulkSortState.dir = -_venueBulkSortState.dir;
  else _venueBulkSortState = { field: field, dir: 1 };
  // Sorting happens in the DB so it covers every venue, not just the page on screen.
  _venuesOffset = 0;
  await loadVenues();
}

function _bulkCell(v, col) {
  var raw = v[col.field];
  var value = raw == null ? '' : String(raw);
  if (col.type === 'ro') return escHtml(value);
  if (col.type === 'date') {
    return '<input type="date" data-field="' + col.field + '" value="' + escHtml(value.slice(0, 10)) + '">';
  }
  if (col.type === 'select') {
    return '<select data-field="' + col.field + '"><option value=""></option>' +
      col.options().map(function(o) {
        return '<option value="' + escHtml(o.value) + '"' + (o.value === value ? ' selected' : '') + '>' + escHtml(o.label) + '</option>';
      }).join('') +
      // keep a stored value the list does not know, so saving cannot silently drop it
      (value && !col.options().some(function(o) { return o.value === value; })
        ? '<option value="' + escHtml(value) + '" selected>' + escHtml(value) + '</option>' : '') +
      '</select>';
  }
  return '<input type="text" data-field="' + col.field + '" value="' + escHtml(value) + '">';
}

function renderVenueBulk() {
  var bulkEl = document.getElementById('venues-bulk');
  var on     = isVenueBulkEdit();
  document.body.classList.toggle('venues-bulk', on);
  [document.getElementById('sort-bar'),
   document.getElementById('venues-list'),
   document.querySelector('.placeholder-section')].forEach(function(el) {
    if (el) el.style.display = on ? 'none' : '';
  });
  var btn = document.getElementById('venue-bulk-btn');
  if (btn) btn.classList.toggle('active', on);
  if (!bulkEl) return;
  if (!on) { bulkEl.style.display = 'none'; bulkEl.innerHTML = ''; return; }

  var rows = allVenues.filter(function(v) { return !v.deleted && v.category !== 'placeholder'; });
  bulkEl.style.display = '';
  bulkEl.innerHTML =
    '<div class="toolbar">' +
      '<button class="btn active" id="venue-bulk-save" disabled>' + t('venues.saveBtn') + '</button>' +
      '<button class="btn" id="venue-bulk-discard" disabled>' + t('venues.bulkDiscard') + '</button>' +
      '<span class="status" id="venue-bulk-status"></span>' +
    '</div>' +
    '<div class="table-wrap"><table><thead><tr>' +
      BULK_COLUMNS.map(function(c) {
        var cls = 'col-' + c.field;
        if (!c.sortable) return '<th scope="col" class="' + cls + '">' + escHtml(c.label) + '</th>';
        var active = _venueBulkSortState.field === c.field;
        var asc    = _venueBulkSortState.dir === 1;
        var arrow  = active ? (asc ? ' ▲' : ' ▼') : '';
        return '<th scope="col" class="' + cls + ' bulk-sortable' + (active ? ' bulk-sorted' : '') + '"' +
               ' data-sort="' + c.field + '" aria-sort="' + (active ? (asc ? 'ascending' : 'descending') : 'none') + '">' +
               '<button type="button" class="th-sort-btn">' + escHtml(c.label) + arrow + '</button></th>';
      }).join('') +
    '</tr></thead><tbody>' +
      rows.map(function(v) {
        return '<tr data-id="' + v.id + '">' + BULK_COLUMNS.map(function(c) {
          return '<td class="col-' + c.field + '">' + _bulkCell(v, c) + '</td>';
        }).join('') + '</tr>';
      }).join('') +
    '</tbody></table></div>';

  bulkEl.querySelectorAll('th[data-sort]').forEach(function(th) {
    th.onclick = function() { sortVenueBulk(th.dataset.sort); };
  });
  // Property assignment, not addEventListener — renderVenueBulk() runs again after every load.
  bulkEl.oninput  = _onBulkInput;
  bulkEl.onchange = _onBulkInput;
  document.getElementById('venue-bulk-save').onclick = saveVenueBulk;
  document.getElementById('venue-bulk-discard').onclick = function() {
    _venueDirty.clear();
    renderVenueBulk();
  };
  _updateBulkButtons();
}

function _onBulkInput(e) {
  var row = e.target.closest('tr[data-id]');
  if (!row) return;
  _venueDirty.add(row.dataset.id);
  row.classList.add('dirty');
  _updateBulkButtons();
}

function _updateBulkButtons(msg) {
  var save    = document.getElementById('venue-bulk-save');
  var discard = document.getElementById('venue-bulk-discard');
  var status  = document.getElementById('venue-bulk-status');
  if (save)    save.disabled    = _venueDirty.size === 0;
  if (discard) discard.disabled = _venueDirty.size === 0;
  if (status)  status.textContent = msg !== undefined ? msg
    : (_venueDirty.size ? t('venues.bulkUnsaved', { n: _venueDirty.size }) : '');
}

async function saveVenueBulk() {
  if (!_venueDirty.size) return;
  var updates = [];
  _venueDirty.forEach(function(id) {
    var row = document.querySelector('#venues-bulk tr[data-id="' + id + '"]');
    if (!row) return;
    var update = { id: Number(id) };
    row.querySelectorAll('[data-field]').forEach(function(el) {
      update[el.dataset.field] = el.value.trim() === '' ? null : el.value.trim();
    });
    updates.push(update);
  });
  _updateBulkButtons(t('venues.savingMsg'));
  var json;
  try {
    var r = await apiFetch('/api/' + artistSlug + '/venues', 'PATCH', updates);
    json = await r.json().catch(function() { return {}; });
    if (!r.ok) { _updateBulkButtons(json.error || t('gigs.errorFallback')); return; }
  } catch (err) {
    _updateBulkButtons(t('venues.bulkSaveFailed'));
    return;
  }
  var rejected = json.rejected || [];
  // Re-read from the server so the table shows what was actually stored.
  _venueDirty.clear();
  _venuesOffset = 0;
  await loadVenues();
  _updateBulkButtons(rejected.length
    ? t('venues.bulkSavedWithErrors', { n: json.count || 0, failed: rejected.length })
    : t('venues.bulkSaved', { n: json.count || 0 }));
  if (rejected.length) {
    rejected.forEach(function(rej) {
      var row = document.querySelector('#venues-bulk tr[data-id="' + rej.id + '"]');
      if (row) { row.classList.add('bulk-row-error'); row.title = rej.error; }
    });
  }
}

function venuePageSize() {
  if (!_venuesPageSize) {
    try { _venuesPageSize = Number(localStorage.getItem('venues_page_size')) || 50; }
    catch { _venuesPageSize = 50; }
  }
  return _venuesPageSize;
}

async function loadVenues() {
  const params = new URLSearchParams({ limit: venuePageSize(), offset: _venuesOffset });
  if (_venuesQ)        params.set('q',        _venuesQ);
  if (_venuesStatus)   params.set('status',   _venuesStatus);
  if (_venuesCategory) params.set('category', _venuesCategory);
  if (_venuesCountry)  params.set('country',  _venuesCountry);
  if (_venuesLetter)   params.set('letter',   _venuesLetter);
  if (isVenueBulkEdit()) {
    params.set('sort', _venueBulkSortState.field);
    params.set('dir',  _venueBulkSortState.dir === 1 ? 'asc' : 'desc');
  }
  const r = await apiFetch(`/api/${artistSlug}/venues?${params}`);
  const { rows, total } = await r.json();
  _venuesTotal = total;
  allVenues = rows;   // one page at a time — paging replaced the append-on-scroll list
  placeholderTable.setData(allVenues.filter(v => v.category === 'placeholder'));
  venueTable.setData(allVenues.filter(v => v.category !== 'placeholder'));
  renderVenueBulk();
  updateVenuesFooter();
  _renderLetterBar();
  _populateCountryFilter();
}

var _venueCountries = null;

// Countries come from the whole workspace, not from allVenues — that holds one page.
async function _populateCountryFilter() {
  var el = document.getElementById('filter-country');
  if (!el) return;
  if (!_venueCountries) {
    try {
      var r = await apiFetch('/api/' + artistSlug + '/venues?facet=country');
      _venueCountries = r.ok ? await r.json() : [];
    } catch { _venueCountries = []; }
  }
  var selected = el.value;
  var countries = _venueCountries;
  el.innerHTML = '<option value="">' + t('venues.allCountries') + '</option>' +
    countries.map(function(c) {
      return '<option value="' + escHtml(c) + '"' + (c === selected ? ' selected' : '') + '>' + escHtml(c) + '</option>';
    }).join('');
}

async function gotoVenuePage(page) {
  if (!_confirmDiscardBulk()) return;
  const pages = Math.max(1, Math.ceil(_venuesTotal / venuePageSize()));
  const target = Math.min(Math.max(1, page), pages);
  _venuesOffset = (target - 1) * venuePageSize();
  await loadVenues();
  window.scrollTo({ top: 0 });
}

async function setVenuePageSize(size) {
  if (!_confirmDiscardBulk()) return;
  _venuesPageSize = Number(size) || 50;
  try { localStorage.setItem('venues_page_size', String(_venuesPageSize)); } catch {}
  _venuesOffset = 0;
  await loadVenues();
}

async function jumpToVenueLetter(letter) {
  if (!_confirmDiscardBulk()) return;
  _venuesLetter = letter === _venuesLetter ? '' : letter;
  _venuesOffset = 0;
  await loadVenues();
  _renderLetterBar();
}

function _renderLetterBar() {
  var bar = document.getElementById('venues-letters');
  if (!bar) return;
  var letters = ['#'].concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('venues.letterBarLabel'));
  var btn = function(value, label, aria) {
    var on = _venuesLetter === value;
    return '<button type="button" class="letter-btn' + (on ? ' letter-active' : '') + '"' +
           ' data-letter="' + escHtml(value) + '" aria-pressed="' + on + '"' +
           ' aria-label="' + escHtml(aria) + '">' + escHtml(label) + '</button>';
  };
  bar.innerHTML = btn('', t('venues.allLetters'), t('venues.allLetters')) +
    letters.map(function(l) {
      return btn(l, l, l === '#' ? t('venues.letterOther') : l);
    }).join('');
  bar.querySelectorAll('.letter-btn').forEach(function(btn) {
    btn.onclick = function() { jumpToVenueLetter(btn.dataset.letter); };
  });
}

function updateVenuesFooter() {
  const footer  = document.getElementById('venues-footer');
  const counter = document.getElementById('venues-counter');
  if (!footer || !counter) return;
  const pageSize = venuePageSize();
  const pages    = Math.max(1, Math.ceil(_venuesTotal / pageSize));
  const page     = Math.floor(_venuesOffset / pageSize) + 1;
  const from     = _venuesTotal === 0 ? 0 : _venuesOffset + 1;
  const to       = Math.min(_venuesOffset + allVenues.length, _venuesTotal);

  counter.textContent = t('venues.showingRange', { from: from, to: to, total: _venuesTotal });
  footer.style.display = _venuesTotal > 0 ? '' : 'none';

  const input = document.getElementById('venues-page-input');
  if (input) {
    input.value = page;
    input.max   = pages;
    input.onchange = function() { gotoVenuePage(Number(input.value)); };
  }
  const pageOf = document.getElementById('venues-page-of');
  if (pageOf) pageOf.textContent = t('venues.pageOf', { pages: pages });

  const sizeEl = document.getElementById('venues-page-size');
  if (sizeEl) {
    sizeEl.value = String(pageSize);
    sizeEl.onchange = function() { setVenuePageSize(sizeEl.value); };
  }

  const nav = { 'venues-first': 1, 'venues-prev': page - 1, 'venues-next': page + 1, 'venues-last': pages };
  Object.keys(nav).forEach(function(id) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = nav[id] === page || nav[id] < 1 || nav[id] > pages;
    btn.onclick = function() { gotoVenuePage(nav[id]); };
  });
}


function openAddModal() {
  editingId = null;
  document.getElementById('venue-modal-title').textContent = t('venues.addVenue');
  ['name','street-number','street','postcode','city','country','category','email','website','phone','contact-name','comment'].forEach(f => {
    const el = document.getElementById(`vm-${f}`); if (el) el.value = '';
  });
  document.getElementById('vm-status').value = '';
  document.getElementById('vm-delete-btn').style.display = 'none';
  document.getElementById('vm-gigs-section').style.display = 'none';
  document.getElementById('vm-dup-warning').style.display = 'none';
  setStatus('vm-status-msg', '');
  _pendingLat = null; _pendingLng = null; _geocodeAccepted = false; _hideGeoPreview();
  openModal('venue-modal');
}

function openEditModal(id) {
  const v = allVenues.find(x => x.id === id);
  if (!v) return;
  editingId = id;
  document.getElementById('venue-modal-title').textContent = t('venues.editVenue');
  document.getElementById('vm-name').value          = v.name          || '';
  document.getElementById('vm-street-number').value = v.street_number || '';
  document.getElementById('vm-street').value         = v.street        || '';
  document.getElementById('vm-postcode').value       = v.postcode      || '';
  document.getElementById('vm-city').value           = v.city          || '';
  document.getElementById('vm-country').value        = v.country       || '';
  document.getElementById('vm-status').value   = v.status        || '';
  document.getElementById('vm-category').value = v.category      || '';
  document.getElementById('vm-email').value    = v.generic_email || '';
  document.getElementById('vm-website').value  = v.website       || '';
  document.getElementById('vm-phone').value        = v.phone         || '';
  document.getElementById('vm-contact-name').value = v.contact_name  || '';
  document.getElementById('vm-comment').value  = v.comment       || '';
  document.getElementById('vm-delete-btn').style.display = (v.deleted || isViewMode()) ? 'none' : '';
  document.getElementById('vm-dup-warning').style.display = 'none';
  setStatus('vm-status-msg', '');
  _pendingLat = v.lat || null; _pendingLng = v.lng || null; _geocodeAccepted = !!(v.lat && v.lng);
  _hideGeoPreview();
  if (_geocodeAccepted) _showGeoPreview(v.lat, v.lng);
  renderVenueGigs(id, v.name);
  openModal('venue-modal');
}

function closeVenueModal() { delete _venueRefsCache[editingId]; closeModal('venue-modal'); }

var _venueRefsCache = {};

async function expandVenue(v) {
  if (!_venueRefsCache[v.id]) {
    try {
      const r = await apiFetch('/api/' + artistSlug + '/venues/' + v.id + '?refs=1');
      if (!r.ok) throw new Error(r.status);
      _venueRefsCache[v.id] = await r.json();
    } catch {
      return '<span style="color:#e55;font-size:0.82rem;">' + t('venues.couldNotLoadGigs') + '</span>';
    }
  }
  const refs = _venueRefsCache[v.id].refs;
  if (!refs.gigs.length) {
    return '<div class="expansion-label">' + t('venues.gigsAtVenueTitle') + '</div>' +
      '<span style="color:var(--third-color);font-size:0.82rem;">' + t('venues.noGigsYet') + '</span>';
  }
  var n = refs.gigs.length;
  var rows = refs.gigs.slice(0, 10).map(function(g) {
    return '<div style="padding:0.1rem 0;font-size:0.82rem;">' +
      (g.date ? escHtml(String(g.date).slice(0, 10)) + ' — ' : '') +
      escHtml(g.title) + '</div>';
  }).join('');
  var allGigsLabel = t(n !== 1 ? 'venues.allGigsLinkPlural' : 'venues.allGigsLink', { n: n });
  var link = '<a class="expansion-more-link" href="#" onclick="event.preventDefault();navigate(\'/gigs?venue=' +
    encodeURIComponent(v.name).replace(/'/g, '%27') + '\')">&#8594; ' + escHtml(allGigsLabel) + '</a>';
  return '<div class="expansion-label">' + t('venues.gigsAtVenueTitle') + '</div>' + rows + link;
}

function deleteVenueFromPopup() {
  var id = editingId;
  closeVenueModal();
  openHardDeleteModal({
    title: t('venues.deleteTitle'),
    refsUrl: '/api/' + artistSlug + '/venues/' + id + '?refs=1',
    deleteUrl: '/api/' + artistSlug + '/venues/' + id,
    buildRefsMsg: function(refs) {
      return refs.gigs.length > 0
        ? t('venues.deleteLinkedGigs', { n: refs.gigs.length })
        : t('venues.deleteNoGigs');
    },
    buildCascadeOpts: function(refs) {
      if (!refs.gigs.length) return '';
      return '<label><input type="checkbox" id="hd-cascade-gigs"> ' + t('venues.deleteCascadeGigs', { n: refs.gigs.length }) + '</label><br>' +
        '<label><input type="checkbox" id="hd-cascade-setlists"> ' + t('venues.deleteCascadeSetlists') + '</label>';
    },
    getCascade: function() {
      var c = [];
      if (document.getElementById('hd-cascade-gigs')?.checked)     c.push('gigs');
      if (document.getElementById('hd-cascade-setlists')?.checked) c.push('setlists');
      return c;
    },
    onSuccess: async function() { _venuesOffset = 0; await loadVenues(); },
  });
}

async function saveVenue() {
  const body = {
    name:          document.getElementById('vm-name').value.trim(),
    street_number: document.getElementById('vm-street-number').value.trim() || null,
    street:        document.getElementById('vm-street').value.trim()         || null,
    postcode:      document.getElementById('vm-postcode').value.trim()       || null,
    city:          document.getElementById('vm-city').value.trim()           || null,
    country:       document.getElementById('vm-country').value.trim()        || null,
    status:        document.getElementById('vm-status').value          || null,
    category:      document.getElementById('vm-category').value.trim() || null,
    generic_email: document.getElementById('vm-email').value.trim()    || null,
    website:       document.getElementById('vm-website').value.trim()  || null,
    phone:         document.getElementById('vm-phone').value.trim()        || null,
    contact_name:  document.getElementById('vm-contact-name').value.trim() || null,
    comment:       document.getElementById('vm-comment').value.trim()  || null,
    lat:  _geocodeAccepted ? _pendingLat : null,
    lng:  _geocodeAccepted ? _pendingLng : null,
  };
  setStatus('vm-status-msg', t('venues.savingMsg'));
  const url = editingId ? `/api/${artistSlug}/venues/${editingId}` : `/api/${artistSlug}/venues`;
  const r   = await apiFetch(url, editingId ? 'PUT' : 'POST', body);
  const json = await r.json();
  if (!r.ok) { setStatus('vm-status-msg', json.error || t('gigs.errorFallback'), true); return; }
  if (editingId) delete _venueRefsCache[editingId];
  closeVenueModal();
  _venuesOffset = 0;
  await loadVenues();
}

async function renderVenueGigs(venueId, venueName) {
  const section = document.getElementById('vm-gigs-section');
  const list    = document.getElementById('vm-gigs-list');
  section.style.display = '';
  list.innerHTML = skeletonHtml(2);

  if (!_venueRefsCache[venueId]) {
    try {
      const r = await apiFetch(`/api/${artistSlug}/venues/${venueId}?refs=1`);
      if (!r.ok) throw new Error(r.status);
      _venueRefsCache[venueId] = await r.json();
    } catch {
      list.innerHTML = '<span style="color:#e55;font-size:0.82rem;">' + t('venues.couldNotLoadGigs') + '</span>';
      return;
    }
  }
  const { refs } = _venueRefsCache[venueId];

  if (!refs.gigs.length) {
    list.innerHTML = '<span style="color:var(--third-color);font-size:0.82rem;">' + t('venues.noGigsYet') + '</span>';
    return;
  }

  var n = refs.gigs.length;
  var allGigsLabel = t(n !== 1 ? 'venues.allGigsLinkPlural' : 'venues.allGigsLink', { n: n });
  list.innerHTML = refs.gigs.map(function(g) {
    return '<div class="related-gig-item">' +
      (g.date ? escHtml(String(g.date).slice(0, 10)) + ' — ' : '') +
      escHtml(g.title) +
    '</div>';
  }).join('') +
  '<a class="related-link" href="#" style="display:block;margin-top:0.5rem;font-size:0.82rem" ' +
    'onclick="event.preventDefault();closeVenueModal();navigate(\'/gigs?venue=' + encodeURIComponent(venueName).replace(/'/g, '%27') + '\')">' +
    '→ ' + escHtml(allGigsLabel) +
  '</a>';
}

async function openVenueGigsModal(v) {
  var titleEl = document.getElementById('vgm-title');
  var body    = document.getElementById('vgm-body');
  if (!titleEl || !body) return;
  titleEl.textContent = v.name || t('venues.gigsAtVenueTitle');
  body.innerHTML = skeletonHtml(3);
  openModal('venue-gigs-modal');
  if (!_venueRefsCache[v.id]) {
    try {
      const r = await apiFetch('/api/' + artistSlug + '/venues/' + v.id + '?refs=1');
      if (!r.ok) throw new Error(r.status);
      _venueRefsCache[v.id] = await r.json();
    } catch {
      body.innerHTML = '<span style="color:#e55;font-size:0.85rem;">' + t('venues.couldNotLoadGigs') + '</span>';
      return;
    }
  }
  const refs = _venueRefsCache[v.id].refs;
  if (!refs.gigs.length) {
    body.innerHTML = '<span style="color:var(--third-color);font-size:0.85rem;">' + t('venues.noGigsYet') + '</span>';
    return;
  }
  body.innerHTML = refs.gigs.map(function(g) {
    return '<div class="expansion-row">' +
      '<span style="color:var(--third-color);font-size:0.82rem;min-width:6.5rem;flex-shrink:0;">' +
        (g.date ? escHtml(String(g.date).slice(0, 10)) : '—') +
      '</span>' +
      '<span>' + escHtml(g.title) + '</span>' +
    '</div>';
  }).join('');
}

