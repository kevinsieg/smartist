// Songs management page

var TIME_SIGNATURES = ['4/4', '3/4', '6/8', '5/4', '12/8'];
var GEMA_LANGUAGES  = ['EN', 'FR', 'DE'];

// Circle-of-fifths keys: 15 majors then their 15 relative minors.
var MUSICAL_KEYS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭',
  'Am', 'Em', 'Bm', 'F♯m', 'C♯m', 'G♯m', 'D♯m', 'A♯m', 'Dm', 'Gm', 'Cm', 'Fm', 'B♭m', 'E♭m', 'A♭m',
];

// Option HTML for a key <select>. Preserves a legacy/free-text value that
// predates this list so editing a song never silently drops its key.
function _keyOptions(cur) {
  cur = cur || '';
  var list = (cur && MUSICAL_KEYS.indexOf(cur) === -1) ? [cur].concat(MUSICAL_KEYS) : MUSICAL_KEYS;
  return '<option value="">—</option>' + list.map(function(k) {
    return '<option value="' + escHtml(k) + '"' + (k === cur ? ' selected' : '') + '>' + escHtml(k) + '</option>';
  }).join('');
}

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
  if (!_configPromise) _configPromise = loadConfig();
  return _configPromise;
}

// --- Init ---

async function init() {
  // Magic link login: /songs#magic=TOKEN
  const magic = new URLSearchParams(window.location.hash.slice(1)).get('magic');
  if (magic) {
    history.replaceState(null, '', window.location.pathname);
    try {
      const cfg = await getConfig();
      artistSlug = cfg.slug;
      applyNav(cfg.name, cfg.config);
      const r = await fetch(`/api/${artistSlug}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: magic }),
      });
      if (r.ok) {
        sessionStorage.setItem(AUTH_TOKEN_KEY, magic);
        await loadAndRender();
        return;
      }
    } catch {}
  }
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
    '<button id="songs-load-more-btn" class="btn" onclick="loadMoreSongs()">' + t('songs.loadMore') + '</button>';
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
  { key: 'extra.lyrics',       label: '¶',                  type: 'lyrics',   cls: 'col-lyrics',   width: 52, get title() { return t('songs.colTitleLyrics'); }                          },
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
  { key: 'genre',               get label() { return t('songs.colLabelGenre'); },      type: 'text',   cls: 'col-cat',     width: 100 },
  { key: 'energy',              get label() { return t('songs.colLabelEnergy'); },     type: 'text',   cls: 'col-energy',  width: 70  },
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

var COL_WIDTHS_KEY = 'songs_col_widths';

function minsToTime(mins) {
  if (mins === null || mins === undefined || mins === '') return '';
  const m = Math.floor(Number(mins));
  const s = Math.round((Number(mins) - m) * 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function timeToMins(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(':');
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10);
  const s = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(s) || s >= 60) return null;
  return m + s / 60;
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
var _setlistFilterTimer = null;
var _allSetlistsMeta    = null;   // [{id, name}] fetched once on demand
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
    filters.setlist = (found.name || '').toLowerCase();
    var el = document.getElementById('filter-setlist');
    if (el) el.value = found.name || '';
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
    return (s.name || '').toLowerCase().includes(q.toLowerCase());
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

function _renderSongsListView() {
  _songsView = createListView({
    container: document.getElementById('page-content'),
    filters: isViewMode() ? [
      { id: 'title',     label: t('songs.filterTitle'),     type: FILTER_TYPES.TEXT, field: 'title'     },
      { id: 'interpret', label: t('songs.filterInterpret'), type: FILTER_TYPES.TEXT, field: 'interpret' },
    ] : [
      { id: 'title',     label: t('songs.filterTitle'),       type: FILTER_TYPES.TEXT,       field: 'title'     },
      { id: 'interpret', label: t('songs.filterInterpret'),    type: FILTER_TYPES.TEXT,       field: 'interpret' },
      { id: 'setlist',   label: t('songs.filterSetlist'),      type: FILTER_TYPES.ASYNC_TEXT,
        resolve: _resolveSetlistFilter },
      { id: 'active',    label: t('songs.filterActiveOnly'),   type: FILTER_TYPES.CHECKBOX,   field: 'active', 'default': true },
      { id: 'genre',     label: t('songs.filterGenre'),        type: FILTER_TYPES.CHIPS,      field: 'genre',
        getValues: _availableGenres },
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
      (getToken() && !isViewMode() ? '<button class="btn active" onclick="_openNewSongPanel()">' + t('songs.addFirstSong') + '</button>' : '') +
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

function _openSongPanelContent(item, panelEl) {
  var song = songs.find(function(s) { return String(s.id) === String(item.id); });
  if (!song) return;
  var sid = String(song.id);

  var title = escHtml(song.title || t('songs.untitled'));
  var activeDot = song.active
    ? '<span class="vsp-active-dot vsp-active-dot--on">&#9679; ' + t('songs.active') + '</span>'
    : '<span class="vsp-active-dot vsp-active-dot--off">&#9679; ' + t('songs.inactive') + '</span>';

  var listenUrl   = getVal(song, 'extra.listenUrl');
  var playbackUrl = getVal(song, 'extra.playbackUrl');
  var lyricsVal   = String(getVal(song, 'extra.lyrics') || '').trim();
  var sheetUrl    = getVal(song, 'extra.sheetUrl');
  var sidEsc      = escHtml(sid);
  var audioRe     = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i;

  var _spd = '<div class="audio-speed-btns"><button onclick="_setAudioSpeed(this,0.7)">0.7×</button><button onclick="_setAudioSpeed(this,0.8)">0.8×</button><button onclick="_setAudioSpeed(this,0.9)">0.9×</button></div>';
  var audioHtml = '';
  if (listenUrl  && audioRe.test(listenUrl))
    audioHtml += '<div class="vsp-audio-block"><div class="vsp-audio-label">&#9654; ' + t('songs.listen') + '</div><audio class="vsp-audio" controls src="' + escHtml(listenUrl) + '"></audio>' + _spd + '</div>';
  if (playbackUrl && audioRe.test(playbackUrl))
    audioHtml += '<div class="vsp-audio-block"><div class="vsp-audio-label">&#9655; ' + t('songs.playback') + '</div><audio class="vsp-audio" controls src="' + escHtml(playbackUrl) + '"></audio>' + _spd + '</div>';

  var actions = '';
  if (!_viewMode) actions += '<button class="btn icon-btn" data-tooltip="' + t('songs.editSong') + '" onclick="_openSongEditForm(\'' + sidEsc + '\', document.getElementById(\'view-side-panel-inner\'))">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/>' +
    '</svg></button>';
  actions += '<a class="btn icon-btn" data-tooltip="' + t('songs.stageView') + '" href="/' + _artistSlug + '/stage?song=' + sidEsc + '" target="_blank" rel="noopener">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/>' +
    '</svg></a>';
  if (!_viewMode) actions += '<button class="btn icon-btn" data-tooltip="' + t('songs.lyricsTitle') + '" onclick="openLyrics(\'' + sidEsc + '\')">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/>' +
    '</svg></button>';
  if (listenUrl  && !audioRe.test(listenUrl))   actions += '<button class="btn" onclick="openPlayer(\'' + sidEsc + '\')">&#9654; ' + t('songs.listen') + '</button>';
  if (playbackUrl && !audioRe.test(playbackUrl)) actions += '<button class="btn" onclick="openPlayback(\'' + sidEsc + '\')">&#9655; ' + t('songs.playback') + '</button>';
  if (sheetUrl)   actions += '<button class="btn" onclick="openSheet(\'' + sidEsc + '\')">&#8801; ' + t('songs.sheet') + '</button>';
  if (!_viewMode) actions += '<button class="btn icon-btn" data-tooltip="' + t('songs.colTitleArrangement') + '" onclick="_openSongArrangement(' + Number(sid) + ')">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/>' +
    '</svg></button>';

  var key     = getVal(song, 'key');
  var energy  = getVal(song, 'energy');
  var timeSig = getVal(song, 'time_signature');
  var bpm     = getVal(song, 'bpm');
  var len     = minsToTime(getVal(song, 'length_min'));
  var lead    = getVal(song, 'extra.lead');
  var gitCapo = getVal(song, 'extra.gitCapo');
  var bjCapo  = getVal(song, 'extra.banjoCapo');
  var git2    = getVal(song, 'extra.git2');
  var harp    = getVal(song, 'extra.harp');
  var perfCells =
    (key     ? _vspCell(t('songs.fieldKey'),        escHtml(String(key)))     : '') +
    (energy  ? _vspCell(t('songs.fieldEnergy'),     escHtml(String(energy)))  : '') +
    (timeSig ? _vspCell(t('songs.fieldTimeSig'),    escHtml(String(timeSig))) : '') +
    (bpm     ? _vspCell(t('songs.fieldBpm'),        escHtml(String(bpm)))     : '') +
    (len     ? _vspCell(t('songs.fieldLength'),     escHtml(len))             : '') +
    (lead    ? _vspCell(t('songs.fieldLead'),       escHtml(String(lead)))    : '') +
    (gitCapo ? _vspCell(t('songs.fieldGitCapo'),    escHtml(String(gitCapo))) : '') +
    (bjCapo  ? _vspCell(t('songs.fieldBanjoCapo'),  escHtml(String(bjCapo)))  : '') +
    (git2    ? _vspCell(t('songs.fieldGuitar2'),    '&#10003;')               : '') +
    (harp    ? _vspCell(t('songs.fieldHarmonica'),  '&#10003;')               : '');
  var perfHtml = perfCells ? _vspSection(t('songs.sectionPerformance'), perfCells) : '';

  var genre   = getVal(song, 'genre');
  var interp  = getVal(song, 'interpret');
  var refInt  = getVal(song, 'reference_interpret');
  var author  = getVal(song, 'extra.author');
  var comment = getVal(song, 'comment');
  var refUrl  = getVal(song, 'extra.referenceUrl');
  var infoUrl = getVal(song, 'extra.songinfoUrl');
  var aboutCells =
    (genre   ? _vspCell(t('songs.fieldGenre'),         escHtml(String(genre)))  : '') +
    (interp  ? _vspCell(t('songs.fieldInterpret'),     escHtml(String(interp))) : '') +
    (refInt  ? _vspCell(t('songs.fieldRefInterpret'),  escHtml(String(refInt))) : '') +
    (author  ? _vspCell(t('songs.fieldAuthor'),        escHtml(String(author))) : '') +
    (comment ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">' + t('songs.fieldComment') + '</div><div class="vsp-cell-value">' + escHtml(String(comment)) + '</div></div>' : '') +
    (refUrl  ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">' + t('songs.fieldReference') + '</div><div class="vsp-cell-value"><a href="' + escHtml(safeUrl(String(refUrl)))  + '" target="_blank" rel="noopener">' + escHtml(String(refUrl))  + '</a></div></div>' : '') +
    (infoUrl ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">' + t('songs.fieldSongInfo') + '</div><div class="vsp-cell-value"><a href="' + escHtml(safeUrl(String(infoUrl))) + '" target="_blank" rel="noopener">' + escHtml(String(infoUrl)) + '</a></div></div>' : '');
  var aboutHtml = aboutCells ? _vspSection(t('songs.sectionAbout'), aboutCells) : '';

  var plays    = getVal(song, 'play_count');
  var lastLive = getVal(song, 'last_played_at');
  var statsCells =
    (plays    ? _vspCell(t('songs.fieldPlays'),    escHtml(String(plays))) : '') +
    (lastLive ? _vspCell(t('songs.fieldLastLive'), escHtml(String(lastLive).slice(0, 10))) : '');
  var statsHtml = statsCells ? _vspSection(t('songs.sectionStats'), statsCells) : '';

  var lang   = getVal(song, 'gema_language') || (song.extra && song.extra.language) || '';
  var gemaNr = getVal(song, 'gema_work_number');
  var iswc   = song.iswc || (song.extra && song.extra.iswc) || '';
  var isrc   = (song.extra && song.extra.isrc) || '';
  var rightsCells =
    (lang   ? _vspCell(t('songs.fieldLang'),    escHtml(String(lang)))   : '') +
    (gemaNr ? _vspCell(t('songs.fieldGemaNr'),  escHtml(String(gemaNr))) : '') +
    (iswc   ? _vspCell('ISWC',                  escHtml(String(iswc)))   : '') +
    (isrc   ? _vspCell('ISRC',                  escHtml(String(isrc)))   : '');
  var rightsHtml = rightsCells ? _vspSection(t('songs.sectionRights'), rightsCells) : '';

  var lyricsHtml = lyricsVal
    ? '<div class="vsp-section-label">' + t('songs.lyricsTitle') + '</div><div class="vsp-lyrics">' + escHtml(lyricsVal) + '</div>'
    : '';

  panelEl.innerHTML =
    '<div data-sid="' + escHtml(sid) + '">' +
    '<div class="vsp-header">' +
      '<div class="vsp-header-text">' +
        '<h3 class="vsp-title">' + title + '</h3>' + activeDot +
      '</div>' +
      '<button class="vsp-close" onclick="_songsView && _songsView.deselect()" aria-label="' + t('songs.close') + '">&#215;</button>' +
    '</div>' +
    (audioHtml || actions ? audioHtml + '<div class="vsp-actions">' + actions + '</div>' : '') +
    perfHtml + aboutHtml + statsHtml + rightsHtml +
    '<div class="vsp-cell vsp-cell--full" id="vsp-setlist-link"><span class="skeleton-line" style="width:7rem;height:0.65rem;display:inline-block;"></span></div>' +
    lyricsHtml + '</div>';

  // Async: setlist count + arrangement table — both use _panelSid for stale-panel check
  var _panelSid = sid;

  // Async: arrangement table (auth-only, active version only)
  if (!_viewMode && song.has_arrangement) {
    apiFetch('/api/' + artistSlug + '/songs/' + sid + '/arrangements')
      .then(function(r) { return r.json(); })
      .then(function(versions) {
        var active = versions.find(function(v) { return v.is_active; });
        if (!active) return;
        var panel = document.getElementById('view-side-panel-inner');
        if (!panel || !panel.querySelector('[data-sid="' + _panelSid + '"]')) return;
        var arrCfg = _songsCfg && _songsCfg.config && _songsCfg.config.arrangementConfig;
        var sec = document.createElement('div');
        sec.className = 'vsp-section';
        sec.innerHTML =
          '<div class="vsp-section-label">' + t('songs.colTitleArrangement') +
          (active.name && active.name !== 'Default'
            ? ' <span style="color:var(--third-color);font-size:0.72rem">' + escHtml(active.name) + '</span>'
            : '') +
          '</div>' +
          _arrReadOnlyHtml(active, arrCfg);
        panel.querySelector('[data-sid="' + _panelSid + '"]').appendChild(sec);
      })
      .catch(function() {});
  }

  // Async: setlist count
  // apiFetch, not fetch: this endpoint needs the token in a private workspace.
  apiFetch('/api/' + artistSlug + '/songs?setlists=' + sid)
    .then(function(r) { return r.ok ? r.json() : []; })
    .then(function(ids) {
      var linkEl = document.getElementById('vsp-setlist-link');
      if (!linkEl) return;
      if (!ids || !ids.length) { linkEl.textContent = t('songs.notInAnySetlist'); return; }
      var songTitle = song.title || '';
      linkEl.innerHTML = '<a href="#" onclick="event.preventDefault();openAppearances(' + Number(sid) + ')" style="color:var(--secondary-ink)">&#8594; ' + t('songs.setlistCount', { count: ids.length }) + '</a>';
    })
    .catch(function() {
      var linkEl = document.getElementById('vsp-setlist-link');
      if (linkEl) linkEl.textContent = '';
    });
}

function _openSongEditForm(sid, panelEl) {
  var isNew = sid === null;
  var song  = isNew ? { extra: {}, active: true } : songs.find(function(s) { return String(s.id) === String(sid); });
  if (!song && !isNew) return;

  var id = isNew ? ('_new_panel_' + Date.now()) : String(sid);

  var title    = escHtml(getVal(song, 'title') || '');
  var active   = song.active ? ' checked' : '';
  var heart    = song.heart  ? ' checked' : '';
  var genre    = escHtml(getVal(song, 'genre') || '');
  var energy   = escHtml(getVal(song, 'energy') || '');
  var timeSig  = escHtml(getVal(song, 'time_signature') || '');
  var bpm      = escHtml(String(getVal(song, 'bpm') || ''));
  var length   = escHtml(minsToTime(getVal(song, 'length_min')));
  var lead     = escHtml(getVal(song, 'extra.lead') || '');
  var git2     = getVal(song, 'extra.git2') ? ' checked' : '';
  var gitCapo  = escHtml(String(getVal(song, 'extra.gitCapo') || ''));
  var bjCapo   = escHtml(String(getVal(song, 'extra.banjoCapo') || ''));
  var harp     = getVal(song, 'extra.harp') ? ' checked' : '';
  var listen   = escHtml(getVal(song, 'extra.listenUrl') || '');
  var sheet    = escHtml(getVal(song, 'extra.sheetUrl') || '');
  var playback = escHtml(getVal(song, 'extra.playbackUrl') || '');
  var author   = escHtml(getVal(song, 'extra.author') || '');
  var interp   = escHtml(getVal(song, 'interpret') || '');
  var refInt   = escHtml(getVal(song, 'reference_interpret') || '');
  var refUrl   = escHtml(getVal(song, 'extra.referenceUrl') || '');
  var infoUrl  = escHtml(getVal(song, 'extra.songinfoUrl') || '');
  var comment  = escHtml(getVal(song, 'comment') || '');
  var lang     = (song.extra && song.extra.language) ? song.extra.language : 'EN';
  var iswc     = song.iswc || (song.extra && song.extra.iswc) || '';
  var gemaNr   = song.gema_work_number || '';
  var isrc     = (song.extra && song.extra.isrc) || '';

  var inp = function(key, val, type) {
    type = type || 'text';
    return '<input type="' + type + '" class="edit-input" data-id="' + id + '" data-key="' + key + '" value="' + val + '" oninput="markPanelEditDirty()">';
  };
  var num = function(key, val) {
    return '<input type="number" class="edit-input" data-id="' + id + '" data-key="' + key + '" value="' + val + '" min="0" step="1" inputmode="numeric" oninput="markPanelEditDirty()">';
  };
  var chk = function(key, checked) {
    return '<input type="checkbox" data-id="' + id + '" data-key="' + key + '"' + checked + ' onchange="markPanelEditDirty()">';
  };
  // Media row: URL field + ↑ upload. Existing songs upload immediately; new
  // songs stage the file and upload on save (no song id exists yet).
  var mediaRow = function(label, key, fileId, accept, type, urlVal) {
    var onchange = isNew
      ? '_panelStageFile(this,\'' + type + '\',\'' + id + '\')'
      : '_panelUploadHandler(this,\'' + id + '\',\'' + type + '\')';
    return _editField(label,
      '<div class="panel-file-row">' + inp(key, urlVal) +
        '<button type="button" class="btn panel-upload-btn" onclick="_panelUploadFile(\'' + fileId + '\')">&#8593;</button>' +
        '<input type="file" id="' + fileId + '" style="display:none" accept="' + accept + '" onchange="' + onchange + '">' +
      '</div>' +
      '<div class="panel-file-staged" id="staged-' + type + '-' + id + '" style="display:none;font-size:0.72rem;color:var(--third-color);margin-top:0.2rem"></div>');
  };

  var langOpts = GEMA_LANGUAGES.map(function(o) {
    return '<option value="' + o + '"' + (o === lang ? ' selected' : '') + '>' + o + '</option>';
  }).join('');

  panelEl.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h3 class="vsp-title">' + (isNew ? t('songs.newSong') : escHtml(song.title || t('songs.editSong'))) + '</h3></div>' +
      (!isNew ? '<button class="vsp-close" onclick="_openSongPanelContent({id:' + sid + '}, document.getElementById(\'view-side-panel-inner\'))" aria-label="' + t('songs.cancel') + '">&#215;</button>' : '') +
    '</div>' +
    '<div style="padding:0 0.5rem;" data-sid="' + id + '">' +
      '<details class="edit-section" open><summary class="edit-section-summary">' + t('songs.sectionBasics') + '</summary>' +
        '<div class="edit-section-body">' +
          _editField(t('songs.fieldTitle'), '<input type="text" class="edit-input" data-id="' + id + '" data-key="title" value="' + title + '" oninput="markPanelEditDirty()" placeholder="' + t('songs.songTitlePlaceholder') + '">') +
          _editField(t('songs.fieldKey'), '<select class="edit-input" data-id="' + id + '" data-key="key" onchange="markPanelEditDirty()">' + _keyOptions(getVal(song, 'key')) + '</select>') +
          _editField(t('songs.fieldGitCapo'), num('extra.gitCapo', gitCapo)) +
          _editField(t('songs.fieldBanjoCapo'), num('extra.banjoCapo', bjCapo)) +
          _editField(t('songs.fieldBpm'), num('bpm', bpm)) +
          _editField(t('songs.fieldTimeSig'), '<select class="edit-input" data-id="' + id + '" data-key="time_signature" onchange="markPanelEditDirty()"><option value="">—</option>' + TIME_SIGNATURES.map(function(v){return '<option value="'+v+'"'+(timeSig===v?' selected':'')+'>'+v+'</option>';}).join('') + '</select>') +
          _editField(t('songs.fieldLengthMmss'), '<input type="text" class="edit-input" data-id="' + id + '" data-key="length_min" data-type="time" value="' + length + '" placeholder="MM:SS" oninput="markPanelEditDirty()">') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.sectionRecordings') + '</summary>' +
        '<div class="edit-section-body">' +
          mediaRow(t('songs.listen'),   'extra.listenUrl',   'pf-audio-' + id,    'audio/*',              'audio',    listen) +
          mediaRow(t('songs.sheet'),    'extra.sheetUrl',    'pf-sheet-' + id,    '.pdf,application/pdf', 'sheet',    sheet) +
          mediaRow(t('songs.playback'), 'extra.playbackUrl', 'pf-playback-' + id, 'audio/*',              'playback', playback) +
          _editField(t('songs.fieldRefUrl'), inp('extra.referenceUrl', refUrl, 'url')) +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.lyricsTitle') + '</summary>' +
        '<div class="edit-section-body">' +
          '<button type="button" class="btn" onclick="_openLyricsFromPanel(\'' + id + '\',' + (isNew ? 'true' : 'false') + ',' + (isNew ? 'null' : sid) + ')">' + t('songs.openLyricsEditor') + '</button>' +
          (isNew ? '<input type="hidden" data-id="' + id + '" data-key="extra.lyrics" value="">' : '') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.sectionSongInfo') + '</summary>' +
        '<div class="edit-section-body">' +
          _editField('', '<div class="edit-toggle-row"><span>' + t('songs.active') + '</span><div class="toggle-switch"><input type="checkbox" data-id="' + id + '" data-key="active"' + active + ' onchange="markPanelEditDirty()"><span class="toggle-track"><span class="toggle-thumb"></span></span></div></div>') +
          _editField('', '<div class="edit-check-row">' + chk('heart', heart) + '<span>&#9829; ' + t('songs.favouriteHint') + '</span></div>') +
          _editField(t('songs.fieldGenre'), inp('genre', genre)) +
          _editField(t('songs.fieldEnergy'), inp('energy', energy)) +
          _editField(t('songs.fieldLanguage'), '<select class="edit-select edit-input" data-id="' + id + '" data-key="extra.language" onchange="markPanelEditDirty()">' + langOpts + '</select>') +
          _editField(t('songs.fieldLead'), inp('extra.lead', lead)) +
          _editField('', '<div class="edit-check-row">' + chk('extra.git2', git2) + '<span>' + t('songs.fieldGuitar2') + '</span></div>') +
          _editField('', '<div class="edit-check-row">' + chk('extra.harp', harp) + '<span>' + t('songs.fieldHarmonica') + '</span></div>') +
          _editField(t('songs.fieldRefInterpret'), inp('reference_interpret', refInt)) +
          _editField(t('songs.fieldSongInfoUrl'), inp('extra.songinfoUrl', infoUrl, 'url')) +
          _editField(t('songs.fieldComment'), inp('comment', comment)) +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.sectionRights') + '</summary>' +
        '<div class="edit-section-body">' +
          _editField(t('songs.fieldAuthor'), inp('extra.author', author)) +
          _editField(t('songs.fieldInterpret'), inp('interpret', interp)) +
          _editField('ISWC',    '<div class="edit-readonly">' + escHtml(iswc   || '—') + '</div>') +
          _editField('GEMA-Nr', '<div class="edit-readonly">' + escHtml(gemaNr || '—') + '</div>') +
          _editField('ISRC',    '<div class="edit-readonly">' + escHtml(isrc   || '—') + '</div>') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">' + t('songs.colTitleArrangement') + '</summary>' +
        '<div class="edit-section-body">' +
          (!isNew ? '<div id="edit-arr-preview"></div>' : '') +
          '<button class="btn" style="margin-top:0.4rem" onclick="_openArrFromPanel(\'' + id + '\',' + (isNew ? 'true' : 'false') + ',' + (isNew ? 'null' : sid) + ')">' + t('songs.openArrEditor') + '</button>' +
          (isNew ? '<div class="panel-file-staged" id="staged-arr-' + id + '" style="display:none;font-size:0.72rem;color:var(--third-color);margin-top:0.4rem"></div>' : '') +
        '</div>' +
      '</details>' +
      '<div class="status-msg" id="song-panel-edit-error"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn active auth-action" id="song-panel-save-btn" onclick="_savePanelSong(\'' + id + '\',' + (isNew ? 'true' : 'false') + ',' + (isNew ? 'null' : sid) + ')" disabled>' + (isNew ? t('songs.add') : t('songs.save')) + '</button>' +
        (!isNew ? '<button class="btn" onclick="_songsView && _songsView.select(\'' + sid + '\')">' + t('songs.cancel') + '</button>' : '') +
      '</div>' +
    '</div>';

  var titleInput = panelEl.querySelector('input[data-key="title"]');
  if (titleInput) titleInput.focus();

  if (!isNew && song.has_arrangement) {
    var _editArrSid = String(sid);
    var arrCfg = _songsCfg && _songsCfg.config && _songsCfg.config.arrangementConfig;
    apiFetch('/api/' + artistSlug + '/songs/' + _editArrSid + '/arrangements')
      .then(function(r) { return r.json(); })
      .then(function(versions) {
        var active = versions.find(function(v) { return v.is_active; });
        if (!active) return;
        var preview = document.getElementById('edit-arr-preview');
        if (!preview || !panelEl.querySelector('[data-sid="' + _editArrSid + '"]')) return;
        preview.innerHTML = _arrReadOnlyHtml(active, arrCfg);
      })
      .catch(function() {});
  }
}

// New-song file picks are deferred: stash the File in its hidden input and show
// the filename. The actual upload happens in _commitNewSong, once the song has
// an id. (Existing songs upload immediately via _panelUploadHandler.)
function _panelStageFile(input, type, id) {
  var file = input.files[0];
  if (!file) return;
  var maxBytes = type === 'sheet' ? 20 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > maxBytes) { input.value = ''; _setBulkStatus('error', t('songs.fileTooLarge')); return; }
  var label = document.getElementById('staged-' + type + '-' + id);
  if (label) { label.textContent = '✓ ' + t('songs.willUploadOnSave', { name: file.name }); label.style.display = ''; }
  markPanelEditDirty();
}

// Create a song from the panel, then upload any files staged on its inputs.
// Returns the created song, or null if it couldn't be created (no title / auth).
async function _commitNewSong(formId) {
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) { if (!isViewMode()) requireLogin(); return null; }

  var bad = [].slice.call(document.querySelectorAll('input[type="number"][data-id="' + formId + '"]'))
    .find(function(i) { return !i.checkValidity(); });
  if (bad) { bad.reportValidity(); bad.focus(); return null; }

  var data = collectRow(formId);
  if (!data.title) {
    var titleInput = document.querySelector('input[data-key="title"][data-id="' + formId + '"]');
    if (titleInput) titleInput.focus();
    return null;
  }

  var r = await fetch('/api/' + artistSlug + '/songs', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body:    JSON.stringify(data),
  });
  if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return null; }
  if (!r.ok) throw new Error('create failed');
  var newSong = await r.json();

  var staged = [['audio', 'pf-audio-'], ['sheet', 'pf-sheet-'], ['playback', 'pf-playback-']];
  for (var i = 0; i < staged.length; i++) {
    var inputEl = document.getElementById(staged[i][1] + formId);
    var file = inputEl && inputEl.files[0];
    if (!file) continue;
    try { await _uploadSongMedia(newSong.id, staged[i][0], file); }
    catch (err) { if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed')); }
  }

  // Persist a draft arrangement entered before the song existed, then activate it.
  var draft = _pendingArrDrafts[formId];
  if (draft) {
    try {
      var ar = await fetch('/api/' + artistSlug + '/songs/' + newSong.id + '/arrangements', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body:    JSON.stringify({ name: 'Default', rows: draft.rows, hidden_instruments: draft.hidden_instruments }),
      });
      if (ar.ok) {
        var created = await ar.json();
        await fetch('/api/' + artistSlug + '/songs/' + newSong.id + '/arrangements/' + created.id + '/activate', {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + token },
        });
      }
    } catch (e) { /* song is saved; arrangement just didn't attach */ }
    delete _pendingArrDrafts[formId];
  }
  return newSong;
}

async function _savePanelSong(formId, isNew, realSid) {
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) { if (!isViewMode()) requireLogin(); return; }

  var bad = [].slice.call(document.querySelectorAll('input[type="number"][data-id="' + formId + '"]'))
    .find(function(i) { return !i.checkValidity(); });
  if (bad) { bad.reportValidity(); bad.focus(); return; }

  var btn = document.getElementById('song-panel-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('songs.saving'); }

  try {
    var targetId;
    if (isNew) {
      var newSong = await _commitNewSong(formId);
      if (!newSong) { if (btn) { btn.disabled = false; btn.textContent = t('songs.add'); } return; }
      targetId = String(newSong.id);
    } else {
      var r = await fetch('/api/' + artistSlug + '/songs', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body:    JSON.stringify([Object.assign({ id: parseInt(realSid, 10) }, collectRow(formId))]),
      });
      if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
      if (!r.ok) throw new Error('save failed');
      targetId = String(realSid);
    }

    // Songs ride along in the cached /api/config payload (the setlist page reads
    // cfg.songs), so drop that cache or other pages keep serving the old list.
    invalidateConfigCache();
    await fetchSongsList(true);
    if (_songsView) { _songsView.refresh(); _songsView.select(targetId); }
    loadLogs();
  } catch {
    var errEl = document.getElementById('song-panel-edit-error');
    if (errEl) { errEl.textContent = t('songs.saveFailed'); errEl.className = 'status-msg error'; }
    if (btn) { btn.disabled = false; btn.textContent = isNew ? t('songs.add') : t('songs.save'); }
  }
}

function _isNewPanelSid(sid) { return String(sid).indexOf('_new_panel_') === 0; }

// Lyrics editor. Existing songs save through the API (needs an id). A new,
// unsaved song has no id, so it opens in local mode: lyrics are held in the
// panel's hidden field and written when the song is created (see saveLyrics).
function _openLyricsFromPanel(formId, isNew, sid) {
  if (!isNew) { openLyricsEdit(sid); return; }
  currentLyricsSid = formId;
  var hidden = document.querySelector('input[data-key="extra.lyrics"][data-id="' + formId + '"]');
  document.getElementById('lyrics-title').textContent = '¶ ' + t('songs.lyricsTitle');
  document.getElementById('lyrics-edit').value        = (hidden && hidden.value) || '';
  _lyricsSetMode('edit');
  document.getElementById('lyrics-modal').classList.add('open');
  document.getElementById('lyrics-edit').focus();
}

// Arrangement editor. Existing songs edit live against the API. A new, unsaved
// song opens a single-version draft held in memory; it's persisted on Add.
function _openArrFromPanel(formId, isNew, sid) {
  if (!isNew) { _openSongArrangement(sid); return; }
  var titleInput = document.querySelector('input[data-key="title"][data-id="' + formId + '"]');
  var title  = (titleInput && titleInput.value) || t('songs.newSong');
  var arrCfg = _songsCfg && _songsCfg.config && _songsCfg.config.arrangementConfig;
  openArrangementEditor(null, title, arrCfg, {
    draft: _pendingArrDrafts[formId] || null,
    onDraftSave: function(draft) {
      _pendingArrDrafts[formId] = draft;
      var cue = document.getElementById('staged-arr-' + formId);
      if (cue) { cue.textContent = '✓ ' + t('songs.arrStaged'); cue.style.display = ''; }
      markPanelEditDirty();
    },
  });
}

function _openNewSongPanel() {
  var panel = document.getElementById('view-side-panel');
  var inner = document.getElementById('view-side-panel-inner');
  if (!panel || !inner) return;

  var prev = document.querySelector('.lv-row--selected');
  if (prev) prev.classList.remove('lv-row--selected');

  _openSongEditForm(null, inner);
  panel.classList.add('open');
  document.getElementById('page-content').classList.add('side-panel-open');
  if (window.innerWidth <= 1024) document.body.style.overflow = 'hidden';

  if (_newPanelEscapeHandler) document.removeEventListener('keydown', _newPanelEscapeHandler);
  _newPanelEscapeHandler = function(e) {
    if (e.key === 'Escape') _closeNewSongPanel();
  };
  document.addEventListener('keydown', _newPanelEscapeHandler);
}

function _closeNewSongPanel() {
  if (_newPanelEscapeHandler) {
    document.removeEventListener('keydown', _newPanelEscapeHandler);
    _newPanelEscapeHandler = null;
  }
  var panel = document.getElementById('view-side-panel');
  if (panel) panel.classList.remove('open');
  var content = document.getElementById('page-content');
  if (content) content.classList.remove('side-panel-open');
  document.body.style.overflow = '';
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
    _songsView.setFilterValue('setlist', found.name || '');
  }
}

function _renderBulkEditTable() {
  // bulk edit table — populated below by moving old renderTable body
  const saved = getSavedWidths();
  const headers = COLS.map((c, i) => {
    const w = saved[c.key] ?? c.width;
    const sticky = i === 0 ? ' col-sticky' : '';
    const filter = FILTER_COLS[c.key] ? FILTER_COLS[c.key]() : '';
    return `<th class="${c.cls}${sticky}" data-col="${c.key}" style="width:${w}px${i === 0 ? ';left:0' : ''}"${c.title ? ` title="${c.title}"` : ''}>` +
           `<span class="col-label">${c.label}</span>` +
           `<div class="resize-handle"></div>` +
           `${filter}</th>`;
  }).join('') + '<th class="col-del" style="width:36px"></th>';
  const visible = getVisibleSongs();
  const rows = visible.map(s => renderRow(s)).join('');

  document.getElementById('page-content').innerHTML = `
    <div class="toolbar">
      <button class="btn active auth-action" id="save-btn" disabled>${t('songs.save')}</button>
      <button class="btn auth-action" id="discard-btn" disabled>${t('songs.discard')}</button>
      <button class="btn" id="add-btn">${t('songs.addSong')}</button>
      <span class="status" id="status"></span>
      <span class="filter-count" id="filter-count">${visible.length} / ${songs.length}</span>
      <button class="btn" onclick="toggleBulkEdit()">← ${t('songs.list')}</button>
      <button class="btn icon-btn auth-action" title="${t('songs.share')}" onclick="_songsShareMenu(this)">${SHARE_ICON}</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>${headers}</tr></thead>
        <tbody id="tbody">${rows}</tbody>
      </table>
    </div>
    <div id="logs-section"></div>`;

  document.getElementById('save-btn').addEventListener('click', saveAll);
  document.getElementById('discard-btn').addEventListener('click', discardAll);
  document.getElementById('add-btn').addEventListener('click', addRow);
  document.getElementById('tbody').addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    if (e.target.tagName === 'TEXTAREA') return; // let textarea handle Enter normally
    e.preventDefault();
    if (dirty.size > 0) saveAll();
  });
  document.getElementById('filter-text').addEventListener('input', e => {
    filters.text = e.target.value.toLowerCase();
    applyFilter();
  });
  document.getElementById('filter-active').addEventListener('change', e => {
    filters.active = e.target.checked;
    applyFilter();
  });
  document.getElementById('filter-heart').addEventListener('change', e => {
    filters.heart = e.target.checked;
    applyFilter();
  });
  document.getElementById('filter-lead').addEventListener('input', e => {
    filters.lead = e.target.value.toLowerCase();
    applyFilter();
  });
  document.getElementById('filter-cat').addEventListener('input', e => {
    filters.genre = e.target.value.toLowerCase();
    applyFilter();
  });

  initResizableColumns();

  requestAnimationFrame(() => {
    const appHeader = document.querySelector('.app-header');
    const toolbar   = document.querySelector('.toolbar');
    const tableWrap = document.querySelector('.table-wrap');
    if (appHeader && toolbar) {
      const hh = appHeader.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--songs-toolbar-top', `${hh}px`);
    }
    if (tableWrap) {
      const top = tableWrap.getBoundingClientRect().top;
      tableWrap.style.maxHeight = `${window.innerHeight - top - 24}px`;
    }
  });

  if (_pendingSetlistId) {
    var pending = _pendingSetlistId;
    _pendingSetlistId = 0;
    _applySetlistById(pending);
  }
}

function renderListRowHtml(s) {
  var sid       = String(s.id);
  var title     = escHtml(s.title || '(untitled)');
  var interp    = escHtml(s.interpret || '');
  var genre     = escHtml(s.genre || '');
  var key       = escHtml(String(getVal(s, 'key') || ''));
  var tempo     = escHtml(String(getVal(s, 'energy') || ''));
  var hasListen = !!getVal(s, 'extra.listenUrl');
  var hasLyrics = !!(String(getVal(s, 'extra.lyrics') || '').trim());

  var borderCls = s.active ? 'songs-list-row--active' : 'songs-list-row--inactive';
  var titleCls  = s.active ? '' : ' songs-list-row-title--inactive';

  var icons = '';
  if (hasListen) icons += '<button class="song-card-icon-btn" onclick="event.stopPropagation();openPlayer(\'' + sid + '\')" title="' + t('songs.listen') + '">&#9654;</button>';
  if (hasLyrics) icons += '<button class="song-card-icon-btn" onclick="event.stopPropagation();openLyrics(\'' + sid + '\')" title="' + t('songs.lyricsTitle') + '">&#182;</button>';
  var hasArrangement = !_viewMode && !!s.has_arrangement;
  if (hasArrangement) icons += '<button class="song-card-icon-btn" onclick="event.stopPropagation();_openSongArrangement(' + Number(s.id) + ')" title="' + t('songs.colTitleArrangement') + '">&#8862;</button>';

  return '<div class="songs-list-row ' + borderCls + '" data-id="' + escHtml(sid) + '">' +
    '<div class="songs-list-row-stack">' +
      '<span class="songs-list-row-title' + titleCls + '">' + title + '</span>' +
      (interp ? '<span class="songs-list-row-interpret">' + interp + '</span>' : '') +
    '</div>' +
    // The slots are always rendered, empty ones included — otherwise a song without a
    // genre shifts key and energy left and the columns no longer line up.
    '<span class="songs-list-row-genre">' + genre + '</span>' +
    '<span class="songs-list-row-key">'   + key   + '</span>' +
    '<span class="songs-list-row-tempo">' + tempo + '</span>' +
    '<span class="songs-list-row-icons">' + icons + '</span>' +
  '</div>';
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

function _editField(label, html) {
  return '<div class="edit-field">' +
    (label ? '<span class="edit-field-label">' + escHtml(label) + '</span>' : '') +
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

function exportCsv() {
  exportTableCsv(
    getVisibleSongs(),
    COLS.map(function(c) {
      return {
        label: c.label,
        getValue: function(song) {
          var raw = getVal(song, c.key);
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
  if (existing) { existing.remove(); return; }

  var menu = document.createElement('div');
  menu.id = 'share-menu-popup';
  menu.className = 'share-menu';
  menu.innerHTML =
    '<div class="share-menu-item" onclick="exportCsv();var m=document.getElementById(\'share-menu-popup\');if(m)m.remove()">' +
      '<span class="share-menu-icon">&#10515;</span><span class="share-menu-label">' + t('songs.exportCsv') + '</span>' +
    '</div>';

  var rect = btn.getBoundingClientRect();
  menu.style.cssText = 'position:fixed;top:' + (rect.bottom + 6) + 'px;left:' + rect.left + 'px';
  document.body.appendChild(menu);
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

function initResizableColumns() {
  const ths = document.querySelectorAll('thead th[data-col]');

  ths.forEach(th => {
    const handle = th.querySelector('.resize-handle');
    if (!handle) return;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX    = e.pageX;
      const startWidth = parseInt(th.style.width) || th.offsetWidth;
      handle.classList.add('resizing');
      document.body.style.cursor    = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        th.style.width = Math.max(40, startWidth + e.pageX - startX) + 'px';
      }

      function onUp() {
        handle.classList.remove('resizing');
        document.body.style.cursor    = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        const widths = {};
        document.querySelectorAll('thead th[data-col]').forEach(t => {
          widths[t.dataset.col] = parseInt(t.style.width);
        });
        localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths));
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });
}

function renderRow(song) {
  const sid = song.id || song._newId;
  const cells = COLS.map((c, i) => {
    const val = getVal(song, c.key);
    const sticky = i === 0 ? ' col-sticky' : '';
    if (c.type === 'stat') {
      let display = '—';
      if (val !== '' && val !== null && val !== undefined) {
        if (c.key === 'last_played_at') {
          display = new Date(val).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
        } else {
          display = String(val);
        }
      }
      let clickable = false, attrs = '';
      if (c.key === 'play_count' && song.id) {
        clickable = true;
        attrs = ` onclick="openAppearances(${song.id})"`;
      } else if (c.key === 'gema_work_number' && val && val !== '—' && song.id) {
        clickable = true;
        attrs = ` onclick="openGema(${song.id})"`;
      }
      return `<td class="${c.cls}${sticky}">
        <span class="stat-cell${clickable ? ' clickable' : ''}"${attrs}>${escHtml(display)}</span>
      </td>`;
    }
    if (c.type === 'listen') {
      const hasUrl = !!val;
      const actionBtn = hasUrl
        ? `<button class="listen-play-btn" onclick="openPlayer('${sid}')" title="${t('songs.play')}">▶</button>`
        : `<button class="listen-upload-btn" onclick="triggerAudioUpload('${sid}')" title="${t('songs.uploadAudio')}">↑</button>`;
      return `<td class="${c.cls}${sticky} listen-cell">
        <input type="text" data-id="${sid}" data-key="${c.key}"
          value="${escHtml(String(val))}" style="display:none">
        ${actionBtn}
        <input type="file" class="listen-file-input" accept="audio/*" style="display:none"
          onchange="handleAudioFile(this, '${sid}')">
      </td>`;
    }
    if (c.type === 'sheet') {
      const hasUrl = !!val;
      const actionBtn = hasUrl
        ? `<button class="sheet-open-btn" onclick="openSheet('${sid}')" title="${t('songs.openSheet')}">≡</button>`
        : `<button class="sheet-upload-btn" onclick="triggerSheetUpload('${sid}')" title="${t('songs.uploadPdf')}">↑</button>`;
      return `<td class="${c.cls}${sticky} sheet-cell">
        <input type="text" data-id="${sid}" data-key="${c.key}"
          value="${escHtml(String(val))}" style="display:none">
        ${actionBtn}
        <input type="file" class="sheet-file-input" accept=".pdf,application/pdf" style="display:none"
          onchange="handleSheetFile(this, '${sid}')">
      </td>`;
    }
    if (c.type === 'playback') {
      const hasUrl = !!val;
      const actionBtn = hasUrl
        ? `<button class="playback-open-btn" onclick="openPlayback('${sid}')" title="${t('songs.playPlayback')}">▷</button>`
        : `<button class="playback-upload-btn" onclick="triggerPlaybackUpload('${sid}')" title="${t('songs.uploadPlayback')}">↑</button>`;
      return `<td class="${c.cls}${sticky} playback-cell">
        <input type="text" data-id="${sid}" data-key="${c.key}"
          value="${escHtml(String(val))}" style="display:none">
        ${actionBtn}
        <input type="file" class="playback-file-input" accept="audio/*" style="display:none"
          onchange="handlePlaybackFile(this, '${sid}')">
      </td>`;
    }
    if (c.type === 'lyrics') {
      const hasLyrics = !!(val && String(val).trim());
      const actionBtn = hasLyrics
        ? `<button class="lyrics-open-btn" onclick="openLyrics('${sid}')" title="${t('songs.viewLyrics')}">¶</button>`
        : (_viewMode ? '' : `<button class="lyrics-add-btn"  onclick="openLyricsEdit('${sid}')" title="${t('songs.addLyrics')}">+</button>`);
      return `<td class="${c.cls}${sticky} lyrics-cell">
        <textarea data-id="${sid}" data-key="${c.key}" style="display:none">${escHtml(String(val ?? ''))}</textarea>
        ${actionBtn}
      </td>`;
    }
    if (c.type === 'arr') {
      const hasArr = !!val;
      const btn = (hasArr || !_viewMode)
        ? `<button class="arr-col-btn${hasArr ? '' : ' arr-col-btn--empty'}"
             onclick="_openSongArrangement(${Number(song.id)})"
             title="${hasArr ? t('songs.openArrangement') : t('songs.noArrangement')}">&#8862;</button>`
        : '';
      return `<td class="${c.cls}${sticky} arr-cell">${btn}</td>`;
    }
    if (c.type === 'bool') {
      return `<td class="${c.cls}${sticky}">
        <input type="checkbox" data-id="${sid}" data-key="${c.key}"
          ${val === true || val === 'true' || val === 1 ? 'checked' : ''}
          onchange="markDirty('${sid}')">
      </td>`;
    }
    if (c.type === 'time') {
      return `<td class="${c.cls}${sticky}">
        <input type="text" data-id="${sid}" data-key="${c.key}" data-type="time"
          value="${escHtml(minsToTime(val ?? 4))}" placeholder="MM:SS"
          oninput="markDirty('${sid}')">
      </td>`;
    }
    if (c.type === 'number') {
      return `<td class="${c.cls}${sticky}">
        <input type="number" data-id="${sid}" data-key="${c.key}"
          value="${escHtml(String(val))}" min="0" step="1" inputmode="numeric"
          oninput="markDirty('${sid}')">
      </td>`;
    }
    if (c.type === 'select') {
      const isLang = c.key === 'gema_language';
      // GEMA language is shadowed (read-only) once a GEMA work is linked.
      if (isLang && song.gema_work_number) {
        return `<td class="${c.cls}${sticky}"><span class="stat-cell">${escHtml(val || '—')}</span></td>`;
      }
      const cur = isLang ? (song.extra?.language || c.default || '') : (val ?? '');
      const dataKey = isLang ? 'extra.language' : c.key;
      let list = c.options || [];
      if (cur && list.indexOf(cur) === -1) list = [cur, ...list];
      const placeholder = isLang ? '' : '<option value="">—</option>';
      const opts = placeholder + list.map(o =>
        `<option value="${escHtml(o)}"${o === cur ? ' selected' : ''}>${escHtml(o)}</option>`
      ).join('');
      return `<td class="${c.cls}${sticky}">
        <select data-id="${sid}" data-key="${dataKey}" onchange="markDirty('${sid}')">${opts}</select>
      </td>`;
    }
    if (c.type === 'url') {
      const hasUrl = !!val;
      const btnCls = hasUrl ? 'url-edit-btn url-edit-btn--set' : 'url-edit-btn';
      const btnLbl = hasUrl ? '✓ Link' : '+ Add';
      return `<td class="${c.cls}${sticky} url-cell">
        <input type="text" data-id="${sid}" data-key="${c.key}" value="${escHtml(String(val))}" style="display:none">
        <button class="${btnCls}" onclick="openUrlPreview(this.previousElementSibling.value,this.previousElementSibling)">${btnLbl}</button>
      </td>`;
    }
    return `<td class="${c.cls}${sticky}">
      <input type="text" data-id="${sid}" data-key="${c.key}"
        value="${escHtml(String(val))}"
        oninput="markDirty('${sid}')">
    </td>`;
  }).join('');

  return `<tr id="row-${sid}" data-id="${sid}">${cells}
    <td class="col-del">
      <button class="del-btn" onclick="deleteRow('${sid}')" title="${t('songs.delete')}">&#215;</button>
    </td>
  </tr>`;
}

