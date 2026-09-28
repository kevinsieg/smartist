// Setlist generator

// BPM → 0–1 (Largo 0 … Presto 1) using classical tempo markings
function bpmNorm(song) {
  const b = song.bpm;
  if (b == null) return null;
  if (b < 66)  return 0;    // Largo
  if (b < 76)  return 0.2;  // Adagio
  if (b < 108) return 0.4;  // Andante
  if (b < 120) return 0.6;  // Moderato
  if (b < 168) return 0.8;  // Allegro
  return 1;                  // Presto
}

// song.energy 0–10 → 0–1 (calm 0 … intense 1)
function energyNorm(song) {
  if (song.energy == null) return null;
  return Math.min(1, Math.max(0, Number(song.energy) / 10));
}

// Combined feel: 0 = yoga-calm, 1 = triathlon-intense.
// Equal weight between tempo and energy; uses whichever is available if only one is set.
function songFeel(song) {
  const b = bpmNorm(song), e = energyNorm(song);
  if (b != null && e != null) return b * 0.5 + e * 0.5;
  return b ?? e ?? null;
}

// Setlist score labels — shown as a badge on the generated result
// var, not const: SPA navigation re-executes this file in the same document,
// and a repeated top-level const/let throws before init() runs.
var FEEL_LABELS = [
  { max: 0.12, icon: '🧘', get label() { return t('setlist.feelSavasana'); }      },
  { max: 0.28, icon: '🌙', get label() { return t('setlist.feelLateNight'); }     },
  { max: 0.44, icon: '🛶', get label() { return t('setlist.feelMorningPaddle'); } },
  { max: 0.58, icon: '🚶', get label() { return t('setlist.feelSundayStroll'); }  },
  { max: 0.72, icon: '🏃', get label() { return t('setlist.feel10kRun'); }        },
  { max: 0.88, icon: '🚴', get label() { return t('setlist.feelSprintCycling'); } },
  { max: 1.01, icon: '🔥', get label() { return t('setlist.feelTriathlon'); }      },
];

var artistSlug = '';
var bandConfig = null;
var _bandName = '';
var allSongs = [];
var currentSet = [];
var _activeView = 'generator';
var _histView    = null;
var _histSets    = [];
var _histGigs    = [];
var _histGigMap  = {};   // gig.id → gig object
var _histLoaded  = false;
var _histLoadedSongs = {}; // setlistId → song array (lazy cache)
var _histPendingOpenId = null; // set after save → opened once history tab loads
var _viewMode = false;
var _editSongs   = null;
var _editingSid  = null;

// --- Demo personalisation ---

function applyDemoFilters() {
  var raw = sessionStorage.getItem('demo_genres');
  if (!raw) return;
  var genres;
  try { genres = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(genres) || !genres.length) return;
  var normalized = genres.map(function (g) { return g.toLowerCase(); });
  document.querySelectorAll('.filter-btn').forEach(function (btn) {
    var val = (btn.dataset.value || '').toLowerCase();
    var matches = normalized.some(function (g) {
      return val === g || val.includes(g) || g.includes(val);
    });
    if (matches && !btn.classList.contains('active')) btn.click();
  });
}

// --- Init ---

async function init() {
  try {
    const cfg = await loadConfig();
    artistSlug   = cfg.slug;
    bandConfig = cfg.config ?? {};
    _bandName  = cfg.name || '';
    allSongs   = cfg.songs ?? [];
    applyNav(cfg.name, cfg.config);
    _viewMode = isViewMode();
    if (_viewMode) {
      document.body.classList.add('view-mode');
      applyViewMode();
      injectViewModeNotice();
    }
    if (cfg.config?.logoUrl) {
      const printLogo = document.querySelector('#print-header .app-logo-img');
      if (printLogo) printLogo.src = cfg.config.logoUrl.replace(/^http:/i, 'https:');
    }
    // Show tab bar and route to the correct tab
    _activeView = new URLSearchParams(location.search).get('view') || 'generator';
    var tabsEl = document.getElementById('setlist-tabs');
    if (tabsEl) {
      tabsEl.style.display = '';
      _updateTabBar();
    }
    // Compute sticky offset for tab bar (below fixed app header)
    requestAnimationFrame(function() {
      var hdr = document.querySelector('.app-header');
      if (hdr) document.documentElement.style.setProperty('--setlist-tabs-top', hdr.getBoundingClientRect().height + 'px');
    });

    onEnterSave(document.getElementById('view-side-panel-inner'), function() {
      if (_editingSid) _saveHistEdit(_editingSid);
    });

    if (_activeView === 'history') {
      document.getElementById('setlist-page-title').style.display = 'none';
      await _renderHistoryTab();
    } else {
      renderControls();
      applyDemoFilters();
    }
    injectModalCloseButtons();
  } catch {
    document.getElementById('setlist-content').innerHTML =
      '<p style="text-align:center;color:var(--third-color);">' + t('setlist.couldNotLoad') + '</p>';
  }
}

// --- Helpers ---

function getFieldValue(song, field) {
  if (field.startsWith('extra.')) {
    const key = field.slice(6);
    const v = song.extra?.[key];
    return v !== undefined && v !== null ? String(v) : null;
  }
  const v = song[field];
  return v !== undefined && v !== null ? String(v) : null;
}

// --- Filter state ---

var activeFilters = new Map(); // field -> Set<value>

// Own song: no interpret, or the band itself. Everything else counts as a cover.
function _isOwnSong(song) {
  const who = (song.interpret || '').trim().toLowerCase();
  return !who || who === _bandName.trim().toLowerCase();
}

function _matchesOrigin(song) {
  const origin = document.getElementById('song-origin')?.value || '';
  if (origin === 'own')    return _isOwnSong(song);
  if (origin === 'covers') return !_isOwnSong(song);
  return true;
}

function getFilteredSongs() {
  const activeOnly = document.getElementById('active-only')?.checked ?? true;
  const feelRange  = getFeelRange();
  return allSongs.filter(song => {
    if (activeOnly && !song.active) return false;
    if (song.heart) return true;  // heart songs bypass all filters
    if (!_matchesOrigin(song)) return false;
    for (const [field, values] of activeFilters) {
      if (values.size === 0) continue;
      const v = getFieldValue(song, field);
      if (!values.has(v)) return false;
    }
    if (feelRange) {
      const f = songFeel(song);
      if (f != null && (f < feelRange.min || f > feelRange.max)) return false;
    }
    return true;
  });
}

function toggleFilter(btn) {
  const { field, value } = btn.dataset;
  const set = activeFilters.get(field);
  if (!set) return;
  if (set.has(value)) { set.delete(value); btn.classList.remove('active'); }
  else               { set.add(value);    btn.classList.add('active');    }
}

// --- Generate ---

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateSet(songs, targetMin) {
  const heartSongs = songs.filter(s => s.heart);
  const rest       = songs.filter(s => !s.heart);
  if (!targetMin || targetMin <= 0)
    return [...heartSongs, ...rest].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const shuffled = shuffleArray(rest);
  const set = [...heartSongs];
  let total = heartSongs.reduce((sum, s) => sum + (s.length_min || 4), 0);
  for (const song of shuffled) {
    if (total >= targetMin) break;
    set.push(song);
    total += song.length_min || 4;
  }
  return set;
}

function capoCost(a, b, field) {
  const va = a.extra?.[field];
  const vb = b.extra?.[field];
  if (va == null || vb == null) return 0;
  return String(va) !== String(vb) ? 1 : 0;
}

function minimizeCapoChanges(songs, fields) {
  if (songs.length < 2 || !fields.length) return songs;
  const remaining = [...songs];
  const result = [remaining.splice(0, 1)[0]];
  while (remaining.length) {
    const last = result[result.length - 1];
    let bestIdx = 0, bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cost = fields.reduce((s, f) => s + capoCost(last, remaining[i], f), 0);
      if (cost < bestCost) { bestCost = cost; bestIdx = i; }
    }
    result.push(remaining.splice(bestIdx, 1)[0]);
  }
  return result;
}

function applyCapoOpts(songs) {
  const fields = [];
  if (document.getElementById('minimize-banjo-capo')?.checked) fields.push('banjoCapo');
  if (document.getElementById('minimize-git-capo')?.checked)   fields.push('gitCapo');
  return minimizeCapoChanges(songs, fields);
}

function toggleControls(forceCollapse) {
  const body   = document.getElementById('controls-body');
  const toggle = document.getElementById('controls-toggle');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  const collapse = forceCollapse !== undefined ? forceCollapse : isOpen;
  body.style.display = collapse ? 'none' : '';
  if (toggle) {
    toggle.querySelector('.toggle-arrow').textContent = collapse ? '▼' : '▲';
    toggle.setAttribute('aria-expanded', String(!collapse));
  }
}

function computeSplitIndex(songs) {
  if (songs.length < 2) return songs.length;
  let total = 0;
  for (const s of songs) total += s.length_min || 4;
  const half = total / 2;
  let cum = 0;
  for (let i = 0; i < songs.length; i++) {
    cum += songs[i].length_min || 4;
    if (cum >= half) return i + 1;
  }
  return Math.ceil(songs.length / 2);
}

