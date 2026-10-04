// Songs management page

var TIME_SIGNATURES = ['4/4', '3/4', '6/8', '5/4', '12/8'];
var GEMA_LANGUAGES  = ['EN', 'FR', 'DE'];

var artistSlug = '';
var songs = [];
var dirty = new Set();
var newRowCounter = 0;
var currentPlayerSid = null;
var currentSheetSid    = null;
var currentPlaybackSid = null;
var currentLyricsSid   = null;
var _lyricsSuggestAbort = null;

var _pendingSetlistId = 0;
var _pendingSongId    = '';
var _pendingNewSong   = false;
var _newPanelEscapeHandler = null;
var SONGS_BULK_EDIT_KEY = 'songs_bulk_edit';
var _viewMode = false;
var _songsCfg = null;
var _pendingArrDrafts = {};  // new-song formId → draft arrangement, persisted on Add
var _songsOffset = 0;
var _songsTotal = 0;
var SONGS_VIEW_PAGE = 30;

function isBulkEdit() { return !isMobile() && !_viewMode && localStorage.getItem(SONGS_BULK_EDIT_KEY) === '1'; }

function toggleBulkEdit() {
  if (localStorage.getItem(SONGS_BULK_EDIT_KEY) === '1') {
    localStorage.removeItem(SONGS_BULK_EDIT_KEY);
  } else {
    localStorage.setItem(SONGS_BULK_EDIT_KEY, '1');
  }
  renderTable();
}

var _configPromise = null;
function getConfig() {
  // Light: the songs come from GET /songs below. The full config would ship
  // the whole catalogue a second time.
  if (!_configPromise) _configPromise = loadConfig(undefined, { light: true });
  return _configPromise;
}

// --- Init ---

async function init() {
  var _vm = isViewMode();
  if (_vm) {
    document.body.classList.add('view-mode');
    injectViewModeNotice();
  }
  await loadAndRender(_vm);
  injectModalCloseButtons();
}

// --- Data ---

function _applySongsResponse(json, reset) {
  if (Array.isArray(json)) {
    songs = reset ? json : songs.concat(json);
    _songsTotal = songs.length;
    return;
  }
  _songsTotal = json.total;
  songs = reset ? json.rows : songs.concat(json.rows);
}

async function fetchSongsList(reset) {
  if (reset) _songsOffset = 0;
  if (getToken()) {
    const r = await apiFetch(`/api/${artistSlug}/songs`);
    _applySongsResponse(await r.json(), true);
    return;
  }
  const params = new URLSearchParams({
    limit: String(SONGS_VIEW_PAGE),
    offset: String(_songsOffset),
    active: '1',
  });
  const r = await apiFetch(`/api/${artistSlug}/songs?${params}`);
  if (!r.ok) throw new Error('songs fetch failed');
  _applySongsResponse(await r.json(), reset);
}

async function loadMoreSongs() {
  if (getToken()) return;
  _songsOffset += SONGS_VIEW_PAGE;
  await fetchSongsList(false);
  if (_songsView) _songsView.refresh();
  else renderTable();
  updateSongsFooter();
}

function updateSongsFooter() {
  var footer = document.getElementById('songs-footer');
  var counter = document.getElementById('songs-counter');
  var btn = document.getElementById('songs-load-more-btn');
  if (!footer || !counter) return;
  var total = getToken() ? songs.length : _songsTotal;
  counter.textContent = t('songs.showing', { shown: songs.length, total: total });
  footer.style.display = total > 0 ? '' : 'none';
  if (btn) btn.style.display = (!getToken() && songs.length < total) ? '' : 'none';
}

function _ensureSongsFooter() {
  if (document.getElementById('songs-footer')) return;
  var footer = document.createElement('div');
  footer.id = 'songs-footer';
  footer.style.cssText = 'display:none;text-align:center;margin-top:1.5rem;';
  footer.innerHTML =
    '<p id="songs-counter" style="color:var(--third-color);font-size:0.85rem;margin:0 0 0.5rem;"></p>' +
    '<button id="songs-load-more-btn" class="btn" data-onclick="loadMoreSongs()">' + t('songs.loadMore') + '</button>';
  var container = document.getElementById('page-content');
  if (container) container.appendChild(footer);
}

