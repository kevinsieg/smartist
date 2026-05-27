var VENUE_STATUSES = [
  { value: 'prospect',  label: 'Prospect' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'active',    label: 'Active' },
  { value: 'declined',  label: 'Declined' },
];

var VENUE_CATEGORIES = [
  { value: 'club',        label: 'Club' },
  { value: 'restaurant',  label: 'Restaurant' },
  { value: 'festival',    label: 'Festival' },
  { value: 'pub',         label: 'Pub' },
  { value: 'private',     label: 'Private' },
  { value: 'street',      label: 'Street' },
  { value: 'placeholder', label: 'Placeholder' },
];

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
      msgEl.innerHTML = 'Possible duplicate: <strong>' + escHtml(match.name) + '</strong>'
        + (match.city ? ' (' + escHtml(match.city) + ')' : '')
        + ' — <a href="#" onclick="event.preventDefault();closeVenueModal();openEditModal(' + match.id + ')">open</a>';
      msgEl.style.display = '';
    } else {
      msgEl.style.display = 'none';
    }
  }, 300);
}

var artistSlug = '';
var allVenues = [];
var editingId = null;
var hardDeleteId = null;

var venueTable;
var placeholderTable;

var _venuesTotal = 0;
var _venuesOffset = 0;
var _venuesQ = '';
var _venuesStatus = '';
var _venuesCategory = '';
var _venuesTimer = null;
var _viewMode = false;

var VENUE_COLUMNS = [
  { field: 'name',    label: 'Name',     width: '1.5fr', sortable: true, filterable: true },
  { field: 'city',    label: 'City',     width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'country', label: 'Country',  width: '1fr',   sortable: true, filterable: true, muted: true },
  { field: 'postcode',label: 'Postcode', width: '90px',  sortable: true, filterable: true, muted: true },
  { field: 'size',    label: 'Capacity', width: '70px',  sortable: true, type: 'number',   muted: true },
  { field: 'status',  label: 'Status',   width: '90px',
    render: v => v.status ? `<span class="sl-badge">${escHtml(v.status)}</span>` : '' },
  { width: 'auto', actions: true, render: function(v) {
    if (v.deleted)                    return '<span class="sl-deleted-badge">deleted</span>';
    if (v.category === 'placeholder') return '';
    if (_viewMode)                    return '';
    return '<button class="btn sl-edit-btn" title="Edit" onclick="event.stopPropagation();openEditModal(' + v.id + ')">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/></svg></button>';
  }},
];

initPage(async function(cfg, viewMode) {
  populateSelects();
  _viewMode = viewMode;
  artistSlug = cfg.slug;

  venueTable = createSortableList({
    containerId:    'venues-list',
    sortBarId:      'sort-bar',
    columns:        VENUE_COLUMNS,
    defaultSort:    'name',
    rowClass:       v => v.deleted ? 'deleted' : '',
    onExpand:       v => expandVenue(v),
    emptyHint:      'No venues yet. Add one above.',
  });

  placeholderTable = createSortableList({
    containerId: 'placeholder-list',
    columns:     VENUE_COLUMNS,
    defaultSort: 'name',
    rowClass:    v => v.deleted ? 'deleted' : '',
    onExpand:    v => expandVenue(v),
    emptyHint:   'None.',
  });

  const filterEl   = document.getElementById('filter-input');
  const statusEl   = document.getElementById('filter-status');
  const categoryEl = document.getElementById('filter-category');

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

  if (statusEl) {
    statusEl.addEventListener('change', async function() {
      _venuesStatus = statusEl.value;
      _venuesOffset = 0;
      await loadVenues();
    });
  }

  if (categoryEl) {
    categoryEl.addEventListener('change', async function() {
      _venuesCategory = categoryEl.value;
      _venuesOffset = 0;
      await loadVenues();
    });
  }

  await loadVenues();

  if (_viewMode) {
    applyViewMode();
    var notice = document.createElement('div');
    notice.className = 'view-mode-notice';
    notice.innerHTML = 'View mode — <a class="go-login" href="' + loginPageUrl() + '">Login</a> for full access.';
    var page = document.querySelector('.app-page') || document.body;
    page.insertBefore(notice, page.firstChild);
  }

  initGeoFields('vm-city', 'vm-country', 'vm-postcode');

  var _venueDeepId = Number(new URLSearchParams(location.search).get('id'));
  if (_venueDeepId) openEditModal(_venueDeepId);
});