// Returns songs outside the preferred feel range, sorted closest-first.
// Fast preference: fills from just below the min downward.
// Calm preference: fills from just above the max upward.
function _buildFillPool(inSet, activeOnly) {
  const range = getFeelRange();
  if (!range) return [];
  const base = allSongs.filter(s => {
    if (!(!activeOnly || s.active) || inSet.has(s.id) || !_matchesOrigin(s)) return false;
    const f = songFeel(s);
    return f != null && (f < range.min || f > range.max);
  });
  const preferIntense = range.min > 0; // slider is on the intense side
  base.sort((a, b) => {
    const fa = songFeel(a), fb = songFeel(b);
    return preferIntense ? fb - fa : fa - fb; // closest to preferred edge first
  });
  return base;
}

function onGenerate() {
  const filtered  = getFilteredSongs();
  const targetMin = parseFloat(document.getElementById('target-min')?.value) || 0;
  const split     = document.getElementById('split-sets')?.checked;
  currentSet = generateSet(filtered, targetMin);

  // If the preferred energy pool falls short, fill with adjacent tiers (closest first)
  if (targetMin > 0) {
    const inSet = new Set(currentSet.map(s => s.id));
    let total   = currentSet.reduce((sum, s) => sum + (s.length_min || 4), 0);
    if (total < targetMin) {
      const activeOnly = document.getElementById('active-only')?.checked ?? true;
      for (const song of _buildFillPool(inSet, activeOnly)) {
        if (total >= targetMin) break;
        currentSet.push(song);
        total += song.length_min || 4;
      }
    }
  }

  if (split && currentSet.length >= 2) {
    const mid  = computeSplitIndex(currentSet);
    const set1 = applyCapoOpts(currentSet.slice(0, mid));
    const set2 = applyCapoOpts(currentSet.slice(mid));
    currentSet = [...set1, ...set2];
  } else {
    currentSet = applyCapoOpts(currentSet);
  }
  renderResult(currentSet);
}

function moveSong(index, dir) {
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= currentSet.length) return;
  [currentSet[index], currentSet[newIndex]] = [currentSet[newIndex], currentSet[index]];
  renderResult(currentSet);
}

// --- Render controls ---

function getBaseSongs() {
  const activeOnly = document.getElementById('active-only')?.checked ?? true;
  return activeOnly ? allSongs.filter(s => s.active) : allSongs;
}

var EXCLUDED_FILTER_FIELDS = new Set(['energy', 'interpret', 'reference_interpret', 'comment', 'length_min']);

function refreshFilterOptions() {
  const base = getBaseSongs();
  const fields = (bandConfig.filterFields ?? []).filter(f => !EXCLUDED_FILTER_FIELDS.has(f.field));
  for (const f of fields) {
    const container = document.querySelector(`.filter-buttons[data-field="${f.field}"]`);
    if (!container) continue;
    const vals = new Set();
    for (const song of base) {
      const v = getFieldValue(song, f.field);
      if (v !== null) vals.add(v);
    }
    const currentActive = new Set(
      [...container.querySelectorAll('.filter-btn.active')].map(b => b.dataset.value)
    );
    const filterSet = activeFilters.get(f.field);
    if (filterSet) for (const v of [...filterSet]) { if (!vals.has(v)) filterSet.delete(v); }
    const sorted = [...vals].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
    container.innerHTML = sorted.map(v => {
      const label = f.field === 'length_min' ? formatLength(Number(v))
        : f.field === 'key' ? formatKey(v)
        : v;
      return `<button class="filter-btn${currentActive.has(v) ? ' active' : ''}" data-field="${escHtml(f.field)}" data-value="${escHtml(v)}" onclick="toggleFilter(this)">${escHtml(label)}</button>`;
    }).join('');
  }
}

function renderControls() {
  if (!allSongs.length) {
    document.getElementById('setlist-content').innerHTML =
      '<div style="text-align:center;padding:2.5rem 1rem;color:var(--third-color);">' +
        '<p style="margin-bottom:1rem;">' + t('setlist.noSongs') + '</p>' +
        '<a class="btn active" href="/' + artistSlug + '/songs?new=1">' + t('setlist.addFirstSong') + '</a>' +
      '</div>';
    return;
  }
  const fields = (bandConfig.filterFields ?? []).filter(f => !EXCLUDED_FILTER_FIELDS.has(f.field));
  for (const f of fields) activeFilters.set(f.field, new Set());

  const sliderHtml = `<div class="tempo-slider-wrap">
        <span class="tempo-label">🧘 ${t('setlist.calm')}</span>
        <input type="range" id="tempo-slider" min="0" max="100" value="50" class="tempo-slider">
        <span class="tempo-label">🔥 ${t('setlist.intense')}</span>
      </div>`;
  const filterRows = fields.map(f =>
    `<div class="filter-row">
      <span class="filter-label">${escHtml(f.label)}</span>
      <div class="filter-buttons" data-field="${escHtml(f.field)}"></div>
      ${f.field === 'tempo' ? sliderHtml : ''}
    </div>`
  ).join('');

  document.getElementById('setlist-content').innerHTML = `
    <div class="setlist-controls">
      <div class="gen-sentence">
        <button class="btn generate-btn" onclick="onGenerate()">${t('setlist.generateBtn')}</button>
        <span class="gen-prose">${t('setlist.genProseOf')}</span>
        <input type="number" id="target-min" min="0" max="300" value="45" class="gen-duration-input">
        <span class="gen-prose">${t('setlist.genProseMin')}${filterRows ? ' ' + t('setlist.genProseWith') : ''}</span>
        ${filterRows ? `<button class="controls-toggle" id="controls-toggle" onclick="toggleControls()" aria-expanded="false"><span class="toggle-arrow">▼</span> ${t('setlist.filtersBtn')}</button>` : ''}
      </div>
      <div id="controls-body" style="display:none">
        ${filterRows}
      </div>
      <div class="gen-options">
        <label class="active-toggle">
          <input type="checkbox" id="active-only" checked onchange="refreshFilterOptions()">
          ${t('setlist.activeOnly')}
        </label>
        <label class="active-toggle">
          ${t('setlist.originLabel')}
          <select id="song-origin" class="filter-select">
            <option value="">${t('setlist.originAll')}</option>
            <option value="own">${t('setlist.originOwn')}</option>
            <option value="covers">${t('setlist.originCovers')}</option>
          </select>
        </label>
        <label class="active-toggle">
          <input type="checkbox" id="split-sets">
          ${t('setlist.splitSets')}
        </label>
        <span class="active-toggle"${songFieldHidden(bandConfig, 'extra.banjoCapo') && songFieldHidden(bandConfig, 'extra.gitCapo') ? ' hidden' : ''}>
          ${t('setlist.minimizeCapo')}
          ${songFieldHidden(bandConfig, 'extra.banjoCapo') ? '' : `<label class="active-toggle"><input type="checkbox" id="minimize-banjo-capo" checked> ${t('setlist.capoBanjo')}</label>`}
          ${songFieldHidden(bandConfig, 'extra.gitCapo')   ? '' : `<label class="active-toggle"><input type="checkbox" id="minimize-git-capo" checked> ${t('setlist.capoGuitar')}</label>`}
        </span>
      </div>
    </div>
    <div id="result-area"></div>`;
  refreshFilterOptions();
}

function getFeelRange() {
  const v = Number(document.getElementById('tempo-slider')?.value ?? 50);
  if (v <= 10) return { min: 0,    max: 0.15 };
  if (v <= 25) return { min: 0,    max: 0.30 };
  if (v <= 40) return { min: 0,    max: 0.50 };
  if (v <= 60) return null; // all feels
  if (v <= 75) return { min: 0.50, max: 1    };
  if (v <= 90) return { min: 0.65, max: 1    };
  return           { min: 0.80, max: 1    };
}

// --- Render result ---