async function loadAndRender(viewMode) {
  try {
    if (!artistSlug) {
      // Try to read slug synchronously from session cache so songs fetch
      // can start in parallel with the config network request.
      try {
        const _c = JSON.parse(sessionStorage.getItem('artist_config_cache'));
        if (_c?.slug) artistSlug = _c.slug;
      } catch {}
    }
    const cfgPromise = getConfig();
    const songsPromise = artistSlug ? fetchSongsList(true) : null;
    const cfg = await cfgPromise;
    applyNav(cfg.name, cfg.config);
    if (songsPromise) {
      await songsPromise;
    } else {
      artistSlug = cfg.slug;
      await fetchSongsList(true);
    }
    var _qp = new URLSearchParams(location.search);
    _pendingSetlistId = Number(_qp.get('setlist_id'));
    _pendingSongId    = String(_qp.get('id') || '');
    _pendingNewSong   = _qp.get('new') === '1';
    _viewMode = viewMode || false;
    _songsCfg          = cfg;
    window._arrSlug    = cfg.slug;
    renderTable();
    loadLogs();
    if (viewMode) applyViewMode();
  } catch {
    const el = document.getElementById('page-content');
    if (el) el.innerHTML = '<p style="color:var(--third-color);text-align:center;">' + t('songs.loadFailed') + '</p>';
  }
}

// --- Table ---

var COLS = [
  { key: 'title',               get label() { return t('songs.colLabelTitle'); },     type: 'text',   cls: 'col-title',   width: 180 },
  { key: 'active',              get label() { return t('songs.active'); },             type: 'bool',   cls: 'col-active',  width: 48  },
  { key: 'heart',               label: '♥',                  type: 'bool',   cls: 'col-heart',   width: 40, get title() { return t('songs.colTitleHeart'); } },
  { key: 'extra.listenUrl',    label: '▶',                  type: 'listen',   cls: 'col-listen',   width: 52, get title() { return t('songs.colTitleListen'); }  },
  { key: 'extra.sheetUrl',     label: '≡',                  type: 'sheet',    cls: 'col-sheet',    width: 52, get title() { return t('songs.colTitleSheet'); }   },
  { key: 'extra.playbackUrl',  label: '▷',                  type: 'playback', cls: 'col-playback', width: 52, get title() { return t('songs.colTitlePlayback'); }       },
  { key: 'lyrics',             label: '¶',                  type: 'lyrics',   cls: 'col-lyrics',   width: 52, get title() { return t('songs.colTitleLyrics'); }                          },
  { key: 'has_arrangement',    label: '&#8862;',            type: 'arr',      cls: 'col-arr',      width: 44, get title() { return t('songs.colTitleArrangement'); }                      },
  { key: 'play_count',          get label() { return t('songs.colLabelPlays'); },     type: 'stat',   cls: 'col-plays',   width: 50  },
  { key: 'last_played_at',      get label() { return t('songs.colLabelLastLive'); },  type: 'stat',   cls: 'col-last',    width: 86  },
  { key: 'iswc',                label: 'ISWC',               type: 'stat',   cls: 'col-iswc',    width: 110, title: 'ISWC (GEMA/SACEM)' },
  { key: 'gema_work_number',    label: 'GEMA-Nr',            type: 'stat',   cls: 'col-gema',    width: 116, title: 'GEMA Werknummer' },
  { key: 'gema_language',       get label() { return t('songs.colLabelLang'); },      type: 'select', cls: 'col-glang',   width: 56,  title: 'Language (GEMA)', options: GEMA_LANGUAGES, default: 'EN' },
  { key: 'extra.isrc',          label: 'ISRC',               type: 'stat',   cls: 'col-isrc',    width: 120, title: 'ISRC (recording)' },
  { key: 'key',                 get label() { return t('songs.colLabelKey'); },        type: 'select', cls: 'col-key',     width: 52, options: MUSICAL_KEYS },
  { key: 'extra.lead',          get label() { return t('songs.colLabelLead'); },       type: 'text',   cls: 'col-lead',    width: 80  },
  { key: 'extra.banjoCapo',     label: 'banjoCapo',          type: 'number', cls: 'col-bcapo',   width: 58  },
  { key: 'extra.git2',          label: 'git2',               type: 'bool',   cls: 'col-lgit',    width: 70  },
  { key: 'extra.gitCapo',       label: 'gitCapo',            type: 'number', cls: 'col-kcapo',   width: 58  },
  { key: 'extra.harp',          label: 'harp',               type: 'bool',   cls: 'col-harp',    width: 58  },
  { key: 'extra.aCapella',      get label() { return t('songs.fieldACapella'); }, type: 'bool', cls: 'col-acapella', width: 76 },
  { key: 'genre',               get label() { return t('songs.colLabelGenre'); },      type: 'text',   cls: 'col-cat',     width: 100 },
  { key: 'tags',                get label() { return t('songs.colLabelTags'); },       type: 'tags',   cls: 'col-tags',    width: 140 },
  { key: 'energy',              get label() { return t('songs.colLabelEnergy'); },     type: 'energy', cls: 'col-energy',  width: 190 },
  { key: 'time_signature',      get label() { return t('songs.colLabelTimeSig'); },    type: 'select', cls: 'col-timesig', width: 68, options: TIME_SIGNATURES },
  { key: 'bpm',                 get label() { return t('songs.colLabelBpm'); },        type: 'number', cls: 'col-bpm',     width: 55  },
  { key: 'length_min',          get label() { return t('songs.colLabelLength'); },     type: 'time',   cls: 'col-len',     width: 68  },
  { key: 'extra.author',        get label() { return t('songs.colLabelAuthor'); },     type: 'text',   cls: 'col-author',  width: 130 },
  { key: 'interpret',           get label() { return t('songs.colLabelInterpret'); },  type: 'text',   cls: 'col-interp',  width: 140 },
  { key: 'reference_interpret', label: 'reference_interpret', type: 'text',  cls: 'col-refint',  width: 140 },
  { key: 'extra.referenceUrl',  label: 'referenceUrl',       type: 'url',    cls: 'col-refurl',  width: 120 },
  { key: 'extra.songinfoUrl',   label: 'songinfoUrl',        type: 'url',    cls: 'col-infourl', width: 120 },
  { key: 'comment',             get label() { return t('songs.colLabelComment'); },    type: 'text',   cls: 'col-comment', width: 160 },
];