// --- Dirty tracking ---

function markDirty(sid) {
  dirty.add(String(sid));
  const row = document.getElementById(`row-${sid}`);
  if (row) row.classList.add('dirty');
  _setBulkStatus('unsaved', t('songs.unsavedChanges'));
  document.getElementById('save-btn')?.removeAttribute('disabled');
  document.getElementById('discard-btn')?.removeAttribute('disabled');
}

function _setBulkStatus(cls, msg) {
  const el = document.getElementById('status');
  if (!el) return;
  el.className = 'status ' + cls;
  el.textContent = msg;
}

// --- Collect row ---

function collectRow(sid) {
  const inputs = document.querySelectorAll(`input[data-id="${sid}"], textarea[data-id="${sid}"], select[data-id="${sid}"]`);
  const result = { extra: {} };
  for (const input of inputs) {
    const key = input.dataset.key;
    let val;
    if (input.type === 'checkbox')          val = input.checked;
    else if (input.dataset.type === 'time') val = timeToMins(input.value);
    else if (input.type === 'number')       val = input.value.trim() === '' ? null : parseFloat(input.value);
    else                                    val = input.value.trim() || null;
    if (key === 'title' && val) val = val.charAt(0).toUpperCase() + val.slice(1);
    if (key.startsWith('extra.')) result.extra[key.slice(6)] = val;
    else                          result[key] = val;
  }
  return result;
}