function renderResult(songs) {
  const resultArea = document.getElementById('result-area');
  if (songs.length === 0) {
    resultArea.innerHTML = '<p style="color:var(--third-color);margin-top:1rem;">' + t('setlist.noMatch') + '</p>';
    return;
  }

  const split   = document.getElementById('split-sets')?.checked;
  const splitAt = split && songs.length >= 2 ? computeSplitIndex(songs) : null;

  let totalMin = 0;
  let set1Min  = 0;

  const itemHtmls = songs.map((song, i) => {
    const dur = song.length_min || 4;
    totalMin += dur;
    if (splitAt && i < splitAt) set1Min += dur;

    // Don't show capo-change across the break
    const prev = (i > 0 && !(splitAt && i === splitAt)) ? songs[i - 1] : null;

    const showBanjo = !songFieldHidden(bandConfig, 'extra.banjoCapo');
    const showGit   = !songFieldHidden(bandConfig, 'extra.gitCapo');
    const banjo = showBanjo && song.extra?.banjoCapo != null ? String(song.extra.banjoCapo) : null;
    const git   = showGit   && song.extra?.gitCapo   != null ? String(song.extra.gitCapo)   : null;
    const prevBanjo = showBanjo && prev?.extra?.banjoCapo != null ? String(prev.extra.banjoCapo) : null;
    const prevGit   = showGit   && prev?.extra?.gitCapo   != null ? String(prev.extra.gitCapo)   : null;
    const capoChanged = (banjo !== null && prevBanjo !== null && banjo !== prevBanjo)
                     || (git   !== null && prevGit   !== null && git   !== prevGit);
    const capoParts = [
      banjo !== null && banjo !== '0' ? `B&nbsp;${escHtml(banjo)}` : '',
      git   !== null && git   !== '0' ? `G&nbsp;${escHtml(git)}`   : '',
    ].filter(Boolean);
    const capoSpan = capoParts.length
      ? `<span class="capo-badge${capoChanged ? ' capo-change' : ''}" title="${escHtml(capoChanged ? t('setlist.capoChanged') : t('setlist.capoTitle'))}">Capo: ${capoParts.join(' | ')}</span>`
      : '';

    const s = (v, field, title) => v && !songFieldHidden(bandConfig, field) ? `<span data-field="${escHtml(field)}" title="${escHtml(title)}">${escHtml(v)}</span>` : '';
    const metaSpans = [
      s(song.extra?.lead || '',  'extra.lead',   t('setlist.leadTitle')),
      s(song.key ? formatKey(song.key) : '',  'key',           t('setlist.keyTitle')),
      capoSpan,
      s(energyLabel(song.energy), 'energy',        t('setlist.energyTitle')),
      s(song.genre       || '',  'genre',         t('setlist.genreTitle')),
      song.extra?.harp ? s(t('setlist.harmonica'), 'extra.harp', t('setlist.harmonicaTitle')) : '',
      song.extra?.git2 ? s(t('setlist.guitar2'),   'extra.git2', t('setlist.guitar2Title')) : '',
    ].filter(Boolean).join('');

    const printLabels = song.genre ? `<span>${escHtml(song.genre)}</span>` : '';

    const displayNum = splitAt && i >= splitAt ? (i - splitAt + 1) : (i + 1);
    const isFirst = i === 0, isLast = i === songs.length - 1;
    return `<li class="song-item" draggable="true" data-index="${i}">
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <span class="song-num">${displayNum}.</span>
      <div class="song-main">
        <div class="song-top">
          <span class="song-title">${escHtml(song.title)}</span>
          ${printLabels ? `<span class="print-labels">${printLabels}</span>` : ''}
          <span class="song-time">${formatLength(song.length_min)}</span>
        </div>
        ${metaSpans ? `<div class="song-meta">${metaSpans}</div>` : ''}
      </div>
      <div class="song-actions">
        <button class="move-btn" onclick="moveSong(${i},-1)" ${isFirst ? 'disabled' : ''} aria-label="${t('setlist.moveUp')}">↑</button>
        <button class="move-btn" onclick="moveSong(${i},1)"  ${isLast  ? 'disabled' : ''} aria-label="${t('setlist.moveDown')}">↓</button>
        <button class="song-remove-btn" onclick="removeFromSet(${i})" title="${t('setlist.removeTitle')}">&#215;</button>
      </div>
    </li>`;
  });

  if (splitAt) {
    const set2Min = totalMin - set1Min;
    itemHtmls.splice(splitAt, 0,
      `<li class="set-break">
        <span class="set-break-label">${t('setlist.setBreak')}</span>
        <span class="set-break-meta">${t('setlist.setBreakMeta', { s1: splitAt, d1: formatLength(set1Min), s2: songs.length - splitAt, d2: formatLength(set2Min) })}</span>
      </li>`
    );
  }

  const items = itemHtmls.join('');

  const inSetIds = new Set(songs.map(s => s.id));
  const available = allSongs
    .filter(s => s.active && !inSetIds.has(s.id))
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const options = available.map(s =>
    `<option value="${s.id}">${escHtml(s.title)}</option>`
  ).join('');

  const headerText = splitAt
    ? `${songs.length} ${t('setlist.songs')} &bull; ${formatLength(totalMin)} &ensp;${t('setlist.twoSets')}`
    : `${songs.length} ${t('setlist.songs')} &bull; ${formatLength(totalMin)}`;

  const feelScores = songs.map(s => songFeel(s)).filter(f => f != null);
  const avgFeel    = feelScores.length ? feelScores.reduce((a, b) => a + b) / feelScores.length : null;
  const feelLabel  = avgFeel != null ? FEEL_LABELS.find(l => avgFeel <= l.max) : null;
  const feelBadge  = feelLabel ? `<span class="feel-badge" title="${t('setlist.vibeScore')} ${Math.round(avgFeel * 100)}/100">${feelLabel.icon} ${feelLabel.label}</span>` : '';

  resultArea.innerHTML = `
    <div class="setlist-result">
      <h2>${headerText}${feelBadge}</h2>
      <ul class="song-list">${items}</ul>
      <div class="add-song-row">
        <select id="add-song-select" onchange="addSongToSet(this)">
          <option value="">${t('setlist.addSongPlaceholder')}</option>
          ${options}
        </select>
      </div>
      <p class="total-time">${t('setlist.total', { duration: formatLength(totalMin) })}</p>
      <div class="result-actions">
        <button class="btn" onclick="onGenerate()" title="${t('setlist.regenTitle')}">${t('setlist.regenBtn')}</button>
        <button class="btn" onclick="onOptimize()" title="${t('setlist.optimizeTitle')}">${t('setlist.optimizeBtn')}</button>
        <button class="btn" onclick="printSetlist()">${t('setlist.exportPdfBtn')}</button>
        ${artistSlug ? `<button class="btn active" onclick="openAcceptModal()">${t('setlist.acceptBtn')}</button>` : ''}
      </div>
    </div>`;

  initDragAndDrop();
}

function removeFromSet(index) {
  currentSet.splice(index, 1);
  renderResult(currentSet);
}

function addSongToSet(select) {
  const songId = Number(select.value);
  if (!songId) return;
  const song = allSongs.find(s => s.id === songId);
  if (!song) return;
  currentSet.push(song);
  renderResult(currentSet);
}

// --- Optimize order ---

function onOptimize() {
  if (currentSet.length < 2) return;
  currentSet = optimizeSetlist([...currentSet]);
  currentSet = applyCapoOpts(currentSet);
  renderResult(currentSet);
}

function optimizeSetlist(songs) {
  const rank = s => {
    const f = songFeel(s);
    if (f == null) return 2;
    if (f < 0.35) return 1;
    if (f < 0.68) return 2;
    return 3;
  };

  const buckets = {
    1: shuffleArray(songs.filter(s => rank(s) === 1)),
    2: shuffleArray(songs.filter(s => rank(s) === 2)),
    3: shuffleArray(songs.filter(s => rank(s) === 3)),
  };

  function pickFrom(...ranks) {
    for (const r of ranks) {
      if (buckets[r]?.length > 0) return buckets[r].splice(0, 1)[0];
    }
    return null;
  }

  // Arc: opener(mid) → build(fast) → first dip(slow) → rebuild(mid) →
  //      climax(fast) → breath(mid) → final sprint(fast) → highlight(fast)
  function desiredRank(i, n) {
    if (i === 0)          return 2;  // opener: mid-tempo, familiar, not too high
    const f = i / (n - 1);
    if (f <= 0.20)        return 3;  // build up fast
    if (f <= 0.32)        return 1;  // first dip / slow song
    if (f <= 0.50)        return 2;  // rebuild from dip
    if (f <= 0.62)        return 3;  // first climax
    if (f <= 0.70)        return 2;  // second breath
    return 3;                        // final sprint + highlight closer
  }

  const n = songs.length;
  const result = [];
  for (let i = 0; i < n; i++) {
    const d = desiredRank(i, n);
    const song = d === 3 ? pickFrom(3, 2, 1)
               : d === 1 ? pickFrom(1, 2, 3)
               :            pickFrom(2, 3, 1);
    if (song) result.push(song);
  }
  for (const r of [3, 2, 1]) result.push(...(buckets[r] || []));

  applyKeyVariety(result);
  return result;
}

function applyKeyVariety(songs) {
  // Avoid the same key 3+ times in a row by swapping with a later different-key song
  for (let i = 2; i < songs.length; i++) {
    if (!songs[i].key || songs[i].key !== songs[i - 1].key || songs[i].key !== songs[i - 2].key) continue;
    for (let j = i + 1; j < songs.length; j++) {
      if (songs[j].key !== songs[i].key) {
        [songs[i], songs[j]] = [songs[j], songs[i]];
        break;
      }
    }
  }
}

// --- Drag and drop reorder ---