// Instrument fields a band can hide in Settings (artists.config.hiddenSongFields).
// The data stays; only the bulk table and the panel edit form leave them out.
var HIDEABLE_SONG_FIELDS = ['extra.lead', 'extra.banjoCapo', 'extra.git2', 'extra.gitCapo', 'extra.harp', 'extra.aCapella', 'tags'];

function _isSongFieldHidden(key) {
  return songFieldHidden(_songsCfg && _songsCfg.config, key);
}

function _visibleCols() {
  return COLS.filter(function(c) { return !_isSongFieldHidden(c.key); });
}

var COL_WIDTHS_KEY = 'songs_col_widths';

function minsToTime(mins) {
  if (mins === null || mins === undefined || mins === '') return '';
  const m = Math.floor(Number(mins));
  const s = Math.round((Number(mins) - m) * 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function getVal(song, key) {
  if (key.startsWith('extra.')) {
    const k = key.slice(6);
    return song.extra?.[k] ?? '';
  }
  const v = song[key];
  return v === null || v === undefined ? '' : v;
}

function getSavedWidths() {
  try { return JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || '{}'); } catch { return {}; }
}

var filters = { text: '', active: true, heart: false, lead: '', genre: '', interpret: '', setlist: '' };

var _setlistFilterIds   = null;   // null = no filter; Set<songId>
var _setlistFilterOrder = [];     // song IDs in setlist position order
var _allSetlistsMeta    = null;   // [{id, title}] fetched once on demand
var _songsView          = null;

function getVisibleSongs() {
  var result = songs.filter(function(s) {
    if (filters.active    && !s.active) return false;
    if (filters.heart     && !s.heart)  return false;
    if (filters.text      && !(s.title || '').toLowerCase().includes(filters.text)) return false;
    if (filters.lead      && !(s.extra?.lead || '').toLowerCase().includes(filters.lead)) return false;
    if (filters.genre     && !(s.genre || '').toLowerCase().includes(filters.genre)) return false;
    if (filters.interpret && !(s.interpret || '').toLowerCase().includes(filters.interpret)) return false;
    if (_setlistFilterIds !== null && !_setlistFilterIds.has(s.id)) return false;
    return true;
  });
  if (_setlistFilterIds !== null && _setlistFilterOrder.length) {
    result = result.slice().sort(function(a, b) {
      return _setlistFilterOrder.indexOf(a.id) - _setlistFilterOrder.indexOf(b.id);
    });
  }
  return result;
}

async function _applySetlistById(id) {
  // Ensure metadata cache is populated so we can show the name in the filter input
  if (!_allSetlistsMeta) {
    try {
      var r = await apiFetch('/api/' + artistSlug + '/setlists');
      _allSetlistsMeta = r.ok ? await r.json() : [];
      if (!Array.isArray(_allSetlistsMeta)) _allSetlistsMeta = [];
    } catch { _allSetlistsMeta = []; }
  }
  try {
    var detail = await apiFetch('/api/' + artistSlug + '/setlists/' + id).then(function(r) { return r.ok ? r.json() : {}; });
    var songsList = Array.isArray(detail) ? detail : (detail.songs || []);
    songsList = songsList.slice().sort(function(a, b) { return (a.position || 0) - (b.position || 0); });
    _setlistFilterOrder = songsList.map(function(s) { return s.id; });
    _setlistFilterIds = new Set(_setlistFilterOrder);
  } catch {
    _setlistFilterIds = new Set();
    _setlistFilterOrder = [];
  }
  // Update filter input with setlist name
  var found = (_allSetlistsMeta || []).find(function(s) { return s.id === id; });
  if (found) {
    filters.setlist = (found.title || '').toLowerCase();
    var el = document.getElementById('filter-setlist');
    if (el) el.value = found.title || '';
  }
  applyFilter();
}

function applyFilter() {
  if (isBulkEdit()) {
    var visible = getVisibleSongs();
    var tbody = document.getElementById('tbody');
    if (!tbody) return;
    var newRows = Array.from(tbody.querySelectorAll('tr[data-id^="_new_"]'));
    tbody.innerHTML = visible.map(renderRow).join('');
    newRows.forEach(function(r) { tbody.appendChild(r); });
    var countEl = document.getElementById('filter-count');
    if (countEl) countEl.textContent = visible.length + ' / ' + songs.length;
  }
  // In list-view mode, the factory manages its own pipeline
}

var FILTER_COLS = {
  'title':      function() { return '<input type="text" id="filter-text" class="col-filter" placeholder="' + t('songs.filterSearchPlaceholder') + '" value="' + escHtml(filters.text) + '" autocomplete="off">'; },
  'active':     function() { return '<input type="checkbox" id="filter-active" class="col-filter-check" title="' + t('songs.filterActiveOnly') + '" ' + (filters.active ? 'checked' : '') + '>'; },
  'heart':      function() { return '<input type="checkbox" id="filter-heart"  class="col-filter-check" title="' + t('songs.filterFavouritesOnly') + '" ' + (filters.heart ? 'checked' : '') + '>'; },
  'extra.lead': function() { return '<input type="text" id="filter-lead" class="col-filter" placeholder="…" value="' + escHtml(filters.lead) + '" autocomplete="off">'; },
  'genre':      function() { return '<input type="text" id="filter-cat" class="col-filter" placeholder="…" value="' + escHtml(filters.genre) + '" autocomplete="off">'; },
};

function renderTable() {
  if (isMobile()) localStorage.removeItem(SONGS_BULK_EDIT_KEY);
  if (isBulkEdit()) { _renderBulkEditTable(); return; }
  _renderSongsListView();
}

async function _resolveSetlistFilter(q) {
  if (!_allSetlistsMeta) {
    try {
      var r = await apiFetch('/api/' + artistSlug + '/setlists');
      _allSetlistsMeta = r.ok ? await r.json() : [];
      if (!Array.isArray(_allSetlistsMeta)) _allSetlistsMeta = [];
    } catch { _allSetlistsMeta = []; }
  }
  var matches = _allSetlistsMeta.filter(function(s) {
    return (s.title || '').toLowerCase().includes(q.toLowerCase());
  });
  if (!matches.length) return new Set();

  try {
    var detail = await apiFetch('/api/' + artistSlug + '/setlists/' + matches[0].id)
      .then(function(r) { return r.ok ? r.json() : {}; });
    var songsList = Array.isArray(detail) ? detail : (detail.songs || []);
    return new Set(songsList.map(function(s) { return s.id; }));
  } catch {
    return new Set();
  }
}

function _getSongsForFactory(state) {
  var setlistIds = state.setlist; // Set<id> | undefined
  return songs.filter(function(s) {
    if (state.active && !s.active) return false;
    if (state.title && !(s.title || '').toLowerCase().includes(state.title)) return false;
    if (state.interpret && !(s.interpret || '').toLowerCase().includes(state.interpret)) return false;
    if (state.genre && (s.genre || '') !== state.genre) return false;
    if (state.tags && state.tags.length && !songTags(s).some(function(t) { return state.tags.indexOf(t) !== -1; })) return false;
    if (setlistIds !== undefined && !setlistIds.has(s.id)) return false;
    return true;
  });
}

// Genres worth offering as chips: those present on songs that pass the other filters.
// The genre filter itself is ignored, otherwise picking one would leave it as the only
// chip and there would be no way back to the others.
function _availableGenres(state) {
  var withoutGenre = Object.assign({}, state || {});
  delete withoutGenre.genre;
  var available = _getSongsForFactory(withoutGenre)
    .map(function(s) { return s.genre; })
    .filter(Boolean);
  return Array.from(new Set(available)).sort();
}

// Tags offered as chips: those on songs that pass the other filters.
function _availableTags(state) {
  var rest = Object.assign({}, state || {});
  delete rest.tags;
  return bandTags(_getSongsForFactory(rest));
}

function _renderSongsListView() {
  _songsView = createListView({
    container: document.getElementById('page-content'),
    filters: isViewMode() ? [
      { id: 'title',     label: t('songs.filterTitle'),     type: FILTER_TYPES.TEXT, field: 'title'     },
      { id: 'interpret', label: t('songs.filterInterpret'), type: FILTER_TYPES.TEXT, field: 'interpret' },
      { id: 'tags',      label: t('songs.filterTags'),      type: FILTER_TYPES.CHIPS, multi: true, field: 'tags',
        getValues: _availableTags },
    ] : [
      { id: 'title',     label: t('songs.filterTitle'),       type: FILTER_TYPES.TEXT,       field: 'title'     },
      { id: 'interpret', label: t('songs.filterInterpret'),    type: FILTER_TYPES.TEXT,       field: 'interpret' },
      { id: 'setlist',   label: t('songs.filterSetlist'),      type: FILTER_TYPES.ASYNC_TEXT,
        resolve: _resolveSetlistFilter },
      { id: 'active',    label: t('songs.filterActiveOnly'),   type: FILTER_TYPES.CHECKBOX,   field: 'active', 'default': true },
      { id: 'genre',     label: t('songs.filterGenre'),        type: FILTER_TYPES.CHIPS,      field: 'genre',
        getValues: _availableGenres },
      { id: 'tags',      label: t('songs.filterTags'),         type: FILTER_TYPES.CHIPS, multi: true, field: 'tags',
        getValues: _availableTags },
    ],
    actions: isViewMode() ? [] : [
      { label: t('songs.addSong'), onClick: _openNewSongPanel },
      { label: t('songs.bulkEdit'),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/></svg>',
        title: t('songs.bulkEdit'),
        onClick: toggleBulkEdit,
        desktopOnly: true },
      { label: t('songs.share'), icon: SHARE_ICON, title: t('songs.share'), onClick: _songsShareMenu },
    ],
    getData:   _getSongsForFactory,
    getTotal:  function() { return getToken() ? songs.length : _songsTotal; },
    getItemId: function(s) { return s.id; },
    renderRow: renderListRowHtml,
    onOpen:    _openSongPanelContent,
    emptyHtml: '<div style="text-align:center;padding:2.5rem 1rem;color:var(--third-color);">' +
      '<p style="margin-bottom:1rem;">' + t('songs.noSongs') + '</p>' +
      (getToken() && !isViewMode() ? '<button class="btn active" data-onclick="_openNewSongPanel()">' + t('songs.addFirstSong') + '</button>' : '') +
      '</div>',
  });

  requestAnimationFrame(function() {
    var hdr = document.querySelector('.app-header');
    if (hdr) document.documentElement.style.setProperty('--songs-toolbar-top', hdr.getBoundingClientRect().height + 'px');
  });

  _ensureSongsFooter();
  updateSongsFooter();

  if (_pendingSetlistId) {
    _applySetlistByIdForView(_pendingSetlistId);
    _pendingSetlistId = 0;
  } else if (_pendingSongId) {
    _songsView.select(_pendingSongId);
    _pendingSongId = '';
  } else if (_pendingNewSong && getToken() && !_viewMode) {
    _openNewSongPanel();
  } else if (!isMobile()) {
    // Desktop: looking up a song is the #1 task — search is ready to type.
    var _searchEl = document.getElementById('lv-f-title');
    if (_searchEl) _searchEl.focus();
  }
  _pendingNewSong = false;

  loadLogs();
}

async function _applySetlistByIdForView(id) {
  if (!_allSetlistsMeta) {
    try {
      var r = await apiFetch('/api/' + artistSlug + '/setlists');
      _allSetlistsMeta = r.ok ? await r.json() : [];
      if (!Array.isArray(_allSetlistsMeta)) _allSetlistsMeta = [];
    } catch { _allSetlistsMeta = []; }
  }
  var found = (_allSetlistsMeta || []).find(function(s) { return s.id === id; });
  if (found && _songsView) {
    _songsView.setFilterValue('setlist', found.title || '');
  }
}

function renderListRowHtml(s) {
  var sid       = String(s.id);
  var title     = escHtml(s.title || '(untitled)');
  var interp    = escHtml(s.interpret || '');
  var genre     = escHtml(s.genre || '');
  var key       = escHtml(String(getVal(s, 'key') || ''));
  var tempo     = escHtml(energyLabel(getVal(s, 'energy')));
  var hasListen = !!getVal(s, 'extra.listenUrl');
  var hasLyrics = !!(s.has_lyrics || s.lyrics);

  var borderCls = s.active ? 'songs-list-row--active' : 'songs-list-row--inactive';
  var titleCls  = s.active ? '' : ' songs-list-row-title--inactive';

  var tagChips = _isSongFieldHidden('tags') ? '' : songTags(s).map(function(tag) {
    return '<span class="tag-chip">' + escHtml(tag) + '</span>';
  }).join('');

  var heartBtn = heartButtonHtml(!!s.heart, 'toggleFavourite(' + Number(s.id) + ')', t('songs.colTitleHeart'), _viewMode);

  var icons = '';
  if (hasListen) icons += '<button class="song-card-icon-btn" data-onclick="event.stopPropagation();openPlayer(\'' + sid + '\')" title="' + t('songs.listen') + '" aria-label="' + t('songs.listen') + '">&#9654;</button>';
  if (hasLyrics) icons += '<button class="song-card-icon-btn" data-onclick="event.stopPropagation();openLyrics(\'' + sid + '\')" title="' + t('songs.lyricsTitle') + '" aria-label="' + t('songs.lyricsTitle') + '">&#182;</button>';
  var hasArrangement = !_viewMode && !!s.has_arrangement;
  if (hasArrangement) icons += '<button class="song-card-icon-btn" data-onclick="event.stopPropagation();_openSongArrangement(' + Number(s.id) + ')" title="' + t('songs.colTitleArrangement') + '" aria-label="' + t('songs.colTitleArrangement') + '">&#8862;</button>';

  return '<div class="songs-list-row ' + borderCls + '" data-id="' + escHtml(sid) + '">' +
    heartBtn +
    '<div class="songs-list-row-stack">' +
      '<span class="songs-list-row-title' + titleCls + '">' + title + '</span>' +
      (interp ? '<span class="songs-list-row-interpret">' + interp + '</span>' : '') +
      (tagChips ? '<span class="songs-list-row-tags">' + tagChips + '</span>' : '') +
    '</div>' +
    // The slots are always rendered, empty ones included — otherwise a song without a
    // genre shifts key and energy left and the columns no longer line up.
    '<span class="songs-list-row-genre">' + genre + '</span>' +
    '<span class="songs-list-row-key">'   + key   + '</span>' +
    '<span class="songs-list-row-tempo">' + tempo + '</span>' +
    '<span class="songs-list-row-icons">' + icons + '</span>' +
  '</div>';
}


async function toggleFavourite(id) {
  if (_viewMode) return;
  var song = songs.find(function(s) { return s.id === id; });
  if (!song) return;
  await toggleHeart(song, async function(wanted) {
    var r = await apiFetch('/api/' + artistSlug + '/songs', 'PATCH',
      [{ id: id, title: song.title, active: song.active, heart: wanted }]);
    var json = r.ok ? await r.json().catch(function() { return {}; }) : {};
    if (!r.ok || (json.rejected && json.rejected.length)) throw new Error('save failed');
    invalidateConfigCache();
  }, function() { if (_songsView) _songsView.refresh(); });
}

function _openSongArrangement(id) {
  var song = songs.find(function(s) { return s.id === id; });
  if (!song) return;
  var arrCfg = _songsCfg && _songsCfg.config && _songsCfg.config.arrangementConfig;
  window._arrOnAllDeleted = function(songId) {
    var s = songs.find(function(s) { return s.id === songId; });
    if (s) s.has_arrangement = false;
    if (_songsView) _songsView.refresh();
    window._arrOnAllDeleted = null;
  };
  openArrangementEditor(id, song.title || '', arrCfg);
}

// icon: an HTML entity from COLS (e.g. '&#9654;'), so it is not escaped.
function _editField(label, html, icon) {
  return '<div class="edit-field">' +
    (label ? '<span class="edit-field-label">' + (icon ? '<span aria-hidden="true">' + icon + '</span> ' : '') + escHtml(label) + '</span>' : '') +
    html +
  '</div>';
}

function markPanelEditDirty() {
  var btn = document.getElementById('song-panel-save-btn');
  if (btn) btn.disabled = false;
}

function _vspCell(label, value) {
  return '<div class="vsp-cell"><div class="vsp-cell-label">' + label + '</div><div class="vsp-cell-value">' + value + '</div></div>';
}

function _vspSection(heading, cellsHtml) {
  if (window.innerWidth <= 1024) {
    return '<details class="vsp-collapse" open><summary class="vsp-collapse-summary">' +
           heading + '</summary><div class="vsp-grid">' + cellsHtml + '</div></details>';
  }
  return '<div class="vsp-section-label">' + heading + '</div><div class="vsp-grid">' + cellsHtml + '</div>';
}

// Lyrics are not in the song list: the export asks for them once, in one
// request, and keeps them on the song objects for later.
async function _ensureAllLyrics(list) {
  if (!getToken() || !list.some(function(s) { return s.has_lyrics && s.lyrics === undefined; })) return;
  var r = await apiFetch('/api/' + artistSlug + '/songs?lyrics=1');
  if (!r.ok) throw new Error('lyrics fetch failed');
  var byId = {};
  (await r.json()).forEach(function(row) { byId[row.id] = row.lyrics || null; });
  list.forEach(function(s) { if (s.lyrics === undefined && s.id in byId) s.lyrics = byId[s.id]; });
}

async function exportCsv() {
  var list = getVisibleSongs();
  try { await _ensureAllLyrics(list); }
  catch { _setBulkStatus('error', t('songs.lyricsCouldNotFetch')); return; }
  exportTableCsv(
    list,
    COLS.map(function(c) {
      return {
        label: c.label,
        getValue: function(song) {
          // Language: the GEMA work's when one is linked, else the song's own.
          var raw = c.key === 'gema_language' ? (song.gema_language || song.language) : getVal(song, c.key);
          if (c.type === 'bool') return (raw == null) ? '' : (raw ? 'true' : 'false');
          if (c.type === 'time') return minsToTime(raw);
          return (raw === null || raw === undefined) ? '' : String(raw);
        }
      };
    }),
    'songs'
  );
}

// Share menu on the toolbar — same popover pattern as setlist history.
function _songsShareMenu(btn) {
  var existing = document.getElementById('share-menu-popup');
  if (existing) { closeShareMenu(); return; }

  var menu = document.createElement('div');
  menu.id = 'share-menu-popup';
  menu.className = 'share-menu';
  menu.innerHTML =
    '<button type="button" class="share-menu-item" data-onclick="exportCsv();closeShareMenu()">' +
      '<span class="share-menu-icon" aria-hidden="true">&#10515;</span><span class="share-menu-label">' + t('songs.exportCsv') + '</span>' +
    '</button>' +
    (getAuthRole() === 'viewer' ? '' :
    '<button type="button" class="share-menu-item" data-onclick="closeShareMenu();navigate(\'/song-import\')">' +
      '<span class="share-menu-icon" aria-hidden="true">&#10514;</span><span class="share-menu-label">' + t('songs.importCsv') + '</span>' +
    '</button>');

  var rect = btn.getBoundingClientRect();
  menu.style.cssText = 'position:fixed;top:' + (rect.bottom + 6) + 'px;left:' + rect.left + 'px';
  document.body.appendChild(menu);
  var overflow = menu.getBoundingClientRect().right - (window.innerWidth - 8);
  if (overflow > 0) menu.style.left = Math.max(8, rect.left - overflow) + 'px';
  wirePopupMenu(btn, menu);
}

// --- Logs ---

async function loadLogs() {
  const el = document.getElementById('logs-section');
  if (!el || !artistSlug) return;
  try {
    const logs = await apiFetch(`/api/${artistSlug}/song-logs`).then(r => r.ok ? r.json() : []);
    renderLogs(logs);
  } catch {
    el.innerHTML = '';
  }
}

function timeAgo(iso) {
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (secs < 60)    return t('songs.timeJustNow');
  if (secs < 3600)  return t('songs.timeMinAgo', { n: Math.floor(secs / 60) });
  if (secs < 86400) return t('songs.timeHAgo',   { n: Math.floor(secs / 3600) });
  return t('songs.timeDAgo', { n: Math.floor(secs / 86400) });
}

function renderLogs(logs) {
  const el = document.getElementById('logs-section');
  if (!el) return;
  if (!logs.length) { el.innerHTML = ''; return; }

  const token = getToken();
  const items = logs.map(log => {
    const title = log.song_data?.title ?? '(unknown)';
    const badge = log.action === 'create' ? 'log-create'
                : log.action === 'delete' ? 'log-delete'
                : 'log-update';
    const label = log.action === 'create' ? t('songs.logAdded')
                : log.action === 'delete' ? t('songs.logDeleted')
                : t('songs.logUpdated');
    const restore = (log.action === 'delete' && token)
      ? `<button class="log-restore-btn" data-onclick="restoreSong(${log.song_id})">${t('songs.restore')}</button>`
      : '';
    return `<div class="log-row">
      <span class="log-badge ${badge}">${label}</span>
      <span class="log-title">${escHtml(title)}</span>
      <span class="log-time">${timeAgo(log.changed_at)}</span>
      ${restore}
    </div>`;
  }).join('');

  el.innerHTML = `<div class="logs-wrap"><h2 class="logs-heading">${t('songs.changeLog')}</h2>${items}</div>`;
}

async function restoreSong(songId) {
  if (!getToken()) return;
  let r;
  // apiFetch sends an ended session to the login page and throws.
  try { r = await apiFetch(`/api/${artistSlug}/songs/${songId}/restore`, 'POST'); } catch { return; }
  if (r.ok) {
    invalidateConfigCache();
    await loadAndRender();
  } else {
    _setBulkStatus('error', t('songs.couldNotRestore'));
  }
}

// --- Song appearances modal ---

async function openAppearances(songId) {
  const song  = songs.find(s => s.id === songId);
  const modal = document.getElementById('appearances-modal');
  document.getElementById('appearances-title').textContent =
    song ? `"${song.title}"` : t('songs.appearancesTitle');
  const list = document.getElementById('appearances-list');
  list.innerHTML = '<p class="appearance-loading">' + t('songs.loading') + '</p>';
  modal.classList.add('open');

  try {
    const data = await apiFetch(`/api/${artistSlug}/songs/${songId}/setlists`).then(r => r.ok ? r.json() : []);
    if (!data.length) {
      list.innerHTML = '<p class="appearance-empty">' + t('songs.notInAnySetlist') + '</p>';
      return;
    }
    list.innerHTML = data.map(sl => {
      const parts = [sl.gig_name, formatDate(sl.gig_date) || null, sl.gig_venue]
        .filter(Boolean);
      const label = parts.length ? parts.join(' — ') : (sl.title || `Setlist #${sl.id}`);
      const date  = formatDate(sl.created_at);
      return `<div class="appearance-row">
        <a class="appearance-gig" href="/setlist-history#set-${sl.id}" target="_blank">${escHtml(label)}</a>
        <span class="appearance-date">${date}</span>
      </div>`;
    }).join('');
  } catch {
    list.innerHTML = '<p class="appearance-empty">' + t('songs.failedToLoad') + '</p>';
  }
}

function closeAppearances() {
  document.getElementById('appearances-modal').classList.remove('open');
}

document.getElementById('appearances-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAppearances();
});

