// Songs management page

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
var _newPanelEscapeHandler = null;
var SONGS_BULK_EDIT_KEY = 'songs_bulk_edit';
var _viewMode = false;
var _songsOffset = 0;
var _songsTotal = 0;
var SONGS_VIEW_PAGE = 30;

function isMobile() { return window.innerWidth <= 1024; }
function isBulkEdit() { return !isMobile() && localStorage.getItem(SONGS_BULK_EDIT_KEY) === '1'; }

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
  // Magic link login: /songs?magic=TOKEN
  const params = new URLSearchParams(window.location.search);
  const magic = params.get('magic');
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
  if (_vm) document.body.classList.add('view-mode');
  await loadAndRender(_vm);
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
  const r = await fetch(`/api/${artistSlug}/songs?${params}`);
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
  counter.textContent = 'Showing ' + songs.length + ' of ' + total + ' song' + (total !== 1 ? 's' : '');
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
    '<button id="songs-load-more-btn" class="btn" onclick="loadMoreSongs()">Load more</button>';
  var container = document.getElementById('page-content');
  if (container) container.appendChild(footer);
}

async function loadAndRender(viewMode) {
  try {
    if (!artistSlug) {
      const cfg = await getConfig();
      artistSlug = cfg.slug;
      applyNav(cfg.name, cfg.config);
    }
    await fetchSongsList(true);
    var _qp = new URLSearchParams(location.search);
    _pendingSetlistId = Number(_qp.get('setlist_id'));
    _pendingSongId    = String(_qp.get('id') || '');
    renderTable();
    loadLogs();
    _viewMode = viewMode || false;
    if (viewMode) applyViewMode();
  } catch {
    const el = document.getElementById('page-content');
    if (el) el.innerHTML = '<p style="color:var(--third-color);text-align:center;">Failed to load songs.</p>';
  }
}

// --- Table ---