function initDragAndDrop() {
  const ul = document.querySelector('.song-list');
  if (!ul) return;

  let dragSrcIndex = null;

  ul.addEventListener('dragstart', e => {
    const li = e.target.closest('li[data-index]');
    if (!li) return;
    dragSrcIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  ul.addEventListener('dragend', () => {
    ul.querySelectorAll('.song-item').forEach(el =>
      el.classList.remove('dragging', 'drag-over'));
  });

  ul.addEventListener('dragover', e => {
    e.preventDefault();
    const li = e.target.closest('li[data-index]');
    if (!li) return;
    ul.querySelectorAll('.song-item').forEach(el => el.classList.remove('drag-over'));
    if (Number(li.dataset.index) !== dragSrcIndex) li.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
  });

  ul.addEventListener('drop', e => {
    e.preventDefault();
    const li = e.target.closest('li[data-index]');
    if (!li || dragSrcIndex === null) return;
    const destIndex = Number(li.dataset.index);
    if (dragSrcIndex === destIndex) return;
    const [moved] = currentSet.splice(dragSrcIndex, 1);
    currentSet.splice(destIndex, 0, moved);
    renderResult(currentSet);
  });
}

// --- Accept / auth flow ---

function openAcceptModal() {
  const token = getToken();
  document.getElementById('auth-step').style.display  = token ? 'none'  : 'block';
  document.getElementById('save-step').style.display  = token ? 'block' : 'none';
  if (token) loadGigs();
  document.getElementById('accept-modal').classList.add('open');
  setTimeout(() => {
    const focus = token ? 'setlist-title' : 'password-input';
    document.getElementById(focus)?.focus();
  }, 50);
}

function _closeAcceptModal() {
  document.getElementById('accept-modal').classList.remove('open');
  document.getElementById('auth-error').className = 'status-msg';
  document.getElementById('save-error').className = 'status-msg';
  document.getElementById('new-gig-form').classList.remove('open');
  document.getElementById('password-input').value = '';
  document.getElementById('setlist-title').value = '';
  document.getElementById('setlist-comment').value = '';
}
registerModal('accept-modal', _closeAcceptModal);

document.getElementById('verify-btn').addEventListener('click', async () => {
  const pw = document.getElementById('password-input').value.trim();
  if (!pw) return;
  const r = await fetch(`/api/${artistSlug}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (r.ok) {
    sessionStorage.setItem(AUTH_TOKEN_KEY, pw);
    document.getElementById('auth-step').style.display = 'none';
    document.getElementById('save-step').style.display = 'block';
    loadGigs();
    setTimeout(() => document.getElementById('setlist-title')?.focus(), 50);
  } else {
    const err = document.getElementById('auth-error');
    err.textContent = t('setlist.wrongPassword');
    err.className = 'status-msg error';
  }
});

document.getElementById('password-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('verify-btn').click();
});

async function loadGigs() {
  try {
    const r = await apiFetch(`/api/${artistSlug}/gigs?limit=500`);
    if (!r.ok) return;
    const { rows } = await r.json();
    const sel = document.getElementById('gig-select');
    while (sel.options.length > 1) sel.remove(1);
    for (const g of rows) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.title + (g.date ? ' — ' + formatDate(g.date) : '');
      sel.appendChild(opt);
    }
  } catch {}
}

document.getElementById('new-gig-btn').addEventListener('click', () => {
  document.getElementById('new-gig-form').classList.toggle('open');
});

document.getElementById('create-gig-btn').addEventListener('click', async () => {
  const name  = document.getElementById('gig-name').value.trim();
  if (!name) return;
  const date  = document.getElementById('gig-date').value || null;
  const token = getToken();
  const r = await withBusy(document.getElementById('create-gig-btn'), () => fetch(`/api/${artistSlug}/gigs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ title: name, date }),
  }));
  if (!r) return;
  if (r.ok) {
    const gig = await r.json();
    const sel = document.getElementById('gig-select');
    const opt = document.createElement('option');
    opt.value = gig.id;
    opt.textContent = gig.title + (gig.date ? ' — ' + formatDate(gig.date) : '');
    sel.appendChild(opt);
    sel.value = String(gig.id);
    document.getElementById('new-gig-form').classList.remove('open');
    ['gig-name', 'gig-date'].forEach(id => { document.getElementById(id).value = ''; });
  }
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const token   = getToken();
  const title   = document.getElementById('setlist-title').value.trim();
  const gigId   = document.getElementById('gig-select').value || null;
  const comment = document.getElementById('setlist-comment').value.trim() || null;
  const songIds = currentSet.map(s => s.id).filter(id => Number.isInteger(id) && id > 0);

  if (!title) {
    const err = document.getElementById('save-error');
    err.textContent = t('setlist.nameRequired');
    err.className = 'status-msg error';
    document.getElementById('setlist-title').focus();
    return;
  }

  if (songIds.length !== currentSet.length) {
    const err = document.getElementById('save-error');
    err.textContent = t('setlist.missingIds');
    err.className = 'status-msg error';
    return;
  }

  const r = await withBusy(document.getElementById('save-btn'), () => fetch(`/api/${artistSlug}/setlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ title: title || null, gig_id: gigId ? Number(gigId) : null, comment, song_ids: songIds }),
  }));
  if (!r) return;

  if (r.status === 401) {
    clearToken();
    localStorage.removeItem(AUTH_TOKEN_KEY);
    document.getElementById('save-step').style.display = 'none';
    document.getElementById('auth-step').style.display = 'block';
    const err = document.getElementById('auth-error');
    err.textContent = t('setlist.sessionExpired');
    err.className = 'status-msg error';
    return;
  }

  if (r.ok) {
    const saved = await r.json();
    _closeAcceptModal();
    _histLoaded = false;  // force fresh fetch so the new setlist appears
    _histPendingOpenId = String(saved.id);
    switchTab('history');
  } else {
    const err = document.getElementById('save-error');
    err.textContent = t('setlist.saveFailed');
    err.className = 'status-msg error';
  }
});

document.getElementById('accept-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) _closeAcceptModal();
});

// --- Tab routing ---

function _updateTabBar() {
  document.querySelectorAll('.setlist-tab').forEach(function(t) {
    t.classList.toggle('setlist-tab--active', t.dataset.tab === _activeView);
  });
}

function switchTab(view) {
  _activeView = view;
  var _tabBase = '/' + _artistSlug + '/setlist';
  history.pushState(null, '', view === 'history' ? _tabBase + '?view=history' : _tabBase);
  _updateTabBar();
  _closeSongPanel();
  if (_histView) _histView.deselect();
  var titleEl = document.getElementById('setlist-page-title');
  if (view === 'history') {
    if (titleEl) titleEl.style.display = 'none';
    _renderHistoryTab();
  } else {
    if (titleEl) titleEl.style.display = '';
    renderControls();
    applyDemoFilters();
  }
}



function _getSetYear(s) {
  var gig = _histGigMap[s.gig_id];
  return (gig && gig.date)
    ? String(gig.date).slice(0, 4)
    : (s.gig_date ? String(s.gig_date).slice(0, 4) : 'Templates');
}

function _getVisibleSets(state) {
  return _histSets.filter(function(s) {
    var gig = _histGigMap[s.gig_id];
    if (state.setlist    && !(s.title || '').toLowerCase().includes(state.setlist))    return false;
    if (state.gig        && (!gig || !(gig.title || '').toLowerCase().includes(state.gig)))        return false;
    if (state.venue      && (!gig || !(gig.venue_name || '').toLowerCase().includes(state.venue)))      return false;
    if (state.organizer  && (!gig || !(gig.organizer_name || '').toLowerCase().includes(state.organizer))) return false;
    if (state.song !== undefined && state.song !== null && !state.song.has(s.id)) return false;
    return true;
  });
}

async function _resolveHistSongFilter(q) {
  var matchingSongs = (allSongs || []).filter(function(s) {
    return (s.title || '').toLowerCase().includes(q.toLowerCase());
  });
  if (!matchingSongs.length) return new Set();
  try {
    var results = await Promise.all(
      matchingSongs.map(function(s) {
        return apiFetch('/api/' + artistSlug + '/songs/' + s.id + '/setlists')
          .then(function(r) { return r.json(); });
      })
    );
    return new Set(results.reduce(function(acc, objs) {
      return acc.concat(objs.map(function(o) { return o.id; }));
    }, []));
  } catch {
    return new Set();
  }
}

function _openHistPanelContent(item, panelEl) {
  var sid = String(item.id);
  var s   = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;
  var gig = _histGigMap[s.gig_id] || null;

  var gigBlock = gig
    ? '<div class="vsp-section-label">' + t('setlist.panelGig') + '</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:flex-start;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' +
          '<strong>' + escHtml(gig.title) + '</strong>' +
          (gig.date ? '<br><span style="color:var(--third-color);font-size:0.8rem">' + escHtml(formatDate(gig.date)) + '</span>' : '') +
        '</div>' +
        (_viewMode ? '' : '<button class="hist-nav-btn" onclick="navigate(\'/gigs?open=' + gig.id + '\')" title="' + t('setlist.openInGigs') + '">&#8599;</button>') +
      '</div>'
    : '<div class="vsp-section-label">' + t('setlist.panelGig') + '</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="color:var(--third-color)">' + t('setlist.panelNoGig') + '</div></div>';

  var venueBlock = (gig && gig.venue_id)
    ? '<div class="vsp-section-label">' + t('setlist.panelVenue') + '</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:center;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' +
          escHtml(gig.venue_name || '') +
          (gig.venue_city ? ', ' + escHtml(gig.venue_city) : '') +
        '</div>' +
        (_viewMode ? '' : '<button class="hist-nav-btn" onclick="navigate(\'/venues?open=' + gig.venue_id + '\')" title="' + t('setlist.openInVenues') + '">&#8599;</button>') +
      '</div>'
    : '';

  var orgBlock = (gig && gig.organizer_id)
    ? '<div class="vsp-section-label">' + t('setlist.panelOrganizer') + '</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:center;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' + escHtml(gig.organizer_name || '') + '</div>' +
        (_viewMode ? '' : '<button class="hist-nav-btn" onclick="navigate(\'/organizers?open=' + gig.organizer_id + '\')" title="' + t('setlist.openInOrganizers') + '">&#8599;</button>') +
      '</div>'
    : '';

  var commentBlock = s.comment
    ? '<div class="vsp-section-label">' + t('setlist.panelComment') + '</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="white-space:pre-wrap">' + escHtml(s.comment) + '</div></div>'
    : '';

  panelEl.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + escHtml(s.title || t('setlist.untitled')) + '</h2></div>' +
      '<button class="vsp-close" onclick="_histView && _histView.deselect()" aria-label="' + t('setlist.closeBtn') + '">&#215;</button>' +
    '</div>' +
    '<div class="vsp-actions" style="margin-bottom:1rem;">' +
      (_viewMode ? '' :
        '<button class="btn icon-btn" data-tooltip="' + t('setlist.editTooltip') + '" onclick="_histEdit(\'' + escHtml(sid) + '\')">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/>' +
          '</svg>' +
        '</button>') +
      (_viewMode ? '' :
        '<button class="btn icon-btn" data-tooltip="' + t('setlist.duplicateTooltip') + '" onclick="_histDuplicate(\'' + escHtml(sid) + '\')">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
            '<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>' +
          '</svg>' +
        '</button>') +
      '<button class="btn" onclick="_histStage(\'' + escHtml(sid) + '\')">' + t('setlist.stageBtn') + '</button>' +
      (_viewMode ? '' :
        '<button class="btn share-btn" onclick="_histShareMenu(\'' + escHtml(sid) + '\', this)">' +
          SHARE_ICON + '<span style="margin-left:4px">' + t('setlist.shareBtn') + '</span>' +
        '</button>') +
    '</div>' +
    gigBlock + venueBlock + orgBlock + commentBlock +
    '<div id="hist-song-detail"></div>';

  // Expand accordion body to show songs (lazy-loads if not yet fetched)
  var body = document.getElementById('hist-body-' + sid);
  if (body && body.hidden) {
    body.hidden = false;
    var toggle = document.querySelector('[data-id="' + sid + '"] .hist-toggle');
    if (toggle) toggle.innerHTML = '&#9660;';
    if (!_histLoadedSongs[sid]) body.innerHTML = skeletonHtml(3);
  }
  _loadAndRenderHistSongs(sid);
}

async function _renderHistoryTab() {
  var content = document.getElementById('setlist-content');
  if (!content) return;
  content.innerHTML = skeletonHtml(4);

  if (!_histLoaded) {
    try {
      var setsRes = await apiFetch('/api/' + artistSlug + '/setlists');
      var gigsRes = await apiFetch('/api/' + artistSlug + '/gigs?limit=500');
      _histSets = await setsRes.json();
      if (!Array.isArray(_histSets)) _histSets = [];
      var gigsData = await gigsRes.json();
      _histGigs = gigsData.rows || [];
      _histGigMap = {};
      _histGigs.forEach(function(g) { _histGigMap[g.id] = g; });
      _histLoaded = true;
    } catch {
      content.innerHTML = '<p style="text-align:center;color:var(--third-color);">' + t('setlist.couldNotLoadHistory') + '</p>';
      return;
    }
  }

  _histView = createListView({
    container:  content,
    filters: [
      { id: 'setlist', label: t('setlist.filterSetlist'), type: FILTER_TYPES.TEXT,       field: 'title' },
      { id: 'gig',     label: t('setlist.filterGig'),     type: FILTER_TYPES.TEXT,       field: 'gig.title' },
      { id: 'venue',   label: t('setlist.filterVenue'),   type: FILTER_TYPES.TEXT,       field: 'gig.venue_name' },
      { id: 'song',    label: t('setlist.filterSong'),    type: FILTER_TYPES.ASYNC_TEXT,
        resolve: _resolveHistSongFilter },
    ],
    getData:   _getVisibleSets,
    getTotal:  function() { return _histSets.length; },
    getItemId: function(s) { return s.id; },
    renderRow: _renderHistRow,
    emptyHtml: '<div style="text-align:center;padding:2.5rem 1rem;color:var(--third-color);">' +
      '<p style="margin-bottom:1rem;">' + t('setlist.noSetlists') + '</p>' +
      '<button class="btn active" onclick="switchTab(\'generator\')">' + t('setlist.buildFirst') + '</button>' +
      '</div>',
    groupBy:   _getSetYear,
    groupSort: function(a, b) { return b > a ? 1 : -1; },
    onOpen:    _openHistPanelContent,
    onRowClick: function(id, panels) {
      if (window.innerWidth <= 1024) {
        _toggleHistItemBody(String(id));
      } else {
        panels.openPanel(id);
      }
    },
  });

  var qp = new URLSearchParams(location.search);
  ['setlist', 'gig', 'venue', 'song'].forEach(function(k) {
    if (qp.get(k)) _histView.setFilterValue(k, qp.get(k));
  });

  if (_histPendingOpenId) {
    _histView.select(_histPendingOpenId);
    _histPendingOpenId = null;
  }

  requestAnimationFrame(function() {
    var hdr  = document.querySelector('.app-header');
    var tabs = document.getElementById('setlist-tabs');
    if (hdr && tabs) {
      var offset = hdr.getBoundingClientRect().height + tabs.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--songs-toolbar-top', offset + 'px');
    }
  });
}

function _renderHistRow(s) {
  var gig       = _histGigMap[s.gig_id];
  var gigName   = (gig && gig.title)      || s.gig_name  || '';
  var gigDate   = (gig && gig.date)       || s.gig_date  || '';
  var venueName = (gig && gig.venue_name) || s.gig_venue || '';

  var count = s.song_count != null ? Number(s.song_count) : 0;
  var countBadge = '<span class="hist-badge hist-badge--count">' + count + ' ' + t(count !== 1 ? 'setlist.songs' : 'setlist.song') + '</span>';
  var dateBadge  = gigDate
    ? '<span class="hist-badge hist-badge--date">' + formatDate(gigDate, 'short') + '</span>'
    : '';

  var orgName = (gig && gig.organizer_name) || '';
  var headerLinks = [];
  if (gigName)   headerLinks.push(gig && gig.id
    ? '<span class="hist-meta-link" onclick="event.stopPropagation();navigate(\'/gigs?open=' + gig.id + '\')">' + escHtml(gigName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(gigName) + '</span>');
  if (venueName) headerLinks.push(gig && gig.venue_id
    ? '<span class="hist-meta-link" onclick="event.stopPropagation();navigate(\'/venues?open=' + gig.venue_id + '\')">' + escHtml(venueName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(venueName) + '</span>');
  if (orgName)   headerLinks.push(gig && gig.organizer_id
    ? '<span class="hist-meta-link" onclick="event.stopPropagation();navigate(\'/organizers?open=' + gig.organizer_id + '\')">' + escHtml(orgName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(orgName) + '</span>');

  var sid = String(s.id);
  return '<div class="hist-item" data-id="' + escHtml(sid) + '">' +
    '<div class="hist-item-header">' +
      '<div class="hist-item-main">' +
        '<div class="hist-item-titlerow">' +
          '<span class="hist-item-title">' + escHtml(s.title || t('setlist.untitled')) + '</span>' +
          '<div class="hist-item-badges">' + countBadge + dateBadge + '</div>' +
        '</div>' +
        (s.comment ? '<div class="hist-item-comment">' + escHtml(s.comment) + '</div>' : '') +
        (headerLinks.length ? '<div class="hist-meta-links hist-meta-links--header">' + headerLinks.join('') + '</div>' : '') +
      '</div>' +
      '<button class="hist-toggle" onclick="event.stopPropagation();_toggleHistItemBody(\'' + escHtml(sid) + '\')" title="' + t('setlist.showSongs') + '">&#9654;</button>' +
      '<button class="hist-details-btn" onclick="event.stopPropagation();_histView&&_histView.select(\'' + escHtml(sid) + '\')" title="' + t('setlist.detailsBtn') + '" aria-label="' + t('setlist.detailsBtn') + '">&#8801;</button>' +
    '</div>' +
  '</div>' +
  '<div class="hist-body" id="hist-body-' + escHtml(sid) + '" hidden></div>';
}

function _toggleHistItemBody(sid) {
  sid = String(sid);
  var body   = document.getElementById('hist-body-' + sid);
  var toggle = document.querySelector('[data-id="' + sid + '"] .hist-toggle');
  if (!body) return;
  if (body.hidden) {
    body.hidden = false;
    if (toggle) toggle.innerHTML = '&#9660;';
    if (!_histLoadedSongs[sid]) body.innerHTML = skeletonHtml(3);
    _loadAndRenderHistSongs(sid);
  } else {
    body.hidden = true;
    if (toggle) toggle.innerHTML = '&#9654;';
  }
}

async function _loadHistSongs(sid) {
  sid = String(sid);
  if (_histLoadedSongs[sid]) return;
  try {
    var detail = await apiFetch('/api/' + artistSlug + '/setlists/' + sid).then(function(r) { return r.json(); });
    var songs = Array.isArray(detail) ? detail : (detail.songs || []);
    _histLoadedSongs[sid] = songs.slice().sort(function(a, b) { return (a.position || 0) - (b.position || 0); });
  } catch {
    // leave cache unset so the caller can retry on transient failures
  }
}

async function _loadAndRenderHistSongs(sid) {
  sid = String(sid);
  var body = document.getElementById('hist-body-' + sid);
  if (!body) return;

  await _loadHistSongs(sid);

  // If row was removed while loading, accordion body may no longer exist
  body = document.getElementById('hist-body-' + sid);
  if (!body) return;

  var loaded = _histLoadedSongs[sid];
  if (!loaded || !loaded.length) {
    body.innerHTML = '<p style="color:var(--third-color);font-size:0.82rem;padding:0.5rem 0.25rem">' + t('setlist.noSongsInSet') + '</p>';
    return;
  }

  var total = 0;
  var rows = loaded.map(function(song, i) {
    total += song.length_min || 0;
    return '<div class="hist-song-row" data-song-id="' + song.id + '" onclick="_openSongPanel(\'' + escHtml(sid) + '\',' + Number(song.id) + ')">' +
      '<span class="hist-song-pos">' + (i + 1) + '.</span>' +
      '<span class="hist-song-name">' + escHtml(song.title || '') + '</span>' +
      (song.key ? '<span class="hist-song-key">' + escHtml(formatKey(song.key)) + '</span>' : '') +
      '<span class="hist-song-len">' + formatLength(song.length_min) + '</span>' +
      (!_viewMode ? '<button class="hist-song-edit-btn" onclick="event.stopPropagation();navigate(\'/songs?id=' + Number(song.id) + '\')" title="' + t('setlist.openInSongsShort') + '" aria-label="' + t('setlist.openInSongsShort') + '">&#8599;</button>' : '') +
    '</div>';
  }).join('');

  body.innerHTML = rows + '<div class="hist-songs-total">' + t('setlist.total', { duration: formatLength(total) }) + '</div>';
}

function _histCancelEdit(sid) {
  _editSongs  = null;
  _editingSid = null;
  if (_histView) _histView.select(String(sid));
}

function _renderEditSongsList(sid) {
  var ul = document.getElementById('hist-edit-songs-ul');
  if (!ul) return;
  if (!_editSongs || !_editSongs.length) {
    ul.innerHTML = '<li style="color:var(--third-color);font-size:0.82rem;padding:0.4rem 0;list-style:none;">' + t('setlist.noSongsInSet') + '</li>';
    _refreshEditAddDropdown(sid);
    return;
  }
  var n = _editSongs.length;
  ul.innerHTML = _editSongs.map(function(song, i) {
    var isFirst = i === 0, isLast = i === n - 1;
    return '<li class="song-item" draggable="true" data-index="' + i + '">' +
      '<span class="drag-handle" aria-hidden="true">⠿</span>' +
      '<span class="song-num">' + (i + 1) + '.</span>' +
      '<div class="song-main">' +
        '<div class="song-top">' +
          '<span class="song-title">' + escHtml(song.title || '') + '</span>' +
          '<span class="song-time">' + formatLength(song.length_min) + '</span>' +
        '</div>' +
        (song.key ? '<div class="song-meta"><span>' + escHtml(formatKey(song.key)) + '</span></div>' : '') +
      '</div>' +
      '<div class="song-actions">' +
        '<button class="move-btn" onclick="_histEditMoveSong(' + i + ',-1,\'' + escHtml(sid) + '\')" ' + (isFirst ? 'disabled' : '') + ' aria-label="' + t('setlist.moveUp') + '">↑</button>' +
        '<button class="move-btn" onclick="_histEditMoveSong(' + i + ',1,\'' + escHtml(sid) + '\')" ' + (isLast ? 'disabled' : '') + ' aria-label="' + t('setlist.moveDown') + '">↓</button>' +
        '<button class="move-btn" onclick="_histEditRemoveSong(' + i + ',\'' + escHtml(sid) + '\')" title="' + t('setlist.removeTitle') + '">&#215;</button>' +
      '</div>' +
    '</li>';
  }).join('');
  _refreshEditAddDropdown(sid);
}

function _refreshEditAddDropdown(sid) {
  var sel = document.getElementById('hist-edit-add-select');
  if (!sel) return;
  var inSetIds = new Set((_editSongs || []).map(function(s) { return s.id; }));
  var available = allSongs
    .filter(function(s) { return s.active && !inSetIds.has(s.id); })
    .sort(function(a, b) { return (a.title || '').localeCompare(b.title || ''); });
  sel.innerHTML = '<option value="">' + t('setlist.addSongPlaceholder') + '</option>' +
    available.map(function(s) { return '<option value="' + s.id + '">' + escHtml(s.title || '') + '</option>'; }).join('');
}

function _histEditMoveSong(index, dir, sid) {
  if (!_editSongs) return;
  var newIndex = index + dir;
  if (newIndex < 0 || newIndex >= _editSongs.length) return;
  var tmp = _editSongs[index];
  _editSongs[index] = _editSongs[newIndex];
  _editSongs[newIndex] = tmp;
  _renderEditSongsList(sid);
}

function _histEditRemoveSong(index, sid) {
  if (!_editSongs) return;
  _editSongs.splice(index, 1);
  _renderEditSongsList(sid);
}

function _histEditAddSong(sel, sid) {
  var songId = Number(sel.value);
  if (!songId) return;
  var song = allSongs.find(function(s) { return s.id === songId; });
  if (!song || (_editSongs && _editSongs.some(function(s) { return s.id === songId; }))) return;
  if (!_editSongs) _editSongs = [];
  _editSongs.push(song);
  _renderEditSongsList(sid);
}

function _initEditSongsDnd(sid) {
  var ul = document.getElementById('hist-edit-songs-ul');
  if (!ul) return;
  var dragSrcIndex = null;
  ul.addEventListener('dragstart', function(e) {
    var li = e.target.closest('li[data-index]');
    if (!li) return;
    dragSrcIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  ul.addEventListener('dragend', function() {
    ul.querySelectorAll('.song-item').forEach(function(el) {
      el.classList.remove('dragging', 'drag-over');
    });
  });
  ul.addEventListener('dragover', function(e) {
    e.preventDefault();
    var li = e.target.closest('li[data-index]');
    if (!li) return;
    ul.querySelectorAll('.song-item').forEach(function(el) { el.classList.remove('drag-over'); });
    if (Number(li.dataset.index) !== dragSrcIndex) li.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
  });
  ul.addEventListener('drop', function(e) {
    e.preventDefault();
    var li = e.target.closest('li[data-index]');
    if (!li || dragSrcIndex === null || !_editSongs) return;
    var destIndex = Number(li.dataset.index);
    if (dragSrcIndex === destIndex) return;
    var moved = _editSongs.splice(dragSrcIndex, 1)[0];
    _editSongs.splice(destIndex, 0, moved);
    dragSrcIndex = null;
    _renderEditSongsList(sid);
  });
}

async function _histEdit(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var inner = document.getElementById('view-side-panel-inner');
  if (!inner) return;

  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + t('setlist.editPanelTitle') + '</h2></div>' +
      '<button class="vsp-close" onclick="_histCancelEdit(\'' + escHtml(sid) + '\')" aria-label="' + t('setlist.cancelBtn') + '">×</button>' +
    '</div>' +
    skeletonHtml(3);

  await _loadHistSongs(sid);
  _editSongs = (_histLoadedSongs[sid] || []).slice();

  var gigOptions = '<option value="">' + t('setlist.noGig') + '</option>' +
    _histGigs.map(function(g) {
      var sel = String(g.id) === String(s.gig_id) ? ' selected' : '';
      var label = escHtml(g.title || '') + (g.date ? ' — ' + formatDate(g.date) : '');
      return '<option value="' + g.id + '"' + sel + '>' + label + '</option>';
    }).join('');

  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + t('setlist.editPanelTitle') + '</h2></div>' +
      '<button class="vsp-close" onclick="_histCancelEdit(\'' + escHtml(sid) + '\')" aria-label="' + t('setlist.cancelBtn') + '">×</button>' +
    '</div>' +
    '<div style="padding:0 1rem 1rem;">' +
      '<div class="modal-field">' +
        '<label for="hist-edit-title">' + t('setlist.nameLabel') + '</label>' +
        '<input type="text" id="hist-edit-title" value="' + escHtml(s.title || '') + '" autocomplete="off">' +
      '</div>' +
      '<div class="modal-field">' +
        '<label for="hist-edit-gig">' + t('setlist.editGigLabel') + '</label>' +
        '<select id="hist-edit-gig">' + gigOptions + '</select>' +
      '</div>' +
      '<div class="modal-field">' +
        '<label for="hist-edit-comment">' + t('setlist.editCommentLabel') + '</label>' +
        '<textarea id="hist-edit-comment" placeholder="' + t('setlist.editCommentPlaceholder') + '">' + escHtml(s.comment || '') + '</textarea>' +
      '</div>' +
      '<div class="modal-field">' +
        '<label>' + t('setlist.editSongsLabel') + '</label>' +
        '<ul id="hist-edit-songs-ul" class="song-list" style="margin:0;padding:0;"></ul>' +
        '<div class="add-song-row" style="margin-top:0.5rem;">' +
          '<select id="hist-edit-add-select" onchange="_histEditAddSong(this,\'' + escHtml(sid) + '\')">' +
            '<option value="">' + t('setlist.addSongPlaceholder') + '</option>' +
          '</select>' +
        '</div>' +
      '</div>' +
      '<div class="status-msg" id="hist-edit-error"></div>' +
      '<div class="modal-actions" id="hist-edit-actions">' +
        '<button class="btn active" id="hist-edit-save" onclick="_saveHistEdit(\'' + escHtml(sid) + '\')">' + t('setlist.saveBtn') + '</button>' +
        '<button class="btn" onclick="_histCancelEdit(\'' + escHtml(sid) + '\')">' + t('setlist.cancelBtn') + '</button>' +
        '<button class="btn" style="margin-left:auto;color:#e55;" onclick="_promptDeleteSetlist(\'' + escHtml(sid) + '\')">' + t('setlist.deleteBtn') + '</button>' +
      '</div>' +
    '</div>';

  _editingSid = sid;
  _renderEditSongsList(sid);
  _initEditSongsDnd(sid);
  document.getElementById('hist-edit-title').focus();
}

async function _saveHistEdit(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var titleVal = (document.getElementById('hist-edit-title').value || '').trim();
  var gigId    = document.getElementById('hist-edit-gig').value || null;
  var comment  = (document.getElementById('hist-edit-comment').value || '').trim() || null;
  var token    = getToken();

  if (!titleVal) {
    var errEl = document.getElementById('hist-edit-error');
    if (errEl) { errEl.textContent = t('setlist.editNameRequired'); errEl.className = 'status-msg error'; }
    document.getElementById('hist-edit-title').focus();
    return;
  }

  var saveBtn = document.getElementById('hist-edit-save');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = t('setlist.editSaving'); }

  var songIds = (_editSongs || []).map(function(song) { return song.id; });

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists/' + sid, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ title: titleVal, gig_id: gigId ? Number(gigId) : null, comment: comment, song_ids: songIds })
    });

    if (r.status === 401) {
      clearToken();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      var errEl3 = document.getElementById('hist-edit-error');
      if (errEl3) { errEl3.textContent = t('setlist.editSessionExpired'); errEl3.className = 'status-msg error'; }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('setlist.saveBtn'); }
      return;
    }

    if (!r.ok) {
      var errEl4 = document.getElementById('hist-edit-error');
      if (errEl4) { errEl4.textContent = t('setlist.editSaveFailed'); errEl4.className = 'status-msg error'; }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('setlist.saveBtn'); }
      return;
    }

    // Update in-memory caches
    s.title      = titleVal;
    s.gig_id     = gigId ? Number(gigId) : null;
    s.comment    = comment;
    s.song_count = songIds.length;
    var updGig   = s.gig_id ? _histGigMap[s.gig_id] : null;
    s.gig_name   = updGig ? (updGig.title      || '') : null;
    s.gig_date   = updGig ? (updGig.date        || '') : null;
    s.gig_venue  = updGig ? (updGig.venue_name  || '') : null;
    _histLoadedSongs[sid] = (_editSongs || []).map(function(song, i) {
      return Object.assign({}, song, { position: i + 1 });
    });
    _editSongs = null;

    var okEl = document.getElementById('hist-edit-error');
    if (okEl) {
      okEl.textContent = t('setlist.editSaved');
      okEl.className = 'status-msg success';
      okEl.style.display = 'block';
      okEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    setTimeout(function() {
      if (_histView) {
        _histView.refresh();
        _histView.select(sid);
      }
    }, 900);
  } catch {
    var errEl5 = document.getElementById('hist-edit-error');
    if (errEl5) { errEl5.textContent = t('setlist.editNetworkError'); errEl5.className = 'status-msg error'; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('setlist.saveBtn'); }
  }
}

function _promptDeleteSetlist(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var gigNote = '';
  if (s.gig_id && s.gig_name) {
    var gigLabel = escHtml(s.gig_name) + (s.gig_date ? ' (' + formatDate(s.gig_date) + ')' : '');
    if (s.gig_venue) gigLabel += ' — ' + escHtml(s.gig_venue);
    gigNote = '<p style="font-size:0.82rem;color:var(--third-color);margin:0.5rem 0 0;">' + t('setlist.deleteLinkedGig', { gigLabel: gigLabel }) + '</p>';
  }

  var actionsEl = document.getElementById('hist-edit-actions');
  if (!actionsEl) return;
  actionsEl.innerHTML =
    '<p style="font-size:0.85rem;margin:0;">' + t('setlist.deleteConfirmMsg', { title: escHtml(s.title || t('setlist.untitled')) }) + '</p>' +
    gigNote +
    '<div style="display:flex;gap:0.5rem;margin-top:0.75rem;">' +
      '<button class="btn active" style="background:#e55;border-color:#e55;" onclick="_confirmDeleteSetlist(\'' + escHtml(sid) + '\')">' + t('setlist.deleteBtn') + '</button>' +
      '<button class="btn" onclick="_cancelDeleteSetlist(\'' + escHtml(sid) + '\')">' + t('setlist.keepIt') + '</button>' +
    '</div>';
}

function _cancelDeleteSetlist(sid) {
  sid = String(sid);
  var actionsEl = document.getElementById('hist-edit-actions');
  if (!actionsEl) return;
  actionsEl.innerHTML =
    '<button class="btn active" id="hist-edit-save" onclick="_saveHistEdit(\'' + escHtml(sid) + '\')">' + t('setlist.saveBtn') + '</button>' +
    '<button class="btn" onclick="_histCancelEdit(\'' + escHtml(sid) + '\')">' + t('setlist.cancelBtn') + '</button>' +
    '<button class="btn" style="margin-left:auto;color:#e55;" onclick="_promptDeleteSetlist(\'' + escHtml(sid) + '\')">' + t('setlist.deleteBtn') + '</button>';
}

async function _confirmDeleteSetlist(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var token = getToken();
  var actionsEl = document.getElementById('hist-edit-actions');
  if (actionsEl) actionsEl.innerHTML = '<p style="font-size:0.85rem;color:var(--third-color);margin:0;">' + t('setlist.deleting') + '</p>';

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists/' + sid, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) throw new Error('Failed');
    _histSets = _histSets.filter(function(x) { return String(x.id) !== sid; });
    delete _histLoadedSongs[sid];
    _editSongs = null;
    _editingSid = null;
    if (_histView) _histView.refresh();
  } catch {
    if (actionsEl) actionsEl.innerHTML = '<p style="font-size:0.85rem;color:#e55;margin:0;">' + t('setlist.deleteFailed') + '</p>' +
      '<button class="btn" style="margin-top:0.5rem;" onclick="_cancelDeleteSetlist(\'' + escHtml(sid) + '\')">' + t('setlist.backBtn') + '</button>';
  }
}

function _closeSongPanel() {
  document.querySelectorAll('.hist-song-row--active').forEach(function(el) {
    el.classList.remove('hist-song-row--active');
  });
  if (_histView) _histView.deselect();
}

function _openSongPanel(setlistSid, songId) {
  setlistSid = String(setlistSid);
  songId = Number(songId);

  var songs = _histLoadedSongs[setlistSid] || [];
  var song = songs.find(function(s) { return s.id === songId; });
  if (!song) return;

  // Toggle off if same song clicked again
  var prev = document.querySelector('.hist-song-row--active');
  if (prev && Number(prev.dataset.songId) === songId) {
    _closeSongPanel();
    return;
  }

  // Highlight active row
  document.querySelectorAll('.hist-song-row--active').forEach(function(el) { el.classList.remove('hist-song-row--active'); });
  var rowEl = document.querySelector('.hist-song-row[data-song-id="' + songId + '"]');
  if (rowEl) rowEl.classList.add('hist-song-row--active');

  // Open panel with song-only content — no gig/venue/organizer meta
  var panel = document.getElementById('view-side-panel');
  var inner = document.getElementById('view-side-panel-inner');
  if (!panel || !inner) return;

  var s = _histSets.find(function(x) { return String(x.id) === setlistSid; });
  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + escHtml((s && s.title) || t('setlist.untitled')) + '</h2></div>' +
      '<button class="vsp-close" onclick="_closeSongPanel()" aria-label="' + t('setlist.closeBtn') + '">&#215;</button>' +
    '</div>' +
    '<div id="hist-song-detail"></div>';

  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    var content = document.getElementById('setlist-content');
    if (content) content.classList.add('side-panel-open');
    if (window.innerWidth <= 1024) document.body.style.overflow = 'hidden';
  }

  var detail = document.getElementById('hist-song-detail');
  if (!detail) return;

  // Build field cells using displayFields if configured
  var displayFields = (bandConfig && bandConfig.displayFields) || [];
  var fieldMap = {};
  displayFields.forEach(function(f) { fieldMap[f.field] = f.label; });

  function cellVal(field) {
    if (field.startsWith('extra.')) return song.extra && song.extra[field.slice(6)];
    return song[field];
  }

  var defaultFields = ['key', 'genre', 'energy', 'length_min', 'extra.lead', 'extra.banjoCapo', 'extra.gitCapo'];
  var shownFields = displayFields.length ? displayFields.map(function(f) { return f.field; }) : defaultFields;
  if (shownFields.indexOf('length_min') === -1) shownFields = shownFields.concat(['length_min']);
  shownFields = shownFields.filter(function(f) { return !songFieldHidden(bandConfig, f); });

  var cells = shownFields.map(function(field) {
    var val = cellVal(field);
    if (val === null || val === undefined || val === '') return '';
    var label = fieldMap[field] || field.replace('extra.', '').replace(/_/g, ' ');
    var display = field === 'length_min' ? formatLength(val) : field === 'key' ? escHtml(formatKey(String(val))) : escHtml(String(val));
    return '<div class="vsp-cell">' +
      '<div class="vsp-cell-label">' + escHtml(label) + '</div>' +
      '<div class="vsp-cell-value">' + display + '</div>' +
    '</div>';
  }).filter(Boolean).join('');

  var commentBlock = song.comment
    ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="white-space:pre-wrap;color:var(--third-color);font-size:0.82rem">' + escHtml(song.comment) + '</div></div>'
    : '';

  // Lyrics are not in the song list: fetched with the song's details below.
  var hasLyrics = !!(song.has_lyrics || song.lyrics);
  var lyricsBlock = hasLyrics
    ? '<div class="vsp-section-label">' + t('setlist.lyricsLabel') + '</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" id="hist-song-lyrics" style="white-space:pre-wrap;font-size:0.8rem;max-height:12rem;overflow-y:auto">' +
        (song.lyrics ? escHtml(song.lyrics) : t('common.loading')) + '</div></div>'
    : '';

  detail.innerHTML =
    '<div class="vsp-section-label">' + escHtml(song.title || '') + '</div>' +
    (cells || '') +
    commentBlock + lyricsBlock +
    '<div class="vsp-actions" style="margin-top:0.75rem;">' +
      '<button class="btn" onclick="navigate(\'/songs?id=' + Number(song.id) + '\')">' + t('setlist.openInSongs') + '</button>' +
    '</div>';
  if (hasLyrics && song.lyrics === undefined) {
    loadSongLyrics(_artistSlug, song).then(function(text) {
      var el = document.getElementById('hist-song-lyrics');
      if (el) el.textContent = text;
    }).catch(function() {
      var el = document.getElementById('hist-song-lyrics');
      if (el) el.textContent = '';
    });
  }
}

function _histStage(sid) {
  window.open('/' + _artistSlug + '/stage?id=' + sid, '_blank');
}

async function _histExportPdf(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  await _loadHistSongs(sid);
  var cfg = await loadConfig();
  printSetlistSongs(_histLoadedSongs[sid] || [], (s && s.title) || '', cfg);
}

function _histShareMenu(sid, btn) {
  sid = String(sid);
  var existing = document.getElementById('share-menu-popup');
  if (existing) {
    existing.remove();
    if (existing.dataset.sid === sid) return;
  }

  var menu = document.createElement('div');
  menu.id = 'share-menu-popup';
  menu.className = 'share-menu';
  menu.dataset.sid = sid;
  menu.innerHTML =
    '<div class="share-menu-item" onclick="_histExportPdf(\'' + escHtml(sid) + '\');var m=document.getElementById(\'share-menu-popup\');if(m)m.remove()">' +
      '<span class="share-menu-icon">⎙</span><span class="share-menu-label">' + t('setlist.shareMenuExportPdf') + '</span>' +
    '</div>' +
    '<div class="share-menu-item" onclick="_histCopyLink(\'' + escHtml(sid) + '\')">' +
      '<span class="share-menu-icon">⧉</span><span class="share-menu-label">' + t('setlist.shareMenuCopyLink') + '</span>' +
    '</div>' +
    '<div class="share-menu-item" onclick="var m=document.getElementById(\'share-menu-popup\');if(m)m.remove();_histShare(\'' + escHtml(sid) + '\')">' +
      '<span class="share-menu-icon">✉</span><span class="share-menu-label">' + t('setlist.shareMenuEmail') + '</span>' +
    '</div>';

  var rect = btn.getBoundingClientRect();
  menu.style.cssText = 'position:fixed;top:' + (rect.bottom + 6) + 'px;left:' + rect.left + 'px';
  document.body.appendChild(menu);
  // Shift left if overflowing right edge
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

function _histCopyLink(sid) {
  var url = location.origin + '/' + _artistSlug + '/stage?id=' + sid;
  var menu = document.getElementById('share-menu-popup');
  var item = menu && menu.querySelectorAll('.share-menu-item')[1];
  if (item) item.innerHTML = '<span class="share-menu-icon">✓</span><span class="share-menu-label">' + t('setlist.shareMenuCopied') + '</span>';
  navigator.clipboard.writeText(url).catch(function() {
    if (item) item.innerHTML = '<span class="share-menu-icon">⧉</span><span class="share-menu-label">' + t('setlist.shareMenuCopyLink') + '</span>';
  });
  setTimeout(function() { if (menu && menu.parentNode) menu.remove(); }, 900);
}

function _histShare(sid) {
  sid = String(sid);
  var inner = document.getElementById('view-side-panel-inner');
  if (!inner) return;
  var hasToken = !!getToken();

  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + t('setlist.sharePanelTitle') + '</h2></div>' +
      '<button class="vsp-close" onclick="_histCancelEdit(\'' + escHtml(sid) + '\')" aria-label="' + t('setlist.cancelBtn') + '">×</button>' +
    '</div>' +
    '<p style="padding:0 1rem;font-size:0.84rem;color:var(--third-color);">' + t('setlist.shareSendPdf') + '</p>' +
    '<div style="padding:0 1rem;">' +
      (!hasToken
        ? '<div class="modal-field"><label for="hist-share-pw">' + t('setlist.sharePasswordLabel') + '</label>' +
          '<input type="password" id="hist-share-pw" autocomplete="current-password" placeholder="' + t('setlist.passwordPlaceholder') + '"></div>'
        : '') +
      '<div class="modal-field"><label for="hist-share-email">' + t('setlist.shareEmailLabel') + '</label>' +
        '<input type="email" id="hist-share-email" placeholder="' + t('setlist.shareEmailPlaceholder') + '"></div>' +
      '<div class="status-msg" id="hist-share-status"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn active" id="hist-share-send" onclick="_histShareSend(\'' + escHtml(sid) + '\')">' + t('setlist.shareSendBtn') + '</button>' +
        '<button class="btn" onclick="_histCancelEdit(\'' + escHtml(sid) + '\')">' + t('setlist.cancelBtn') + '</button>' +
      '</div>' +
    '</div>';

  var focusId = hasToken ? 'hist-share-email' : 'hist-share-pw';
  setTimeout(function() { var el = document.getElementById(focusId); if (el) el.focus(); }, 50);
}

async function _histShareSend(sid) {
  sid = String(sid);
  var email = (document.getElementById('hist-share-email').value || '').trim();
  var st = document.getElementById('hist-share-status');

  if (!email) {
    if (st) { st.textContent = t('setlist.shareEnterEmail'); st.className = 'status-msg error'; }
    document.getElementById('hist-share-email').focus();
    return;
  }

  var token = getToken();
  var pwEl = document.getElementById('hist-share-pw');
  if (pwEl && pwEl.value.trim()) token = pwEl.value.trim();

  if (!token) {
    if (st) { st.textContent = t('setlist.sharePasswordRequired'); st.className = 'status-msg error'; }
    if (pwEl) pwEl.focus();
    return;
  }

  var btn = document.getElementById('hist-share-send');
  if (btn) { btn.disabled = true; btn.textContent = t('setlist.shareSending'); }
  if (st) { st.textContent = ''; st.className = 'status-msg'; }

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ share_id: Number(sid), email: email })
    });

    if (r.status === 401) {
      clearToken();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      if (st) { st.textContent = t('setlist.shareWrongPassword'); st.className = 'status-msg error'; }
      if (btn) { btn.disabled = false; btn.textContent = t('setlist.shareSendBtn'); }
      return;
    }

    if (r.ok) {
      sessionStorage.setItem(AUTH_TOKEN_KEY, token);
      if (st) { st.textContent = t('setlist.shareSentTo', { email: email }); st.className = 'status-msg success'; st.style.display = 'block'; }
      if (btn) btn.disabled = true;
      setTimeout(function() { _histCancelEdit(sid); }, 1800);
    } else {
      var errData = await r.json().catch(function() { return {}; });
      if (st) { st.textContent = errData.error || t('setlist.shareGenericFailed'); st.className = 'status-msg error'; }
      if (btn) { btn.disabled = false; btn.textContent = t('setlist.shareSendBtn'); }
    }
  } catch {
    if (st) { st.textContent = t('setlist.shareNetworkError'); st.className = 'status-msg error'; }
    if (btn) { btn.disabled = false; btn.textContent = t('setlist.shareSendBtn'); }
  }
}

async function _histDuplicate(sid) {
  sid = String(sid);
  var token = getToken();

  var dupBtn = document.querySelector('.vsp-actions button[onclick*="_histDuplicate"]');

  if (!token) {
    if (dupBtn) {
      dupBtn.insertAdjacentHTML('afterend', '<span id="dup-status" style="font-size:0.78rem;color:var(--third-color);display:block;margin-top:0.4rem;">' + t('setlist.dupLoginFirst') + '</span>');
    }
    return;
  }

  if (dupBtn) { dupBtn.disabled = true; dupBtn.textContent = '…'; }

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ duplicate_id: Number(sid) })
    });

    if (r.status === 401) {
      clearToken();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = t('setlist.duplicateTooltip'); }
      return;
    }

    if (r.ok) {
      var created = await r.json();
      _histSets.unshift(created);
      if (_histView) {
        _histView.refresh();
        _histView.select(String(created.id));
      }
    } else {
      if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = t('setlist.duplicateTooltip'); }
    }
  } catch {
    if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = t('setlist.duplicateTooltip'); }
  }
}

// --- PDF export ---

async function printSetlist() {
  var cfg = await loadConfig();
  printSetlistSongs(currentSet, '', cfg);
}

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  _closeSongPanel();
  if (_histView) _histView.deselect();
});

init();