// --- GEMA modal ---

async function openGema(songId) {
  const modal   = document.getElementById('gema-modal');
  const title   = document.getElementById('gema-title');
  const content = document.getElementById('gema-content');
  const song    = songs.find(s => s.id === songId);
  title.textContent = song?.title ?? 'GEMA';
  content.innerHTML = '<p class="gema-loading">' + t('songs.loading') + '</p>';
  modal.classList.add('open');
  try {
    const r = await apiFetch(`/api/${artistSlug}/songs/${songId}/gema`);
    const { works, rightholders } = await r.json();
    content.innerHTML = works.length ? renderGemaContent(works, rightholders) : '<p class="gema-loading">' + t('songs.noGemaLinked') + '</p>';
  } catch {
    content.innerHTML = '<p class="gema-loading">' + t('songs.failedToLoad') + '</p>';
  }
}

function renderGemaContent(works, rightholders) {
  return works.map(work => {
    const rh = rightholders.filter(r => r.gema_work_id === work.id);
    const dur = work.duration_sec != null
      ? `${Math.floor(work.duration_sec / 60)}:${String(work.duration_sec % 60).padStart(2, '0')}`
      : null;
    const details = [
      ['ISWC',                              work.iswc],
      ['ISRC',                              work.isrc],
      [t('songs.gemaLabelLanguage'),        work.language],
      [t('songs.gemaLabelPerformers'),      work.performers],
      [t('songs.gemaLabelGenre'),           work.gema_genre],
      [t('songs.gemaLabelDuration'),        dur],
      [t('songs.gemaLabelFirstRegistered'), work.first_registered_at],
      [t('songs.gemaLabelLastUpdated'),     work.last_updated_at],
    ].filter(([, v]) => v);

    const dlHtml = details.map(([k, v]) =>
      `<dt>${escHtml(k)}</dt><dd>${escHtml(String(v))}</dd>`
    ).join('');

    const rhHtml = rh.length ? `
      <table class="gema-rh-table">
        <thead><tr><th>${t('songs.gemaColName')}</th><th>${t('songs.gemaColRole')}</th><th>AR %</th><th>VR %</th><th>${t('songs.gemaColSociety')}</th><th>${t('songs.gemaColRepresents')}</th></tr></thead>
        <tbody>${rh.map(r => `<tr>
          <td>${escHtml(r.name)}</td>
          <td>${escHtml(r.role)}</td>
          <td>${r.ar_share != null ? r.ar_share : '—'}</td>
          <td>${r.vr_share != null ? r.vr_share : '—'}</td>
          <td>${escHtml(r.society_ar || '—')}</td>
          <td>${r.represents_name ? escHtml(r.represents_name) : '—'}</td>
        </tr>`).join('')}</tbody>
      </table>` : '';

    return `<div class="gema-work">
      <h3 class="gema-work-nr">${escHtml(work.gema_work_number)}</h3>
      ${dlHtml ? `<dl class="gema-details">${dlHtml}</dl>` : ''}
      ${rhHtml}
    </div>`;
  }).join('');
}

function closeGema() {
  document.getElementById('gema-modal').classList.remove('open');
}

document.getElementById('gema-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeGema();
});

function _setAudioSpeed(btn, rate) {
  var wrap = btn.closest('.vsp-audio-block, .audio-speed-wrap, .song-stage-rec');
  var audio = wrap && wrap.querySelector('audio');
  if (audio) audio.playbackRate = rate;
  btn.parentNode.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
}

init();