var COLS = [
  { key: 'title',               label: 'title',              type: 'text',   cls: 'col-title',   width: 180 },
  { key: 'active',              label: 'active',             type: 'bool',   cls: 'col-active',  width: 48  },
  { key: 'extra.listenUrl',    label: '▶',                  type: 'listen',   cls: 'col-listen',   width: 52, title: 'Listen — reference recording'  },
  { key: 'extra.sheetUrl',     label: '≡',                  type: 'sheet',    cls: 'col-sheet',    width: 52, title: 'Sheet — chords & lyrics PDF'   },
  { key: 'extra.playbackUrl',  label: '▷',                  type: 'playback', cls: 'col-playback', width: 52, title: 'Playback — backing track'       },
  { key: 'extra.lyrics',       label: '¶',                  type: 'lyrics',   cls: 'col-lyrics',   width: 52, title: 'Lyrics'                          },
  { key: 'play_count',          label: 'plays',              type: 'stat',   cls: 'col-plays',   width: 50  },
  { key: 'last_played_at',      label: 'last live',          type: 'stat',   cls: 'col-last',    width: 86  },
  { key: 'iswc',                label: 'ISWC',               type: 'stat',   cls: 'col-iswc',    width: 110, title: 'ISWC (GEMA/SACEM)' },
  { key: 'gema_work_number',    label: 'GEMA-Nr',            type: 'stat',   cls: 'col-gema',    width: 116, title: 'GEMA Werknummer' },
  { key: 'gema_language',       label: 'lang',               type: 'select', cls: 'col-glang',   width: 56,  title: 'Language (GEMA)', options: ['EN', 'FR', 'DE'], default: 'EN' },
  { key: 'extra.isrc',          label: 'ISRC',               type: 'stat',   cls: 'col-isrc',    width: 120, title: 'ISRC (recording)' },
  { key: 'key',                 label: 'key',                type: 'text',   cls: 'col-key',     width: 52  },
  { key: 'extra.lead',          label: 'lead',               type: 'text',   cls: 'col-lead',    width: 80  },
  { key: 'extra.banjoCapo',     label: 'banjoCapo',          type: 'number', cls: 'col-bcapo',   width: 58  },
  { key: 'extra.git2',          label: 'git2',               type: 'bool',   cls: 'col-lgit',    width: 70  },
  { key: 'extra.gitCapo',       label: 'gitCapo',            type: 'number', cls: 'col-kcapo',   width: 58  },
  { key: 'extra.harp',          label: 'harp',               type: 'bool',   cls: 'col-harp',    width: 58  },
  { key: 'genre',            label: 'genre',           type: 'text',   cls: 'col-cat',     width: 100 },
  { key: 'tempo',               label: 'tempo',              type: 'text',   cls: 'col-tempo',   width: 70  },
  { key: 'bpm',                 label: 'bpm',                type: 'number', cls: 'col-bpm',     width: 55  },
  { key: 'length_min',          label: 'length',             type: 'time',   cls: 'col-len',     width: 68  },
  { key: 'extra.author',        label: 'author',             type: 'text',   cls: 'col-author',  width: 130 },
  { key: 'interpret',           label: 'interpret',          type: 'text',   cls: 'col-interp',  width: 140 },
  { key: 'reference_interpret', label: 'reference_interpret', type: 'text',  cls: 'col-refint',  width: 140 },
  { key: 'extra.referenceUrl',  label: 'referenceUrl',       type: 'url',    cls: 'col-refurl',  width: 120 },
  { key: 'extra.songinfoUrl',   label: 'songinfoUrl',        type: 'url',    cls: 'col-infourl', width: 120 },
  { key: 'comment',             label: 'comment',            type: 'text',   cls: 'col-comment', width: 160 },
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

var filters = { text: '', active: true, lead: '', genre: '', interpret: '', setlist: '' };

var _setlistFilterIds   = null;   // null = no filter; Set<songId>
var _setlistFilterOrder = [];     // song IDs in setlist position order
var _setlistFilterTimer = null;
var _allSetlistsMeta    = null;   // [{id, name}] fetched once on demand
var _songsView          = null;

function getVisibleSongs() {
  var result = songs.filter(function(s) {
    if (filters.active    && !s.active) return false;
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
      var r = await fetch('/api/' + artistSlug + '/setlists');
      _allSetlistsMeta = await r.json();
      if (!Array.isArray(_allSetlistsMeta)) _allSetlistsMeta = [];
    } catch { _allSetlistsMeta = []; }
  }
  try {
    var detail = await fetch('/api/' + artistSlug + '/setlists/' + id).then(function(r) { return r.json(); });
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
  'title':      () => `<input type="text" id="filter-text" class="col-filter" placeholder="Search…" value="${escHtml(filters.text)}" autocomplete="off">`,
  'active':     () => `<input type="checkbox" id="filter-active" class="col-filter-check" title="Active only" ${filters.active ? 'checked' : ''}>`,
  'extra.lead': () => `<input type="text" id="filter-lead" class="col-filter" placeholder="…" value="${escHtml(filters.lead)}" autocomplete="off">`,
  'genre':   () => `<input type="text" id="filter-cat" class="col-filter" placeholder="…" value="${escHtml(filters.genre)}" autocomplete="off">`,
};

function renderTable() {
  if (isBulkEdit()) { _renderBulkEditTable(); return; }
  _renderSongsListView();
}

async function _resolveSetlistFilter(q) {
  if (!_allSetlistsMeta) {
    try {
      var r = await fetch('/api/' + artistSlug + '/setlists');
      _allSetlistsMeta = await r.json();
      if (!Array.isArray(_allSetlistsMeta)) _allSetlistsMeta = [];
    } catch { _allSetlistsMeta = []; }
  }
  var matches = _allSetlistsMeta.filter(function(s) {
    return (s.name || '').toLowerCase().includes(q.toLowerCase());
  });
  if (!matches.length) return new Set();

  try {
    var detail = await fetch('/api/' + artistSlug + '/setlists/' + matches[0].id)
      .then(function(r) { return r.json(); });
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

function _renderSongsListView() {
  _songsView = createListView({
    container: document.getElementById('page-content'),
    filters: [
      { id: 'title',     label: 'Title',       type: FILTER_TYPES.TEXT,       field: 'title'     },
      { id: 'interpret', label: 'Interpret',    type: FILTER_TYPES.TEXT,       field: 'interpret' },
      { id: 'setlist',   label: 'Setlist',      type: FILTER_TYPES.ASYNC_TEXT,
        resolve: _resolveSetlistFilter },
      { id: 'active',    label: 'Active only',  type: FILTER_TYPES.CHECKBOX,   field: 'active', 'default': true },
      { id: 'genre',     label: 'Genre',        type: FILTER_TYPES.CHIPS,      field: 'genre',
        getValues: function() {
          return Array.from(new Set(songs.map(function(s) { return s.genre; }).filter(Boolean))).sort();
        }},
    ],
    actions: (isViewMode() ? [] : [
      { label: '+ Add song', onClick: _openNewSongPanel },
      { label: 'Bulk Edit',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/></svg>',
        title: 'Bulk Edit',
        onClick: toggleBulkEdit,
        desktopOnly: true },
    ]).concat([
      { label: 'Export CSV', onClick: exportCsv },
    ]),
    getData:   _getSongsForFactory,
    getTotal:  function() { return getToken() ? songs.length : _songsTotal; },
    getItemId: function(s) { return s.id; },
    renderRow: renderListRowHtml,
    onOpen:    _openSongPanelContent,
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
  }

  loadLogs();
}

function _openSongPanelContent(item, panelEl) {
  var song = songs.find(function(s) { return String(s.id) === String(item.id); });
  if (!song) return;
  var sid = String(song.id);

  var title = escHtml(song.title || '(untitled)');
  var activeDot = song.active
    ? '<span class="vsp-active-dot vsp-active-dot--on">&#9679; active</span>'
    : '<span class="vsp-active-dot vsp-active-dot--off">&#9679; inactive</span>';

  var listenUrl   = getVal(song, 'extra.listenUrl');
  var playbackUrl = getVal(song, 'extra.playbackUrl');
  var lyricsVal   = String(getVal(song, 'extra.lyrics') || '').trim();
  var sheetUrl    = getVal(song, 'extra.sheetUrl');
  var sidEsc      = escHtml(sid);
  var audioRe     = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i;

  var audioHtml = '';
  if (listenUrl  && audioRe.test(listenUrl))
    audioHtml += '<div class="vsp-audio-block"><div class="vsp-audio-label">&#9654; Listen</div><audio class="vsp-audio" controls src="' + escHtml(listenUrl) + '"></audio></div>';
  if (playbackUrl && audioRe.test(playbackUrl))
    audioHtml += '<div class="vsp-audio-block"><div class="vsp-audio-label">&#9655; Playback</div><audio class="vsp-audio" controls src="' + escHtml(playbackUrl) + '"></audio></div>';

  var actions = '';
  if (!_viewMode) actions += '<button class="btn icon-btn" data-tooltip="Edit song" onclick="_openSongEditForm(\'' + sidEsc + '\', document.getElementById(\'view-side-panel-inner\'))">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/>' +
    '</svg></button>';
  actions += '<a class="btn icon-btn" data-tooltip="Stage view (full-screen)" href="/stage?song=' + sidEsc + '" target="_blank" rel="noopener">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/>' +
    '</svg></a>';
  if (!_viewMode) actions += '<button class="btn icon-btn" data-tooltip="Lyrics" onclick="openLyrics(\'' + sidEsc + '\')">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/>' +
    '</svg></button>';
  if (listenUrl  && !audioRe.test(listenUrl))   actions += '<button class="btn" onclick="openPlayer(\'' + sidEsc + '\')">&#9654; Listen</button>';
  if (playbackUrl && !audioRe.test(playbackUrl)) actions += '<button class="btn" onclick="openPlayback(\'' + sidEsc + '\')">&#9655; Playback</button>';
  if (sheetUrl)   actions += '<button class="btn" onclick="openSheet(\'' + sidEsc + '\')">&#8801; Sheet</button>';

  var key     = getVal(song, 'key');
  var tempo   = getVal(song, 'tempo');
  var bpm     = getVal(song, 'bpm');
  var len     = minsToTime(getVal(song, 'length_min'));
  var lead    = getVal(song, 'extra.lead');
  var gitCapo = getVal(song, 'extra.gitCapo');
  var bjCapo  = getVal(song, 'extra.banjoCapo');
  var git2    = getVal(song, 'extra.git2');
  var harp    = getVal(song, 'extra.harp');
  var perfCells =
    (key     ? _vspCell('Key',        escHtml(String(key)))     : '') +
    (tempo   ? _vspCell('Tempo',      escHtml(String(tempo)))   : '') +
    (bpm     ? _vspCell('BPM',        escHtml(String(bpm)))     : '') +
    (len     ? _vspCell('Length',     escHtml(len))             : '') +
    (lead    ? _vspCell('Lead',       escHtml(String(lead)))    : '') +
    (gitCapo ? _vspCell('Git capo',   escHtml(String(gitCapo))) : '') +
    (bjCapo  ? _vspCell('Banjo capo', escHtml(String(bjCapo)))  : '') +
    (git2    ? _vspCell('2nd guitar', '&#10003;')               : '') +
    (harp    ? _vspCell('Harmonica',  '&#10003;')               : '');
  var perfHtml = perfCells ? _vspSection('Performance', perfCells) : '';

  var genre   = getVal(song, 'genre');
  var interp  = getVal(song, 'interpret');
  var refInt  = getVal(song, 'reference_interpret');
  var author  = getVal(song, 'extra.author');
  var comment = getVal(song, 'comment');
  var refUrl  = getVal(song, 'extra.referenceUrl');
  var infoUrl = getVal(song, 'extra.songinfoUrl');
  var aboutCells =
    (genre   ? _vspCell('Genre',          escHtml(String(genre)))  : '') +
    (interp  ? _vspCell('Interpret',      escHtml(String(interp))) : '') +
    (refInt  ? _vspCell('Ref. interpret', escHtml(String(refInt))) : '') +
    (author  ? _vspCell('Author',         escHtml(String(author))) : '') +
    (comment ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">Comment</div><div class="vsp-cell-value">' + escHtml(String(comment)) + '</div></div>' : '') +
    (refUrl  ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">Reference</div><div class="vsp-cell-value"><a href="' + escHtml(String(refUrl))  + '" target="_blank" rel="noopener">' + escHtml(String(refUrl))  + '</a></div></div>' : '') +
    (infoUrl ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-label">Song info</div><div class="vsp-cell-value"><a href="' + escHtml(String(infoUrl)) + '" target="_blank" rel="noopener">' + escHtml(String(infoUrl)) + '</a></div></div>' : '');
  var aboutHtml = aboutCells ? _vspSection('About', aboutCells) : '';

  var plays    = getVal(song, 'play_count');
  var lastLive = getVal(song, 'last_played_at');
  var statsCells =
    (plays    ? _vspCell('Plays',     escHtml(String(plays))) : '') +
    (lastLive ? _vspCell('Last live', escHtml(String(lastLive).slice(0, 10))) : '');
  var statsHtml = statsCells ? _vspSection('Stats', statsCells) : '';

  var lang   = getVal(song, 'gema_language') || (song.extra && song.extra.language) || '';
  var gemaNr = getVal(song, 'gema_work_number');
  var iswc   = song.iswc || (song.extra && song.extra.iswc) || '';
  var isrc   = (song.extra && song.extra.isrc) || '';
  var rightsCells =
    (lang   ? _vspCell('Lang',    escHtml(String(lang)))   : '') +
    (gemaNr ? _vspCell('GEMA-Nr', escHtml(String(gemaNr))) : '') +
    (iswc   ? _vspCell('ISWC',   escHtml(String(iswc)))   : '') +
    (isrc   ? _vspCell('ISRC',   escHtml(String(isrc)))   : '');
  var rightsHtml = rightsCells ? _vspSection('Rights', rightsCells) : '';

  var lyricsHtml = lyricsVal
    ? '<div class="vsp-section-label">Lyrics</div><div class="vsp-lyrics">' + escHtml(lyricsVal) + '</div>'
    : '';

  panelEl.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text">' +
        '<h3 class="vsp-title">' + title + '</h3>' + activeDot +
      '</div>' +
      '<button class="vsp-close" onclick="_songsView && _songsView.deselect()" aria-label="Close">&#215;</button>' +
    '</div>' +
    (audioHtml || actions ? audioHtml + '<div class="vsp-actions">' + actions + '</div>' : '') +
    perfHtml + aboutHtml + statsHtml + rightsHtml +
    '<div class="vsp-cell vsp-cell--full" id="vsp-setlist-link" style="color:var(--third-color);font-size:0.82rem;">Loading setlists…</div>' +
    lyricsHtml;

  // Async: setlist count
  var _panelSid = sid;
  fetch('/api/' + artistSlug + '/songs?setlists=' + sid)
    .then(function(r) { return r.json(); })
    .then(function(ids) {
      var linkEl = document.getElementById('vsp-setlist-link');
      if (!linkEl) return;
      if (!ids || !ids.length) { linkEl.textContent = 'Not in any setlist'; return; }
      var songTitle = song.title || '';
      linkEl.innerHTML = '<a href="#" onclick="event.preventDefault();openAppearances(' + Number(sid) + ')" style="color:var(--secondary-ink)">&#8594; ' + ids.length + ' setlist' + (ids.length !== 1 ? 's' : '') + ' with this song</a>';
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
  var genre    = escHtml(getVal(song, 'genre') || '');
  var tempo    = escHtml(getVal(song, 'tempo') || '');
  var bpm      = escHtml(String(getVal(song, 'bpm') || ''));
  var length   = escHtml(minsToTime(getVal(song, 'length_min')));
  var key      = escHtml(getVal(song, 'key') || '');
  var lead     = escHtml(getVal(song, 'extra.lead') || '');
  var git2     = getVal(song, 'extra.git2') ? ' checked' : '';
  var gitCapo  = escHtml(String(getVal(song, 'extra.gitCapo') || ''));
  var bjCapo   = escHtml(String(getVal(song, 'extra.banjoCapo') || ''));
  var harp     = getVal(song, 'extra.harp') ? ' checked' : '';
  var listen   = escHtml(getVal(song, 'extra.listenUrl') || '');
  var sheet    = escHtml(getVal(song, 'extra.sheetUrl') || '');
  var playback = escHtml(getVal(song, 'extra.playbackUrl') || '');
  var lyrics   = escHtml(String(getVal(song, 'extra.lyrics') || ''));
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
    return '<input type="number" class="edit-input" data-id="' + id + '" data-key="' + key + '" value="' + val + '" min="0" step="any" oninput="markPanelEditDirty()">';
  };
  var chk = function(key, checked) {
    return '<input type="checkbox" data-id="' + id + '" data-key="' + key + '"' + checked + ' onchange="markPanelEditDirty()">';
  };

  var langOpts = ['EN', 'FR', 'DE'].map(function(o) {
    return '<option value="' + o + '"' + (o === lang ? ' selected' : '') + '>' + o + '</option>';
  }).join('');

  panelEl.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h3 class="vsp-title">' + (isNew ? 'New song' : escHtml(song.title || 'Edit song')) + '</h3></div>' +
      (!isNew ? '<button class="vsp-close" onclick="_openSongPanelContent({id:' + sid + '}, document.getElementById(\'view-side-panel-inner\'))" aria-label="Cancel">&#215;</button>' : '') +
    '</div>' +
    '<div style="padding:0 0.5rem;">' +
      '<details class="edit-section" open><summary class="edit-section-summary">General</summary>' +
        '<div class="edit-section-body">' +
          _editField('Title', '<input type="text" class="edit-input" data-id="' + id + '" data-key="title" value="' + title + '" oninput="markPanelEditDirty()" placeholder="Song title">') +
          _editField('', '<div class="edit-toggle-row"><span>Active</span><div class="toggle-switch"><input type="checkbox" data-id="' + id + '" data-key="active"' + active + ' onchange="markPanelEditDirty()"><span class="toggle-track"><span class="toggle-thumb"></span></span></div></div>') +
          _editField('Genre', inp('genre', genre)) +
          _editField('Tempo', inp('tempo', tempo)) +
          _editField('BPM', num('bpm', bpm)) +
          _editField('Length (MM:SS)', '<input type="text" class="edit-input" data-id="' + id + '" data-key="length_min" data-type="time" value="' + length + '" placeholder="MM:SS" oninput="markPanelEditDirty()">') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">Performance</summary>' +
        '<div class="edit-section-body">' +
          _editField('Key', inp('key', key)) +
          _editField('Lead', inp('extra.lead', lead)) +
          _editField('', '<div class="edit-check-row">' + chk('extra.git2', git2) + '<span>2nd guitar</span></div>') +
          _editField('Guitar capo', num('extra.gitCapo', gitCapo)) +
          _editField('Banjo capo', num('extra.banjoCapo', bjCapo)) +
          _editField('', '<div class="edit-check-row">' + chk('extra.harp', harp) + '<span>Harmonica</span></div>') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">Files & Lyrics</summary>' +
        '<div class="edit-section-body">' +
          _editField('Listen', '<div class="panel-file-row">' + inp('extra.listenUrl', listen) + (!isNew ? '<button class="btn panel-upload-btn" onclick="_panelUploadFile(\'pf-audio-' + id + '\')">&#8593;</button><input type="file" id="pf-audio-' + id + '" style="display:none" accept="audio/*" onchange="_panelUploadHandler(this,\'' + id + '\',\'audio\')">' : '') + '</div>') +
          _editField('Sheet', '<div class="panel-file-row">' + inp('extra.sheetUrl', sheet) + (!isNew ? '<button class="btn panel-upload-btn" onclick="_panelUploadFile(\'pf-sheet-' + id + '\')">&#8593;</button><input type="file" id="pf-sheet-' + id + '" style="display:none" accept=".pdf,application/pdf" onchange="_panelUploadHandler(this,\'' + id + '\',\'sheet\')">' : '') + '</div>') +
          _editField('Playback', '<div class="panel-file-row">' + inp('extra.playbackUrl', playback) + (!isNew ? '<button class="btn panel-upload-btn" onclick="_panelUploadFile(\'pf-playback-' + id + '\')">&#8593;</button><input type="file" id="pf-playback-' + id + '" style="display:none" accept="audio/*" onchange="_panelUploadHandler(this,\'' + id + '\',\'playback\')">' : '') + '</div>') +
          _editField('Lyrics', '<textarea class="edit-textarea edit-input" data-id="' + id + '" data-key="extra.lyrics" oninput="markPanelEditDirty()" placeholder="Enter lyrics…">' + lyrics + '</textarea>') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">Metadata</summary>' +
        '<div class="edit-section-body">' +
          _editField('Author', inp('extra.author', author)) +
          _editField('Interpret', inp('interpret', interp)) +
          _editField('Reference interpret', inp('reference_interpret', refInt)) +
          _editField('Reference URL', inp('extra.referenceUrl', refUrl, 'url')) +
          _editField('Song info URL', inp('extra.songinfoUrl', infoUrl, 'url')) +
          _editField('Comment', inp('comment', comment)) +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">GEMA / Rights</summary>' +
        '<div class="edit-section-body">' +
          _editField('Language', '<select class="edit-select edit-input" data-id="' + id + '" data-key="extra.language" onchange="markPanelEditDirty()">' + langOpts + '</select>') +
          (iswc   ? _editField('ISWC',    '<div class="edit-readonly">' + escHtml(iswc)   + '</div>') : '') +
          (gemaNr ? _editField('GEMA-Nr', '<div class="edit-readonly">' + escHtml(gemaNr) + '</div>') : '') +
          (isrc   ? _editField('ISRC',    '<div class="edit-readonly">' + escHtml(isrc)   + '</div>') : '') +
        '</div>' +
      '</details>' +
      '<div class="status-msg" id="song-panel-edit-error"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn active auth-action" id="song-panel-save-btn" onclick="_savePanelSong(\'' + id + '\',' + (isNew ? 'true' : 'false') + ',' + (isNew ? 'null' : sid) + ')" disabled>' + (isNew ? 'Add' : 'Save') + '</button>' +
        (!isNew ? '<button class="btn" onclick="_songsView && _songsView.select(\'' + sid + '\')">Cancel</button>' : '') +
      '</div>' +
    '</div>';

  var titleInput = panelEl.querySelector('input[data-key="title"]');
  if (titleInput) titleInput.focus();
}

async function _savePanelSong(formId, isNew, realSid) {
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) { if (!isViewMode()) requireLogin(); return; }

  var btn = document.getElementById('song-panel-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  var data = collectRow(formId);

  try {
    var r;
    if (isNew) {
      if (!data.title) {
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
        return;
      }
      r = await fetch('/api/' + artistSlug + '/songs', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body:    JSON.stringify(data),
      });
    } else {
      r = await fetch('/api/' + artistSlug + '/songs', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body:    JSON.stringify([Object.assign({ id: parseInt(realSid, 10) }, data)]),
      });
    }

    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) throw new Error('save failed');

    var newSong = isNew ? await r.json() : null;
    await fetchSongsList(true);
    if (_songsView) {
      _songsView.refresh();
      var targetId = isNew ? String(newSong.id) : String(realSid);
      _songsView.select(targetId);
    }
    loadLogs();
  } catch {
    var errEl = document.getElementById('song-panel-edit-error');
    if (errEl) { errEl.textContent = 'Save failed — try again.'; errEl.className = 'status-msg error'; }
    if (btn) { btn.disabled = false; btn.textContent = isNew ? 'Add' : 'Save'; }
  }
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
      var r = await fetch('/api/' + artistSlug + '/setlists');
      _allSetlistsMeta = await r.json();
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
      <button class="btn active auth-action" id="save-btn" disabled>Save</button>
      <button class="btn auth-action" id="discard-btn" disabled>Discard</button>
      <button class="btn" id="add-btn">+ Add song</button>
      <span class="status" id="status"></span>
      <span class="filter-count" id="filter-count">${visible.length} / ${songs.length}</span>
      <button class="btn" onclick="toggleBulkEdit()">← List</button>
      <button class="btn auth-action" onclick="exportCsv()">Export CSV</button>
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
  document.getElementById('filter-text').addEventListener('input', e => {
    filters.text = e.target.value.toLowerCase();
    applyFilter();
  });
  document.getElementById('filter-active').addEventListener('change', e => {
    filters.active = e.target.checked;
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
  var tempo     = escHtml(String(getVal(s, 'tempo') || ''));
  var hasListen = !!getVal(s, 'extra.listenUrl');
  var hasLyrics = !!(String(getVal(s, 'extra.lyrics') || '').trim());

  var borderCls = s.active ? 'songs-list-row--active' : 'songs-list-row--inactive';
  var titleCls  = s.active ? '' : ' songs-list-row-title--inactive';

  var icons = '';
  if (hasListen) icons += '<button class="song-card-icon-btn" onclick="event.stopPropagation();openPlayer(\'' + sid + '\')" title="Listen">&#9654;</button>';
  if (hasLyrics) icons += '<button class="song-card-icon-btn" onclick="event.stopPropagation();openLyrics(\'' + sid + '\')" title="Lyrics">&#182;</button>';

  return '<div class="songs-list-row ' + borderCls + '" data-id="' + escHtml(sid) + '">' +
    '<div class="songs-list-row-stack">' +
      '<span class="songs-list-row-title' + titleCls + '">' + title + '</span>' +
      (interp ? '<span class="songs-list-row-interpret">' + interp + '</span>' : '') +
    '</div>' +
    (genre ? '<span class="songs-list-row-genre">' + genre + '</span>' : '') +
    (key   ? '<span class="songs-list-row-key">'   + key   + '</span>' : '') +
    (tempo ? '<span class="songs-list-row-tempo">'  + tempo + '</span>' : '') +
    (icons ? '<span class="songs-list-row-icons">'  + icons + '</span>' : '') +
  '</div>';
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
        ? `<button class="listen-play-btn" onclick="openPlayer('${sid}')" title="Play">▶</button>`
        : `<button class="listen-upload-btn" onclick="triggerAudioUpload('${sid}')" title="Upload audio">↑</button>`;
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
        ? `<button class="sheet-open-btn" onclick="openSheet('${sid}')" title="Open sheet">≡</button>`
        : `<button class="sheet-upload-btn" onclick="triggerSheetUpload('${sid}')" title="Upload PDF">↑</button>`;
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
        ? `<button class="playback-open-btn" onclick="openPlayback('${sid}')" title="Play playback">▷</button>`
        : `<button class="playback-upload-btn" onclick="triggerPlaybackUpload('${sid}')" title="Upload playback">↑</button>`;
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
        ? `<button class="lyrics-open-btn" onclick="openLyrics('${sid}')" title="View lyrics">¶</button>`
        : `<button class="lyrics-add-btn"  onclick="openLyricsEdit('${sid}')" title="Add lyrics">+</button>`;
      return `<td class="${c.cls}${sticky} lyrics-cell">
        <textarea data-id="${sid}" data-key="${c.key}" style="display:none">${escHtml(String(val ?? ''))}</textarea>
        ${actionBtn}
      </td>`;
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
          value="${escHtml(String(val))}" min="0" step="any"
          oninput="markDirty('${sid}')">
      </td>`;
    }
    if (c.type === 'select') {
      if (song.gema_work_number) {
        return `<td class="${c.cls}${sticky}"><span class="stat-cell">${escHtml(val || '—')}</span></td>`;
      }
      const cur = song.extra?.language || c.default || '';
      const opts = (c.options || []).map(o =>
        `<option value="${o}"${o === cur ? ' selected' : ''}>${o}</option>`
      ).join('');
      return `<td class="${c.cls}${sticky}">
        <select data-id="${sid}" data-key="extra.language" onchange="markDirty('${sid}')">${opts}</select>
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
      <button class="del-btn" onclick="deleteRow('${sid}')" title="Delete">&#215;</button>
    </td>
  </tr>`;
}

// --- Dirty tracking ---

function markDirty(sid) {
  dirty.add(String(sid));
  const row = document.getElementById(`row-${sid}`);
  if (row) row.classList.add('dirty');
  setStatus('unsaved', 'Unsaved changes');
  document.getElementById('save-btn')?.removeAttribute('disabled');
  document.getElementById('discard-btn')?.removeAttribute('disabled');
}

function setStatus(cls, msg) {
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
  setStatus('unsaved', 'Unsaved changes');
}

async function deleteRow(sid) {
  // Unsaved new row — never reached the DB, just remove from DOM
  if (String(sid).startsWith('_new_')) {
    document.getElementById(`row-${sid}`)?.remove();
    dirty.delete(sid);
    if (dirty.size === 0) setStatus('', '');
    return;
  }

  if (!confirm('Delete this song? It will also be removed from any saved setlists.')) return;

  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const r = await fetch(`/api/${artistSlug}/songs/${sid}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (r.ok || r.status === 404) {
    document.getElementById(`row-${sid}`)?.remove();
    dirty.delete(String(sid));
    songs = songs.filter(s => String(s.id) !== String(sid));
    if (dirty.size === 0) setStatus('', '');
  } else if (r.status === 401) {
    if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); }
  } else {
    setStatus('error', 'Could not delete song — try again');
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

  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  setStatus('', 'Saving…');

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
    await loadAndRender();
    setStatus('saved', 'All changes saved');
    setTimeout(() => setStatus('', ''), 3000);

  } catch {
    setStatus('error', 'Save failed — try again');
  } finally {
    const b = document.getElementById('save-btn');
    if (b) { b.disabled = false; b.textContent = 'Save'; }
  }
}

// --- Logs ---

async function loadLogs() {
  const el = document.getElementById('logs-section');
  if (!el || !artistSlug) return;
  try {
    const logs = await fetch(`/api/${artistSlug}/song-logs`).then(r => r.json());
    renderLogs(logs);
  } catch {
    el.innerHTML = '';
  }
}

function timeAgo(iso) {
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (secs < 60)   return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + ' min ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
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
    const label = log.action === 'create' ? 'added'
                : log.action === 'delete' ? 'deleted'
                : 'updated';
    const restore = (log.action === 'delete' && token)
      ? `<button class="log-restore-btn" onclick="restoreSong(${log.song_id})">Restore</button>`
      : '';
    return `<div class="log-row">
      <span class="log-badge ${badge}">${label}</span>
      <span class="log-title">${escHtml(title)}</span>
      <span class="log-time">${timeAgo(log.changed_at)}</span>
      ${restore}
    </div>`;
  }).join('');

  el.innerHTML = `<div class="logs-wrap"><h2 class="logs-heading">Change log</h2>${items}</div>`;
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
    await loadAndRender();
  } else {
    setStatus('error', 'Could not restore song — try again');
  }
}

// --- Song appearances modal ---

async function openAppearances(songId) {
  const song  = songs.find(s => s.id === songId);
  const modal = document.getElementById('appearances-modal');
  document.getElementById('appearances-title').textContent =
    song ? `"${song.title}"` : 'Song appearances';
  const list = document.getElementById('appearances-list');
  list.innerHTML = '<p class="appearance-loading">Loading…</p>';
  modal.classList.add('open');

  try {
    const data = await fetch(`/api/${artistSlug}/songs?setlists=${songId}`).then(r => r.json());
    if (!data.length) {
      list.innerHTML = '<p class="appearance-empty">Not in any setlist yet.</p>';
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
    list.innerHTML = '<p class="appearance-empty">Failed to load.</p>';
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
  content.innerHTML = '<p class="gema-loading">Loading…</p>';
  modal.classList.add('open');
  try {
    const r = await fetch(`/api/${artistSlug}/songs/${songId}/gema`);
    const { works, rightholders } = await r.json();
    content.innerHTML = works.length ? renderGemaContent(works, rightholders) : '<p class="gema-loading">No GEMA registration linked.</p>';
  } catch {
    content.innerHTML = '<p class="gema-loading">Failed to load.</p>';
  }
}

function renderGemaContent(works, rightholders) {
  return works.map(work => {
    const rh = rightholders.filter(r => r.gema_work_id === work.id);
    const dur = work.duration_sec != null
      ? `${Math.floor(work.duration_sec / 60)}:${String(work.duration_sec % 60).padStart(2, '0')}`
      : null;
    const details = [
      ['ISWC',             work.iswc],
      ['ISRC',             work.isrc],
      ['Language',         work.language],
      ['Performers',       work.performers],
      ['Genre',            work.gema_genre],
      ['Duration',         dur],
      ['First registered', work.first_registered_at],
      ['Last updated',     work.last_updated_at],
    ].filter(([, v]) => v);

    const dlHtml = details.map(([k, v]) =>
      `<dt>${escHtml(k)}</dt><dd>${escHtml(String(v))}</dd>`
    ).join('');

    const rhHtml = rh.length ? `
      <table class="gema-rh-table">
        <thead><tr><th>Name</th><th>Role</th><th>AR %</th><th>VR %</th><th>Society</th><th>Represents</th></tr></thead>
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
  if (file.size > maxBytes) { setStatus('error', 'File too large'); return; }

  var btn = input.previousElementSibling;
  var origText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  try {
    var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
    var r = await fetch('/api/' + artistSlug + '/songs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ upload_presign_id: sid, upload_type: mediaType, filename: file.name, contentType: file.type, size: file.size }),
    });
    if (r.status === 401) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); return; }
    if (!r.ok) { setStatus('error', 'Failed to prepare upload'); return; }

    var json = await r.json();
    var put = await fetch(json.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) { setStatus('error', 'Upload to storage failed'); return; }

    var confirm = await fetch('/api/' + artistSlug + '/songs/' + sid + '/' + mediaType, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ publicUrl: json.publicUrl }),
    });
    if (!confirm.ok) { setStatus('error', 'Saved file but failed to update song'); return; }

    var keyMap = { audio: 'extra.listenUrl', sheet: 'extra.sheetUrl', playback: 'extra.playbackUrl' };
    var panelInput = document.querySelector('[data-key="' + keyMap[mediaType] + '"][data-id="' + sid + '"]');
    if (panelInput) { panelInput.value = json.publicUrl; markPanelEditDirty(); }

    var song = songs.find(function(s) { return String(s.id) === String(sid); });
    var extraKeyMap = { audio: 'listenUrl', sheet: 'sheetUrl', playback: 'playbackUrl' };
    if (song) song.extra = Object.assign({}, song.extra, { [extraKeyMap[mediaType]]: json.publicUrl });

    setStatus('saved', 'File uploaded');
    setTimeout(function() { setStatus('', ''); }, 3000);
  } catch {
    setStatus('error', 'Upload failed — check your connection');
  } finally {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
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
  input.value = ''; // reset so same file can be re-selected

  if (file.size > 50 * 1024 * 1024) {
    setStatus('error', 'File too large — max 50 MB');
    return;
  }

  const uploadBtn = document.querySelector(`#row-${sid} .listen-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ upload_presign_id: sid, upload_type: 'audio', filename: file.name, contentType: file.type, size: file.size }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { setStatus('error', 'Failed to prepare upload'); return; }

    const { uploadUrl, publicUrl } = await r.json();

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!put.ok) { setStatus('error', 'Upload to storage failed'); return; }

    // Confirm upload: save publicUrl to DB, delete previous file from R2 if any
    const song = songs.find(s => String(s.id) === String(sid));

    const confirm = await fetch(`/api/${artistSlug}/songs/${sid}/audio`, {
      method: 'PUT',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ publicUrl }),
    });
    if (confirm.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!confirm.ok) { setStatus('error', 'Saved file but failed to update song — reload and try again'); return; }

    // Update local cache and swap ↑ for ▶ in the table cell
    if (song) { song.extra = { ...(song.extra ?? {}), listenUrl: publicUrl }; }
    const td = document.querySelector(`#row-${sid} .listen-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.listen-upload-btn')?.remove();
      if (!td.querySelector('.listen-play-btn')) {
        const btn = document.createElement('button');
        btn.className = 'listen-play-btn';
        btn.title = 'Play';
        btn.textContent = '▶';
        btn.setAttribute('onclick', `openPlayer('${sid}')`);
        td.prepend(btn);
      }
    }
    setStatus('saved', 'Audio uploaded');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Upload failed — check your connection');
  } finally {
    if (uploadBtn) { uploadBtn.textContent = uploadBtn.dataset.orig || '↑'; uploadBtn.classList.remove('listen-uploading'); uploadBtn.disabled = false; }
  }
}

// --- Player modal ---

function toEmbedUrl(url) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}?autoplay=1`;
  if (/soundcloud\.com/.test(url))
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=true&color=%23f9bf8f&hide_related=true&show_comments=false`;
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
    content.innerHTML = `<audio controls src="${escHtml(url)}" autoplay></audio>`;
  } else if (embedUrl) {
    content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(embedUrl)}"
      allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
  } else {
    content.innerHTML = `<p class="player-link"><a href="${escHtml(url)}" target="_blank" rel="noopener">Open in new tab ↗</a></p>`;
  }

  // Reset delete confirm state
  document.getElementById('player-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('player-delete-btn').style.display = '';
  document.getElementById('player-history').innerHTML = '';

  // Fetch audio history for this song
  fetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
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
    const r = await fetch(`/api/${artistSlug}/songs/${sid}/audio`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { setStatus('error', 'Could not remove audio file'); return; }

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
        btn.title = 'Upload audio';
        btn.textContent = '↑';
        btn.setAttribute('onclick', `triggerAudioUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    setStatus('saved', 'Audio removed');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Could not remove audio file');
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

  if (file.size > 50 * 1024 * 1024) { setStatus('error', 'File too large — max 50 MB'); return; }

  const replaceBtn = document.getElementById('player-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ upload_presign_id: sid, upload_type: 'audio', filename: file.name, contentType: file.type, size: file.size }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } closePlayer(); return; }
    if (!r.ok) { setStatus('error', 'Failed to prepare upload'); return; }

    const { uploadUrl, publicUrl } = await r.json();

    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) { setStatus('error', 'Upload to storage failed'); return; }

    const song = songs.find(s => String(s.id) === String(sid));

    const confirm = await fetch(`/api/${artistSlug}/songs/${sid}/audio`, {
      method: 'PUT',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ publicUrl }),
    });
    if (!confirm.ok) { setStatus('error', 'Saved file but failed to update song'); return; }

    // Update local cache + table cell hidden input
    if (song) { song.extra = { ...(song.extra ?? {}), listenUrl: publicUrl }; }
    const td = document.querySelector(`#row-${sid} .listen-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;

    // Swap player content to new file
    const isAudio = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(publicUrl);
    const embedUrl = toEmbedUrl(publicUrl);
    const content  = document.getElementById('player-content');
    if (isAudio) {
      content.innerHTML = `<audio controls src="${escHtml(publicUrl)}" autoplay></audio>`;
    } else if (embedUrl) {
      content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(embedUrl)}"
        allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
    }

    // Refresh history
    fetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
      .then(r2 => r2.ok ? r2.json() : [])
      .then(renderPlayerHistory)
      .catch(() => {});

    setStatus('saved', 'Audio replaced');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Upload failed — check your connection');
  } finally {
    if (replaceBtn) { replaceBtn.textContent = 'Replace'; replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderPlayerHistory(logs) {
  const el = document.getElementById('player-history');
  if (!el) return;
  const audio = logs.filter(l => l.action === 'audio_replace' || l.action === 'audio_delete');
  if (!audio.length) { el.innerHTML = ''; return; }

  const items = audio.map(log => {
    const desc = log.action === 'audio_replace'
      ? `replaced — ${escHtml(log.song_data?.previousFilename ?? '?')}`
      : `removed — ${escHtml(log.song_data?.filename ?? '?')}`;
    return `<div class="player-history-item">
      <span class="player-history-time">${timeAgo(log.changed_at)}</span>
      <span>${desc}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<h3 class="player-history-heading">History</h3>${items}`;
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

  if (file.size > 20 * 1024 * 1024) { setStatus('error', 'File too large — max 20 MB'); return; }

  const uploadBtn = document.querySelector(`#row-${sid} .sheet-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ upload_presign_id: sid, upload_type: 'sheet', filename: file.name, size: file.size }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { setStatus('error', 'Failed to prepare upload'); return; }

    const { uploadUrl, publicUrl } = await r.json();

    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
    if (!put.ok) { setStatus('error', 'Upload to storage failed'); return; }

    const song = songs.find(s => String(s.id) === String(sid));

    const confirm = await fetch(`/api/${artistSlug}/songs/${sid}/sheet`, {
      method: 'PUT',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ publicUrl }),
    });
    if (confirm.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!confirm.ok) { setStatus('error', 'Saved file but failed to update song — reload and try again'); return; }

    if (song) { song.extra = { ...(song.extra ?? {}), sheetUrl: publicUrl }; }
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.sheet-upload-btn')?.remove();
      if (!td.querySelector('.sheet-open-btn')) {
        const btn = document.createElement('button');
        btn.className = 'sheet-open-btn';
        btn.title = 'Open sheet';
        btn.textContent = '≡';
        btn.setAttribute('onclick', `openSheet('${sid}')`);
        td.prepend(btn);
      }
    }
    setStatus('saved', 'Sheet uploaded');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Upload failed — check your connection');
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

  fetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
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
    const r = await fetch(`/api/${artistSlug}/songs/${sid}/sheet`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { setStatus('error', 'Could not remove sheet'); return; }

    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.sheetUrl;
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = '';
      td.querySelector('.sheet-open-btn')?.remove();
      if (!td.querySelector('.sheet-upload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'sheet-upload-btn';
        btn.title = 'Upload PDF';
        btn.textContent = '↑';
        btn.setAttribute('onclick', `triggerSheetUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    setStatus('saved', 'Sheet removed');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Could not remove sheet');
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

  if (file.size > 20 * 1024 * 1024) { setStatus('error', 'File too large — max 20 MB'); return; }

  const replaceBtn = document.getElementById('sheet-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ upload_presign_id: sid, upload_type: 'sheet', filename: file.name, size: file.size }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } closeSheet(); return; }
    if (!r.ok) { setStatus('error', 'Failed to prepare upload'); return; }

    const { uploadUrl, publicUrl } = await r.json();

    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
    if (!put.ok) { setStatus('error', 'Upload to storage failed'); return; }

    const song = songs.find(s => String(s.id) === String(sid));

    const confirm = await fetch(`/api/${artistSlug}/songs/${sid}/sheet`, {
      method: 'PUT',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}`,
      },
      body: JSON.stringify({ publicUrl }),
    });
    if (!confirm.ok) { setStatus('error', 'Saved file but failed to update song'); return; }

    if (song) { song.extra = { ...(song.extra ?? {}), sheetUrl: publicUrl }; }
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;

    document.getElementById('sheet-open-link').href = publicUrl;
    document.getElementById('sheet-content').innerHTML =
      `<div class="sheet-embed"><iframe src="${escHtml(publicUrl)}" title="Sheet"></iframe></div>`;

    fetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
      .then(r2 => r2.ok ? r2.json() : [])
      .then(renderSheetHistory)
      .catch(() => {});

    setStatus('saved', 'Sheet replaced');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Upload failed — check your connection');
  } finally {
    if (replaceBtn) { replaceBtn.textContent = 'Replace'; replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderSheetHistory(logs) {
  const el = document.getElementById('sheet-history');
  if (!el) return;
  const sheets = logs.filter(l => l.action === 'sheet_replace' || l.action === 'sheet_delete');
  if (!sheets.length) { el.innerHTML = ''; return; }

  const items = sheets.map(log => {
    const desc = log.action === 'sheet_replace'
      ? `replaced — ${escHtml(log.song_data?.previousFilename ?? '?')}`
      : `removed — ${escHtml(log.song_data?.filename ?? '?')}`;
    return `<div class="player-history-item">
      <span class="player-history-time">${timeAgo(log.changed_at)}</span>
      <span>${desc}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<h3 class="player-history-heading">History</h3>${items}`;
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

  if (file.size > 50 * 1024 * 1024) { setStatus('error', 'File too large — max 50 MB'); return; }

  const uploadBtn = document.querySelector(`#row-${sid} .playback-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ upload_presign_id: sid, upload_type: 'playback', filename: file.name, contentType: file.type, size: file.size }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { setStatus('error', 'Failed to prepare upload'); return; }

    const { uploadUrl, publicUrl } = await r.json();

    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) { setStatus('error', 'Upload to storage failed'); return; }

    const song = songs.find(s => String(s.id) === String(sid));

    const confirm = await fetch(`/api/${artistSlug}/songs/${sid}/playback`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ publicUrl }),
    });
    if (confirm.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!confirm.ok) { setStatus('error', 'Saved file but failed to update song — reload and try again'); return; }

    if (song) { song.extra = { ...(song.extra ?? {}), playbackUrl: publicUrl }; }
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.playback-upload-btn')?.remove();
      if (!td.querySelector('.playback-open-btn')) {
        const btn = document.createElement('button');
        btn.className = 'playback-open-btn';
        btn.title = 'Play playback';
        btn.textContent = '▷';
        btn.setAttribute('onclick', `openPlayback('${sid}')`);
        td.prepend(btn);
      }
    }
    setStatus('saved', 'Playback uploaded');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Upload failed — check your connection');
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
    content.innerHTML = `<audio controls src="${escHtml(url)}" autoplay style="width:100%;margin:1rem 0;display:block"></audio>`;
  } else if (embedUrl) {
    content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(embedUrl)}" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
  } else {
    content.innerHTML = `<p class="player-link"><a href="${escHtml(url)}" target="_blank" rel="noopener">Open in new tab ↗</a></p>`;
  }

  document.getElementById('playback-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('playback-delete-btn').style.display = '';
  document.getElementById('playback-history').innerHTML = '';

  fetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
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
    const r = await fetch(`/api/${artistSlug}/songs/${sid}/playback`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } return; }
    if (!r.ok) { setStatus('error', 'Could not remove playback file'); return; }

    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.playbackUrl;
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = '';
      td.querySelector('.playback-open-btn')?.remove();
      if (!td.querySelector('.playback-upload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'playback-upload-btn';
        btn.title = 'Upload playback';
        btn.textContent = '↑';
        btn.setAttribute('onclick', `triggerPlaybackUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    setStatus('saved', 'Playback removed');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Could not remove playback file');
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

  if (file.size > 50 * 1024 * 1024) { setStatus('error', 'File too large — max 50 MB'); return; }

  const replaceBtn = document.getElementById('playback-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const r = await fetch(`/api/${artistSlug}/songs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ upload_presign_id: sid, upload_type: 'playback', filename: file.name, contentType: file.type, size: file.size }),
    });
    if (r.status === 401) { if (!isViewMode()) { sessionStorage.removeItem(AUTH_TOKEN_KEY); requireLogin(); } closePlayback(); return; }
    if (!r.ok) { setStatus('error', 'Failed to prepare upload'); return; }

    const { uploadUrl, publicUrl } = await r.json();

    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) { setStatus('error', 'Upload to storage failed'); return; }

    const song = songs.find(s => String(s.id) === String(sid));

    const confirm = await fetch(`/api/${artistSlug}/songs/${sid}/playback`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem(AUTH_TOKEN_KEY)}` },
      body: JSON.stringify({ publicUrl }),
    });
    if (!confirm.ok) { setStatus('error', 'Saved file but failed to update song'); return; }

    if (song) { song.extra = { ...(song.extra ?? {}), playbackUrl: publicUrl }; }
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;

    document.getElementById('playback-content').innerHTML =
      `<audio controls src="${escHtml(publicUrl)}" autoplay style="width:100%;margin:1rem 0;display:block"></audio>`;

    fetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
      .then(r2 => r2.ok ? r2.json() : [])
      .then(renderPlaybackHistory)
      .catch(() => {});

    setStatus('saved', 'Playback replaced');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Upload failed — check your connection');
  } finally {
    if (replaceBtn) { replaceBtn.textContent = 'Replace'; replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderPlaybackHistory(logs) {
  const el = document.getElementById('playback-history');
  if (!el) return;
  const items = logs.filter(l => l.action === 'playback_replace' || l.action === 'playback_delete');
  if (!items.length) { el.innerHTML = ''; return; }

  el.innerHTML = `<h3 class="player-history-heading">History</h3>` + items.map(log => {
    const desc = log.action === 'playback_replace'
      ? `replaced — ${escHtml(log.song_data?.previousFilename ?? '?')}`
      : `removed — ${escHtml(log.song_data?.filename ?? '?')}`;
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
  document.getElementById('lyrics-delete-btn').style.display     = '';
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
  _lyricsShowSuggestState('Searching lyrics.ovh, lrclib, AI…', '', false);
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
      _lyricsShowSuggestState(body.error ?? 'Could not fetch lyrics', '', false);
      return;
    }
    const data = await r.json();
    const sourcesList = data.sources ? data.sources.join(', ') : 'all sources';
    if (!data.lyrics) {
      const aiNote = data.aiSkipped ? ' (AI quota exhausted — try again tomorrow)' : '';
      _lyricsShowSuggestState(`No lyrics found (tried: ${sourcesList})${aiNote}`, '', false);
      return;
    }
    _lyricsShowSuggestState(`Suggested via ${data.source}`, data.lyrics, true);
  } catch (e) {
    if (e.name !== 'AbortError') _lyricsShowSuggestState('Could not fetch lyrics', '', false);
  } finally {
    btn.textContent = 'AI ✦'; btn.disabled = false;
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

  const saveBtn = document.getElementById('lyrics-save-btn');
  if (saveBtn) { saveBtn.textContent = '…'; saveBtn.disabled = true; }
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
      const msg = body.error ?? `Save failed (${r.status})`;
      _lyricsSaveStatus(msg, true);
      console.error('saveLyrics failed', r.status, body);
      return;
    }

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
        existing.title = 'View lyrics';
        existing.setAttribute('onclick', `openLyrics('${sid}')`);
      } else if (!trimmed && existing?.classList.contains('lyrics-open-btn')) {
        existing.className = 'lyrics-add-btn';
        existing.textContent = '+';
        existing.title = 'Add lyrics';
        existing.setAttribute('onclick', `openLyricsEdit('${sid}')`);
      }
    }

    if (trimmed) {
      document.getElementById('lyrics-view').textContent = trimmed;
      _lyricsSetMode('view');
    } else {
      closeLyrics();
    }
    setStatus('saved', 'Lyrics saved');
    setTimeout(() => setStatus('', ''), 3000);
  } catch (e) {
    _lyricsSaveStatus('Network error — could not save', true);
    console.error('saveLyrics network error', e);
  } finally {
    if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
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
    if (!r.ok) { setStatus('error', 'Could not delete lyrics'); return; }

    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.lyrics;

    const td = document.querySelector(`#row-${sid} .lyrics-cell`);
    if (td) {
      td.querySelector('textarea').value = '';
      const btn = td.querySelector('.lyrics-open-btn');
      if (btn) {
        btn.className = 'lyrics-add-btn';
        btn.textContent = '+';
        btn.title = 'Add lyrics';
        btn.setAttribute('onclick', `openLyricsEdit('${sid}')`);
      }
    }
    setStatus('saved', 'Lyrics deleted');
    setTimeout(() => setStatus('', ''), 3000);
  } catch {
    setStatus('error', 'Could not delete lyrics');
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

init();