// --- Add / delete ---

function addRow() {
  newRowCounter++;
  const tempId = `_new_${newRowCounter}`;
  const blank  = { _newId: tempId, extra: {}, active: true, length_min: 4 };
  const tbody  = document.getElementById('tbody');
  const tr     = document.createElement('tr');
  tr.id = `row-${tempId}`;
  tr.dataset.id = tempId;
  // renderRow returns a full <tr>…</tr> — extract the innerHTML
  const tmp = document.createElement('tbody');
  tmp.innerHTML = renderRow(blank);
  tr.innerHTML = tmp.firstElementChild.innerHTML;
  tbody.appendChild(tr);
  dirty.add(tempId);
  tr.classList.add('dirty');
  tr.querySelector('input[type="text"]')?.focus();
  _setBulkStatus('unsaved', t('songs.unsavedChanges'));
}

async function deleteRow(sid) {
  // Unsaved new row — never reached the DB, just remove from DOM
  if (String(sid).startsWith('_new_')) {
    document.getElementById(`row-${sid}`)?.remove();
    dirty.delete(sid);
    if (dirty.size === 0) _setBulkStatus('', '');
    return;
  }

  if (!confirm(t('songs.confirmDeleteSong'))) return;

  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const r = await fetch(`/api/${artistSlug}/songs/${sid}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (r.ok || r.status === 404) {
    invalidateConfigCache();
    document.getElementById(`row-${sid}`)?.remove();
    dirty.delete(String(sid));
    songs = songs.filter(s => String(s.id) !== String(sid));
    if (dirty.size === 0) _setBulkStatus('', '');
  } else if (r.status === 401) {
    if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); }
  } else {
    _setBulkStatus('error', t('songs.couldNotDeleteSong'));
  }
}

// --- Save / Discard ---

function discardAll() {
  if (dirty.size === 0) return;
  dirty.clear();
  renderTable();
}

async function saveAll() {
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) { if (!isViewMode()) requireLogin(); return; }

  const bad = [...document.querySelectorAll('#tbody input[type="number"]')].find(i => !i.checkValidity());
  if (bad) { bad.reportValidity(); bad.focus(); return; }

  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = t('songs.saving');
  _setBulkStatus('', t('songs.saving'));

  try {
    const allRows  = [...document.querySelectorAll('#tbody tr')];
    const toUpdate = [];
    const toInsert = [];

    for (const tr of allRows) {
      const sid = tr.dataset.id;
      if (!dirty.has(sid)) continue;
      const data = collectRow(sid);
      if (sid.startsWith('_new_')) toInsert.push(data);
      else                          toUpdate.push({ id: parseInt(sid, 10), ...data });
    }

    if (toUpdate.length > 0) {
      const r = await fetch(`/api/${artistSlug}/songs`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(toUpdate),
      });
      if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
      if (!r.ok) throw new Error('patch failed');
    }

    for (const data of toInsert) {
      if (!data.title) continue;
      const r = await fetch(`/api/${artistSlug}/songs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error('insert failed');
    }

    dirty.clear();
    invalidateConfigCache();
    await loadAndRender();
    _setBulkStatus('saved', t('songs.allChangesSaved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);

  } catch {
    _setBulkStatus('error', t('songs.saveFailed'));
  } finally {
    const b = document.getElementById('save-btn');
    if (b) { b.disabled = false; b.textContent = t('songs.save'); }
  }
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

  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const items = logs.map(log => {
    const title = log.song_data?.title ?? '(unknown)';
    const badge = log.action === 'create' ? 'log-create'
                : log.action === 'delete' ? 'log-delete'
                : 'log-update';
    const label = log.action === 'create' ? t('songs.logAdded')
                : log.action === 'delete' ? t('songs.logDeleted')
                : t('songs.logUpdated');
    const restore = (log.action === 'delete' && token)
      ? `<button class="log-restore-btn" onclick="restoreSong(${log.song_id})">${t('songs.restore')}</button>`
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
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) return;
  const r = await fetch(`/api/${artistSlug}/songs/${songId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  });
  if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
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
    const data = await apiFetch(`/api/${artistSlug}/songs?setlists=${songId}`).then(r => r.ok ? r.json() : []);
    if (!data.length) {
      list.innerHTML = '<p class="appearance-empty">' + t('songs.notInAnySetlist') + '</p>';
      return;
    }
    list.innerHTML = data.map(sl => {
      const parts = [sl.gig_name, sl.gig_date ? String(sl.gig_date).slice(0, 10) : null, sl.gig_venue]
        .filter(Boolean);
      const label = parts.length ? parts.join(' — ') : (sl.title || `Setlist #${sl.id}`);
      const date  = new Date(sl.created_at).toLocaleDateString('fr-FR',
        { day: 'numeric', month: 'long', year: 'numeric' });
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

// --- Panel file upload (side-panel edit form) ---

function _panelUploadFile(inputId) {
  var el = document.getElementById(inputId);
  if (el) el.click();
}

async function _panelUploadHandler(input, sid, mediaType) {
  var file = input.files[0];
  input.value = '';
  if (!file) return;

  var maxBytes = mediaType === 'sheet' ? 20 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > maxBytes) { _setBulkStatus('error', t('songs.fileTooLarge')); return; }

  var btn = input.previousElementSibling;
  var origText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  try {
    var publicUrl = await _uploadSongMedia(sid, mediaType, file);
    var keyMap = { audio: 'extra.listenUrl', sheet: 'extra.sheetUrl', playback: 'extra.playbackUrl' };
    var panelInput = document.querySelector('[data-key="' + keyMap[mediaType] + '"][data-id="' + sid + '"]');
    if (panelInput) { panelInput.value = publicUrl; markPanelEditDirty(); }
    var song = songs.find(function(s) { return String(s.id) === String(sid); });
    var extraKeyMap = { audio: 'listenUrl', sheet: 'sheetUrl', playback: 'playbackUrl' };
    if (song) song.extra = Object.assign({}, song.extra, { [extraKeyMap[mediaType]]: publicUrl });
    _setBulkStatus('saved', t('songs.fileUploaded'));
    setTimeout(function() { _setBulkStatus('', ''); }, 3000);
    if (dirty.size > 0) saveAll();
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

// Shared presign → PUT → confirm pipeline for all media types.
// Returns publicUrl on success. Throws on failure; err.message is one of:
//   'auth'    — session expired (requireLogin already called; caller should bail silently)
//   'presign' — presign request failed
//   'storage' — PUT to storage failed
//   'confirm' — confirm request failed
async function _uploadSongMedia(sid, type, file) {
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  var contentType = type === 'sheet' ? 'application/pdf' : file.type;
  var r = await fetch('/api/' + artistSlug + '/songs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ upload_presign_id: sid, upload_type: type, filename: file.name, contentType: file.type, size: file.size }),
  });
  if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } throw new Error('auth'); }
  if (!r.ok) throw new Error('presign');

  var json = await r.json();
  var put = await fetch(json.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
  if (!put.ok) throw new Error('storage');

  var confirm = await fetch('/api/' + artistSlug + '/songs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ media_confirm_id: sid, media_type: type, publicUrl: json.publicUrl }),
  });
  if (confirm.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } throw new Error('auth'); }
  if (!confirm.ok) throw new Error('confirm');

  // Media URLs live in songs.extra, which the cached config payload carries.
  invalidateConfigCache();
  return json.publicUrl;
}

// --- Audio upload ---

function triggerAudioUpload(sid) {
  const row = document.getElementById(`row-${sid}`);
  if (!row) return;
  row.querySelector('.listen-file-input')?.click();
}

async function handleAudioFile(input, sid) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > 50 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' })); return; }

  const uploadBtn = document.querySelector(`#row-${sid} .listen-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'audio', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), listenUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .listen-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.listen-upload-btn')?.remove();
      if (!td.querySelector('.listen-play-btn')) {
        const btn = document.createElement('button');
        btn.className = 'listen-play-btn'; btn.title = t('songs.play'); btn.textContent = '▶';
        btn.setAttribute('onclick', `openPlayer('${sid}')`);
        td.prepend(btn);
      }
    }
    _setBulkStatus('saved', t('songs.audioUploaded'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
    if (dirty.size > 0) saveAll();
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (uploadBtn) { uploadBtn.textContent = uploadBtn.dataset.orig || '↑'; uploadBtn.classList.remove('listen-uploading'); uploadBtn.disabled = false; }
  }
}

// --- Player modal ---

function toEmbedUrl(url) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1`;
  // SoundCloud uses cross-site tracking — open in new tab instead
  return null;
}

function openPlayer(sid) {
  const row  = document.getElementById(`row-${sid}`);
  const song = songs.find(s => String(s.id) === String(sid));
  const url  = (row?.querySelector('.listen-cell input[type="text"]')?.value?.trim())
             || song?.extra?.listenUrl || '';
  if (!url) return;

  const title = song?.title ?? row?.querySelector('[data-key="title"]')?.value ?? 'Listen';

  currentPlayerSid = sid;
  document.getElementById('player-title').textContent = `♪ ${title}`;

  const isAudio  = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(url);
  const embedUrl = toEmbedUrl(url);
  const content  = document.getElementById('player-content');

  if (isAudio) {
    content.innerHTML = `<div class="audio-speed-wrap"><audio controls src="${escHtml(url)}" autoplay></audio><div class="audio-speed-btns"><button onclick="_setAudioSpeed(this,0.7)">0.7×</button><button onclick="_setAudioSpeed(this,0.8)">0.8×</button><button onclick="_setAudioSpeed(this,0.9)">0.9×</button></div></div>`;
  } else if (embedUrl) {
    content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(embedUrl)}"
      allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
  } else {
    content.innerHTML = `<p class="player-link"><a href="${escHtml(url)}" target="_blank" rel="noopener">${t('songs.openNewTab')}</a></p>`;
  }

  // Reset delete confirm state
  document.getElementById('player-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('player-delete-btn').style.display = '';
  document.getElementById('player-history').innerHTML = '';

  // Fetch audio history for this song
  apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
    .then(r => r.ok ? r.json() : [])
    .then(renderPlayerHistory)
    .catch(() => {});

  document.getElementById('player-modal').classList.add('open');
}

function closePlayer() {
  document.getElementById('player-modal').classList.remove('open');
  document.getElementById('player-content').innerHTML = ''; // stops playback
  document.getElementById('player-history').innerHTML = '';
  document.getElementById('player-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('player-delete-btn').style.display = '';
  currentPlayerSid = null;
}

function showDeleteConfirm() {
  document.getElementById('player-delete-btn').style.display = 'none';
  document.getElementById('player-delete-confirm').style.display = 'flex';
}

function cancelDeleteAudio() {
  document.getElementById('player-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('player-delete-btn').style.display = '';
}

async function confirmDeleteAudio() {
  const sid = currentPlayerSid;
  if (!sid) return;
  closePlayer();

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ media_delete_id: sid, media_type: 'audio' }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { _setBulkStatus('error', t('songs.couldNotRemoveAudio')); return; }
    invalidateConfigCache();

    // Update local cache and swap ▶ back to ↑ in the table cell
    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.listenUrl;
    const td = document.querySelector(`#row-${sid} .listen-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = '';
      td.querySelector('.listen-play-btn')?.remove();
      if (!td.querySelector('.listen-upload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'listen-upload-btn';
        btn.title = t('songs.uploadAudio');
        btn.textContent = '↑';
        btn.setAttribute('onclick', `triggerAudioUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    _setBulkStatus('saved', t('songs.audioRemoved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch {
    _setBulkStatus('error', t('songs.couldNotRemoveAudio'));
  }
}

function triggerReplaceAudio() {
  document.getElementById('player-file-input').click();
}

async function handleReplaceFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const sid = currentPlayerSid;
  if (!sid) return;
  if (file.size > 50 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' })); return; }

  const replaceBtn = document.getElementById('player-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'audio', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), listenUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .listen-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;
    const isAudio = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(publicUrl);
    const embedUrl = toEmbedUrl(publicUrl);
    const content = document.getElementById('player-content');
    if (isAudio) {
      content.innerHTML = `<div class="audio-speed-wrap"><audio controls src="${escHtml(publicUrl)}" autoplay></audio><div class="audio-speed-btns"><button onclick="_setAudioSpeed(this,0.7)">0.7×</button><button onclick="_setAudioSpeed(this,0.8)">0.8×</button><button onclick="_setAudioSpeed(this,0.9)">0.9×</button></div></div>`;
    } else if (embedUrl) {
      content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(embedUrl)}" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
    } else {
      content.innerHTML = `<p class="player-link"><a href="${escHtml(publicUrl)}" target="_blank" rel="noopener">${t('songs.openNewTab')}</a></p>`;
    }
    apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`).then(r => r.ok ? r.json() : []).then(renderPlayerHistory).catch(() => {});
    _setBulkStatus('saved', t('songs.audioReplaced'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (replaceBtn) { replaceBtn.textContent = t('songs.replace'); replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderPlayerHistory(logs) {
  const el = document.getElementById('player-history');
  if (!el) return;
  const audio = logs.filter(l => l.action === 'audio_replace' || l.action === 'audio_delete');
  if (!audio.length) { el.innerHTML = ''; return; }

  const items = audio.map(log => {
    const desc = log.action === 'audio_replace'
      ? t('songs.histReplaced', { file: escHtml(log.song_data?.previousFilename ?? '?') })
      : t('songs.histRemoved', { file: escHtml(log.song_data?.filename ?? '?') });
    return `<div class="player-history-item">
      <span class="player-history-time">${timeAgo(log.changed_at)}</span>
      <span>${desc}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<h3 class="player-history-heading">${t('songs.history')}</h3>${items}`;
}

// --- Sheet (PDF) column ---

function triggerSheetUpload(sid) {
  const row = document.getElementById(`row-${sid}`);
  if (!row) return;
  row.querySelector('.sheet-file-input')?.click();
}

async function handleSheetFile(input, sid) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > 20 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '20 MB' })); return; }

  const uploadBtn = document.querySelector(`#row-${sid} .sheet-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'sheet', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), sheetUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.sheet-upload-btn')?.remove();
      if (!td.querySelector('.sheet-open-btn')) {
        const btn = document.createElement('button');
        btn.className = 'sheet-open-btn'; btn.title = t('songs.openSheet'); btn.textContent = '≡';
        btn.setAttribute('onclick', `openSheet('${sid}')`);
        td.prepend(btn);
      }
    }
    _setBulkStatus('saved', t('songs.sheetUploaded'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
    if (dirty.size > 0) saveAll();
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (uploadBtn) { uploadBtn.textContent = uploadBtn.dataset.orig || '↑'; uploadBtn.classList.remove('listen-uploading'); uploadBtn.disabled = false; }
  }
}

function openSheet(sid) {
  const row  = document.getElementById(`row-${sid}`);
  const song = songs.find(s => String(s.id) === String(sid));
  const url  = (row?.querySelector('.sheet-cell input[type="text"]')?.value?.trim())
             || song?.extra?.sheetUrl || '';
  if (!url) return;

  const title = song?.title ?? row?.querySelector('[data-key="title"]')?.value ?? 'Sheet';

  currentSheetSid = sid;
  document.getElementById('sheet-title').textContent = `≡ ${title}`;
  document.getElementById('sheet-open-link').href = url;
  document.getElementById('sheet-content').innerHTML =
    `<div class="sheet-embed"><iframe src="${escHtml(url)}" title="Sheet"></iframe></div>`;

  document.getElementById('sheet-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('sheet-delete-btn').style.display = '';
  document.getElementById('sheet-history').innerHTML = '';

  apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
    .then(r => r.ok ? r.json() : [])
    .then(renderSheetHistory)
    .catch(() => {});

  document.getElementById('sheet-modal').classList.add('open');
}

function closeSheet() {
  document.getElementById('sheet-modal').classList.remove('open');
  document.getElementById('sheet-content').innerHTML = ''; // unload iframe
  document.getElementById('sheet-history').innerHTML = '';
  document.getElementById('sheet-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('sheet-delete-btn').style.display = '';
  currentSheetSid = null;
}

function showSheetDeleteConfirm() {
  document.getElementById('sheet-delete-btn').style.display = 'none';
  document.getElementById('sheet-delete-confirm').style.display = 'flex';
}

function cancelDeleteSheet() {
  document.getElementById('sheet-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('sheet-delete-btn').style.display = '';
}

async function confirmDeleteSheet() {
  const sid = currentSheetSid;
  if (!sid) return;
  closeSheet();

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ media_delete_id: sid, media_type: 'sheet' }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { _setBulkStatus('error', t('songs.couldNotRemoveSheet')); return; }
    invalidateConfigCache();

    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.sheetUrl;
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = '';
      td.querySelector('.sheet-open-btn')?.remove();
      if (!td.querySelector('.sheet-upload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'sheet-upload-btn';
        btn.title = t('songs.uploadPdf');
        btn.textContent = '↑';
        btn.setAttribute('onclick', `triggerSheetUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    _setBulkStatus('saved', t('songs.sheetRemoved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch {
    _setBulkStatus('error', t('songs.couldNotRemoveSheet'));
  }
}

function triggerReplaceSheet() {
  document.getElementById('sheet-file-input').click();
}

async function handleReplaceSheet(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const sid = currentSheetSid;
  if (!sid) return;
  if (file.size > 20 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '20 MB' })); return; }

  const replaceBtn = document.getElementById('sheet-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'sheet', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), sheetUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;
    document.getElementById('sheet-content').innerHTML = `<div class="sheet-embed"><iframe src="${escHtml(publicUrl)}" title="Sheet"></iframe></div>`;
    apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`).then(r => r.ok ? r.json() : []).then(renderSheetHistory).catch(() => {});
    _setBulkStatus('saved', t('songs.sheetReplaced'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (replaceBtn) { replaceBtn.textContent = t('songs.replace'); replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderSheetHistory(logs) {
  const el = document.getElementById('sheet-history');
  if (!el) return;
  const sheets = logs.filter(l => l.action === 'sheet_replace' || l.action === 'sheet_delete');
  if (!sheets.length) { el.innerHTML = ''; return; }

  const items = sheets.map(log => {
    const desc = log.action === 'sheet_replace'
      ? t('songs.histReplaced', { file: escHtml(log.song_data?.previousFilename ?? '?') })
      : t('songs.histRemoved', { file: escHtml(log.song_data?.filename ?? '?') });
    return `<div class="player-history-item">
      <span class="player-history-time">${timeAgo(log.changed_at)}</span>
      <span>${desc}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<h3 class="player-history-heading">${t('songs.history')}</h3>${items}`;
}

document.getElementById('player-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closePlayer();
});

document.getElementById('sheet-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSheet();
});

// --- Playback column ---

function triggerPlaybackUpload(sid) {
  document.getElementById(`row-${sid}`)?.querySelector('.playback-file-input')?.click();
}

async function handlePlaybackFile(input, sid) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > 50 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' })); return; }

  const uploadBtn = document.querySelector(`#row-${sid} .playback-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'playback', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), playbackUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.playback-upload-btn')?.remove();
      if (!td.querySelector('.playback-open-btn')) {
        const btn = document.createElement('button');
        btn.className = 'playback-open-btn'; btn.title = t('songs.playPlayback'); btn.textContent = '▷';
        btn.setAttribute('onclick', `openPlayback('${sid}')`);
        td.prepend(btn);
      }
    }
    _setBulkStatus('saved', t('songs.playbackUploaded'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
    if (dirty.size > 0) saveAll();
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (uploadBtn) { uploadBtn.textContent = uploadBtn.dataset.orig || '↑'; uploadBtn.classList.remove('listen-uploading'); uploadBtn.disabled = false; }
  }
}

function openPlayback(sid) {
  const row  = document.getElementById(`row-${sid}`);
  const song = songs.find(s => String(s.id) === String(sid));
  const url  = (row?.querySelector('.playback-cell input[type="text"]')?.value?.trim())
             || song?.extra?.playbackUrl || '';
  if (!url) return;

  const title = song?.title ?? row?.querySelector('[data-key="title"]')?.value ?? 'Playback';

  currentPlaybackSid = sid;
  document.getElementById('playback-title').textContent = `▷ ${title}`;

  const isAudio  = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(url);
  const embedUrl = toEmbedUrl(url);
  const content  = document.getElementById('playback-content');
  if (isAudio) {
    content.innerHTML = `<div class="audio-speed-wrap"><audio controls src="${escHtml(url)}" autoplay style="width:100%;margin:1rem 0;display:block"></audio><div class="audio-speed-btns"><button onclick="_setAudioSpeed(this,0.7)">0.7×</button><button onclick="_setAudioSpeed(this,0.8)">0.8×</button><button onclick="_setAudioSpeed(this,0.9)">0.9×</button></div></div>`;
  } else if (embedUrl) {
    content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(embedUrl)}" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
  } else {
    content.innerHTML = `<p class="player-link"><a href="${escHtml(url)}" target="_blank" rel="noopener">${t('songs.openNewTab')}</a></p>`;
  }

  document.getElementById('playback-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('playback-delete-btn').style.display = '';
  document.getElementById('playback-history').innerHTML = '';

  apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
    .then(r => r.ok ? r.json() : [])
    .then(renderPlaybackHistory)
    .catch(() => {});

  document.getElementById('playback-modal').classList.add('open');
}

function closePlayback() {
  document.getElementById('playback-modal').classList.remove('open');
  document.getElementById('playback-content').innerHTML = ''; // stops playback
  document.getElementById('playback-history').innerHTML = '';
  document.getElementById('playback-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('playback-delete-btn').style.display = '';
  currentPlaybackSid = null;
}

function showPlaybackDeleteConfirm() {
  document.getElementById('playback-delete-btn').style.display = 'none';
  document.getElementById('playback-delete-confirm').style.display = 'flex';
}

function cancelDeletePlayback() {
  document.getElementById('playback-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('playback-delete-btn').style.display = '';
}

async function confirmDeletePlayback() {
  const sid = currentPlaybackSid;
  if (!sid) return;
  closePlayback();

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ media_delete_id: sid, media_type: 'playback' }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { _setBulkStatus('error', t('songs.couldNotRemovePlayback')); return; }
    invalidateConfigCache();

    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.playbackUrl;
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = '';
      td.querySelector('.playback-open-btn')?.remove();
      if (!td.querySelector('.playback-upload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'playback-upload-btn';
        btn.title = t('songs.uploadPlayback');
        btn.textContent = '↑';
        btn.setAttribute('onclick', `triggerPlaybackUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    _setBulkStatus('saved', t('songs.playbackRemoved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch {
    _setBulkStatus('error', t('songs.couldNotRemovePlayback'));
  }
}

function triggerReplacePlayback() {
  document.getElementById('playback-file-input').click();
}

async function handleReplacePlayback(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const sid = currentPlaybackSid;
  if (!sid) return;
  if (file.size > 50 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' })); return; }

  const replaceBtn = document.getElementById('playback-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'playback', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), playbackUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;
    document.getElementById('playback-content').innerHTML =
      `<div class="audio-speed-wrap"><audio controls src="${escHtml(publicUrl)}" autoplay style="width:100%;margin:1rem 0;display:block"></audio><div class="audio-speed-btns"><button onclick="_setAudioSpeed(this,0.7)">0.7×</button><button onclick="_setAudioSpeed(this,0.8)">0.8×</button><button onclick="_setAudioSpeed(this,0.9)">0.9×</button></div></div>`;
    apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`).then(r => r.ok ? r.json() : []).then(renderPlaybackHistory).catch(() => {});
    _setBulkStatus('saved', t('songs.playbackReplaced'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (replaceBtn) { replaceBtn.textContent = t('songs.replace'); replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderPlaybackHistory(logs) {
  const el = document.getElementById('playback-history');
  if (!el) return;
  const items = logs.filter(l => l.action === 'playback_replace' || l.action === 'playback_delete');
  if (!items.length) { el.innerHTML = ''; return; }

  el.innerHTML = `<h3 class="player-history-heading">${t('songs.history')}</h3>` + items.map(log => {
    const desc = log.action === 'playback_replace'
      ? t('songs.histReplaced', { file: escHtml(log.song_data?.previousFilename ?? '?') })
      : t('songs.histRemoved', { file: escHtml(log.song_data?.filename ?? '?') });
    return `<div class="player-history-item">
      <span class="player-history-time">${timeAgo(log.changed_at)}</span>
      <span>${desc}</span>
    </div>`;
  }).join('');
}

document.getElementById('playback-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closePlayback();
});

// --- Lyrics column ---

function _lyricsSetMode(mode) { // 'view' or 'edit'
  document.getElementById('lyrics-suggest-preview').style.display = 'none';
  document.getElementById('lyrics-view').style.display        = mode === 'view' ? '' : 'none';
  document.getElementById('lyrics-edit').style.display        = mode === 'edit' ? '' : 'none';
  document.getElementById('lyrics-actions-view').style.display = mode === 'view' ? '' : 'none';
  document.getElementById('lyrics-actions-edit').style.display = mode === 'edit' ? '' : 'none';
  // AI suggest needs a saved song (title + artist) — hide it for a new, unsaved one.
  var suggestBtn = document.getElementById('lyrics-suggest-btn');
  if (suggestBtn) suggestBtn.style.display = _isNewPanelSid(currentLyricsSid) ? 'none' : '';
  _lyricsSaveStatus('', false);
}

function openLyrics(sid) {
  const song  = songs.find(s => String(s.id) === String(sid));
  const title = song?.title ?? 'Lyrics';
  const text  = song?.extra?.lyrics ?? '';

  currentLyricsSid = sid;
  document.getElementById('lyrics-title').textContent = `¶ ${title}`;
  document.getElementById('lyrics-view').textContent  = text;
  document.getElementById('lyrics-edit').value        = text;
  document.getElementById('lyrics-delete-confirm').style.display = 'none';
  document.getElementById('lyrics-delete-btn').style.display     = _viewMode ? 'none' : '';
  _lyricsSetMode('view');
  document.getElementById('lyrics-modal').classList.add('open');
}

function openLyricsEdit(sid) {
  const song  = songs.find(s => String(s.id) === String(sid));
  const title = song?.title ?? 'Lyrics';

  currentLyricsSid = sid;
  document.getElementById('lyrics-title').textContent = `¶ ${title}`;
  document.getElementById('lyrics-edit').value        = song?.extra?.lyrics ?? '';
  _lyricsSetMode('edit');
  document.getElementById('lyrics-modal').classList.add('open');
  document.getElementById('lyrics-edit').focus();
}

function closeLyrics() {
  if (_lyricsSuggestAbort) { _lyricsSuggestAbort.abort(); _lyricsSuggestAbort = null; }
  document.getElementById('lyrics-suggest-preview').style.display = 'none';
  document.getElementById('lyrics-modal').classList.remove('open');
  currentLyricsSid = null;
}

function _lyricsShowSuggestState(header, text, showActions) {
  document.getElementById('lyrics-suggest-header').textContent          = header;
  document.getElementById('lyrics-suggest-text').textContent            = text;
  document.getElementById('lyrics-suggest-actions').style.display       = showActions ? '' : 'none';
  document.getElementById('lyrics-suggest-preview').style.display       = '';
}

async function suggestLyrics() {
  if (!currentLyricsSid) return;
  const btn = document.getElementById('lyrics-suggest-btn');
  if (!btn) return;
  btn.textContent = '…'; btn.disabled = true;
  _lyricsShowSuggestState(t('songs.lyricsSearching'), '', false);
  _lyricsSuggestAbort = new AbortController();
  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ lyrics_suggest_id: currentLyricsSid }),
      signal: _lyricsSuggestAbort.signal,
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      _lyricsShowSuggestState(body.error ?? t('songs.lyricsCouldNotFetch'), '', false);
      return;
    }
    const data = await r.json();
    const sourcesList = data.sources ? data.sources.join(', ') : t('songs.lyricsAllSources');
    if (!data.lyrics) {
      const aiNote = data.aiSkipped ? ' ' + t('songs.lyricsAiQuota') : '';
      _lyricsShowSuggestState(t('songs.lyricsNotFound', { sources: sourcesList }) + aiNote, '', false);
      return;
    }
    _lyricsShowSuggestState(t('songs.lyricsSuggestedVia', { source: data.source }), data.lyrics, true);
  } catch (e) {
    if (e.name !== 'AbortError') _lyricsShowSuggestState(t('songs.lyricsCouldNotFetch'), '', false);
  } finally {
    btn.textContent = t('songs.aiBtn'); btn.disabled = false;
    _lyricsSuggestAbort = null;
  }
}

function _lyricsAcceptSuggestion() {
  document.getElementById('lyrics-edit').value = document.getElementById('lyrics-suggest-text').textContent;
  document.getElementById('lyrics-suggest-preview').style.display = 'none';
  saveLyrics();
}

function _lyricsDiscardSuggestion() {
  document.getElementById('lyrics-suggest-preview').style.display = 'none';
}

function startEditLyrics() {
  document.getElementById('lyrics-edit').value = document.getElementById('lyrics-view').textContent;
  _lyricsSetMode('edit');
  document.getElementById('lyrics-edit').focus();
}

function cancelEditLyrics() {
  const song = songs.find(s => String(s.id) === String(currentLyricsSid));
  if (song?.extra?.lyrics) {
    _lyricsSetMode('view');
  } else {
    closeLyrics();
  }
}

function _lyricsSaveStatus(msg, isError) {
  const el = document.getElementById('lyrics-save-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color  = isError ? 'var(--danger-color)' : 'var(--third-color)';
  el.style.display = msg ? '' : 'none';
}

async function saveLyrics() {
  const sid = currentLyricsSid;
  if (!sid) return;
  const text = document.getElementById('lyrics-edit').value;

  // New, unsaved song: stash lyrics in the panel; they persist when it's created.
  if (_isNewPanelSid(sid)) {
    const hidden = document.querySelector(`input[data-key="extra.lyrics"][data-id="${sid}"]`);
    if (hidden) { hidden.value = text; markPanelEditDirty(); }
    closeLyrics();
    return;
  }

  const saveBtn = document.getElementById('lyrics-save-btn');
  if (saveBtn) { saveBtn.textContent = t('songs.savingDot'); saveBtn.disabled = true; }
  _lyricsSaveStatus('', false);

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ lyrics_update_id: sid, lyrics: text }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } closeLyrics(); return; }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const msg = body.error ?? t('songs.saveFailedStatus', { status: r.status });
      _lyricsSaveStatus(msg, true);
      console.error('saveLyrics failed', r.status, body);
      return;
    }
    invalidateConfigCache();

    // Update local cache and DOM
    const song = songs.find(s => String(s.id) === String(sid));
    const trimmed = text.trim() || null;
    if (song) { song.extra = { ...(song.extra ?? {}), lyrics: trimmed }; }

    const td = document.querySelector(`#row-${sid} .lyrics-cell`);
    if (td) {
      td.querySelector('textarea').value = trimmed ?? '';
      const existing = td.querySelector('.lyrics-open-btn, .lyrics-add-btn');
      if (trimmed && existing?.classList.contains('lyrics-add-btn')) {
        existing.className = 'lyrics-open-btn';
        existing.textContent = '¶';
        existing.title = t('songs.viewLyrics');
        existing.setAttribute('onclick', `openLyrics('${sid}')`);
      } else if (!trimmed && existing?.classList.contains('lyrics-open-btn')) {
        existing.className = 'lyrics-add-btn';
        existing.textContent = '+';
        existing.title = t('songs.addLyrics');
        existing.setAttribute('onclick', `openLyricsEdit('${sid}')`);
      }
    }

    if (trimmed) {
      document.getElementById('lyrics-view').textContent = trimmed;
      _lyricsSetMode('view');
    } else {
      closeLyrics();
    }
    _setBulkStatus('saved', t('songs.lyricsSaved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch (e) {
    _lyricsSaveStatus(t('songs.networkErrorSave'), true);
    console.error('saveLyrics network error', e);
  } finally {
    if (saveBtn) { saveBtn.textContent = t('songs.save'); saveBtn.disabled = false; }
  }
}

function showLyricsDeleteConfirm() {
  document.getElementById('lyrics-delete-btn').style.display     = 'none';
  document.getElementById('lyrics-delete-confirm').style.display = 'flex';
}

function cancelDeleteLyrics() {
  document.getElementById('lyrics-delete-confirm').style.display = 'none';
  document.getElementById('lyrics-delete-btn').style.display     = '';
}

async function confirmDeleteLyrics() {
  const sid = currentLyricsSid;
  if (!sid) return;
  closeLyrics();

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ lyrics_delete_id: sid }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { _setBulkStatus('error', t('songs.couldNotDeleteLyrics')); return; }
    invalidateConfigCache();

    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.lyrics;

    const td = document.querySelector(`#row-${sid} .lyrics-cell`);
    if (td) {
      td.querySelector('textarea').value = '';
      const btn = td.querySelector('.lyrics-open-btn');
      if (btn) {
        btn.className = 'lyrics-add-btn';
        btn.textContent = '+';
        btn.title = t('songs.addLyrics');
        btn.setAttribute('onclick', `openLyricsEdit('${sid}')`);
      }
    }
    _setBulkStatus('saved', t('songs.lyricsDeleted'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch {
    _setBulkStatus('error', t('songs.couldNotDeleteLyrics'));
  }
}

document.getElementById('lyrics-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLyrics();
});

// ── URL preview modal ─────────────────────────────────────────────────────────

var _urlPreviewSourceInput = null;

function _setPreviewSrc(url) {
  const iframe  = document.getElementById('url-preview-iframe');
  const loading = document.getElementById('url-preview-loading');
  if (url) {
    loading.style.display = '';
    iframe.style.display  = 'none';
    iframe.src = toEmbedUrl(url) || url;
  } else {
    loading.style.display = 'none';
    iframe.style.display  = '';
    iframe.src = '';
  }
}

function openUrlPreview(url, sourceInput) {
  _urlPreviewSourceInput = sourceInput || null;
  document.getElementById('url-preview-input').value = url || '';
  document.getElementById('url-preview-link').href   = url || '#';
  document.getElementById('url-preview-link').style.display = url ? '' : 'none';
  _setPreviewSrc(url);
  document.getElementById('url-preview-modal').classList.add('open');
  document.getElementById('url-preview-input').focus();
}

function reloadUrlPreview() {
  const url = document.getElementById('url-preview-input').value.trim();
  document.getElementById('url-preview-link').href  = url || '#';
  document.getElementById('url-preview-link').style.display = url ? '' : 'none';
  _setPreviewSrc(url);
  if (_urlPreviewSourceInput) {
    _urlPreviewSourceInput.value = url;
    markDirty(_urlPreviewSourceInput.dataset.id);
    _syncUrlBtn(_urlPreviewSourceInput);
  }
}

function _syncUrlBtn(input) {
  const btn = input.nextElementSibling;
  if (!btn) return;
  const has = !!input.value.trim();
  btn.textContent = has ? '✓ Link' : '+ Add';
  btn.classList.toggle('url-edit-btn--set', has);
}

function closeUrlPreview() {
  const url = document.getElementById('url-preview-input').value.trim();
  if (_urlPreviewSourceInput) {
    _urlPreviewSourceInput.value = url;
    markDirty(_urlPreviewSourceInput.dataset.id);
    _syncUrlBtn(_urlPreviewSourceInput);
  }
  document.getElementById('url-preview-modal').classList.remove('open');
  document.getElementById('url-preview-iframe').src = '';
  _urlPreviewSourceInput = null;
}

document.getElementById('url-preview-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeUrlPreview();
});

document.getElementById('url-preview-iframe').addEventListener('load', () => {
  document.getElementById('url-preview-loading').style.display = 'none';
  document.getElementById('url-preview-iframe').style.display  = '';
});

registerModal('player-modal',   closePlayer);
registerModal('sheet-modal',    closeSheet);
registerModal('playback-modal', closePlayback);
registerModal('lyrics-modal',   closeLyrics);

window.refreshAllActionBtns = function() {
  _viewMode = isViewMode();
  var inner = document.getElementById('view-side-panel-inner');
  if (inner) {
    var sidEl = inner.querySelector('[data-sid]');
    if (sidEl && sidEl.dataset.sid) {
      _openSongPanelContent({ id: sidEl.dataset.sid }, inner);
    }
  }
};

function _setAudioSpeed(btn, rate) {
  var wrap = btn.closest('.vsp-audio-block, .audio-speed-wrap, .song-stage-rec');
  var audio = wrap && wrap.querySelector('audio');
  if (audio) audio.playbackRate = rate;
  btn.parentNode.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
}

init();