async function loadVenues() {
  const params = new URLSearchParams({ limit: 50, offset: _venuesOffset });
  if (_venuesQ)        params.set('q',        _venuesQ);
  if (_venuesStatus)   params.set('status',   _venuesStatus);
  if (_venuesCategory) params.set('category', _venuesCategory);
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
  ['name','street-number','street','postcode','city','country','category','email','website','comment'].forEach(f => {
    const el = document.getElementById(`vm-${f}`); if (el) el.value = '';
  });
  document.getElementById('vm-status').value = '';
  document.getElementById('vm-size').value   = '';
  document.getElementById('vm-delete-btn').style.display = 'none';
  document.getElementById('vm-gigs-section').style.display = 'none';
  document.getElementById('vm-dup-warning').style.display = 'none';
  setStatus('vm-status-msg', '');
  openModal('venue-modal');
}

function openEditModal(id) {
  const v = allVenues.find(x => x.id === id);
  if (!v) return;
  editingId = id;
  document.getElementById('venue-modal-title').textContent = 'Edit venue';
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
  document.getElementById('vm-size').value     = v.size          || '';
  document.getElementById('vm-comment').value  = v.comment       || '';
  document.getElementById('vm-delete-btn').style.display = v.deleted ? 'none' : '';
  document.getElementById('vm-dup-warning').style.display = 'none';
  setStatus('vm-status-msg', '');
  renderVenueGigs(id, v.name);
  openModal('venue-modal');
}

function closeVenueModal() { delete _venueRefsCache[editingId]; closeModal('venue-modal'); }

var _venueRefsCache = {};

async function expandVenue(v) {
  if (!_venueRefsCache[v.id]) {
    try {
      const r = await fetch('/api/' + artistSlug + '/venues/' + v.id + '?refs=1');
      if (!r.ok) throw new Error(r.status);
      _venueRefsCache[v.id] = await r.json();
    } catch {
      return '<span style="color:#e55;font-size:0.82rem;">Could not load gigs.</span>';
    }
  }
  const refs = _venueRefsCache[v.id].refs;
  if (!refs.gigs.length) {
    return '<div class="expansion-label">Gigs at this venue</div>' +
      '<span style="color:var(--third-color);font-size:0.82rem;">No gigs yet.</span>';
  }
  var n = refs.gigs.length;
  var rows = refs.gigs.slice(0, 10).map(function(g) {
    return '<div style="padding:0.1rem 0;font-size:0.82rem;">' +
      (g.date ? escHtml(String(g.date).slice(0, 10)) + ' — ' : '') +
      escHtml(g.title) + '</div>';
  }).join('');
  var link = '<a class="expansion-more-link" href="#" onclick="event.preventDefault();navigate(\'/gigs?venue=' +
    encodeURIComponent(v.name).replace(/'/g, '%27') + '\')">&#8594; All ' + n + ' gig' + (n !== 1 ? 's' : '') + ' at this venue</a>';
  return '<div class="expansion-label">Gigs at this venue</div>' + rows + link;
}

function deleteVenueFromPopup() {
  var id = editingId;
  closeVenueModal();
  promptHardDelete(id);
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
    'onclick="event.preventDefault();closeVenueModal();navigate(\'/gigs?venue=' + encodeURIComponent(venueName).replace(/'/g, '%27') + '\')">' +
    '→ All ' + n + ' gig' + (n !== 1 ? 's' : '') + ' at this venue' +
  '</a>';
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
