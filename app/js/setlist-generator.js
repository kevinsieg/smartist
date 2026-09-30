// Setlists page — the generator: filters, feel curve, capo and key ordering,
// the result list with drag and drop, and saving a generated set. Loaded
// before setlist-history-tab.js and setlist.js, which calls init().

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
    const tagSet = activeFilters.get('tags');
    if (tagSet && tagSet.size && !songTags(song).some(tag => tagSet.has(tag))) return false;
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

  _applyFinalOrder(currentSet);
  renderResult(currentSet);
}

function _groupByTagOn() {
  return !!document.getElementById('group-by-tag')?.checked;
}

// Break index chosen when the set was ordered; null = compute from the list.
// Reordering a set (capo, tags) can shift where half the time falls, so the
// render must keep this one instead of recomputing it.
var _splitAt = null;

// Capo order, then tag groups — per set when split. Returns the order and the break.
function _finalizeOrder(set, split, group) {
  const finish = songs => { const s = applyCapoOpts(songs); return group ? orderByFirstTag(s) : s; };
  if (!split || set.length < 2) return { songs: finish(set), splitAt: null };
  const mid = computeSplitIndex(set);
  return { songs: [...finish(set.slice(0, mid)), ...finish(set.slice(mid))], splitAt: mid };
}

function _applyFinalOrder(set) {
  const out = _finalizeOrder(set, !!document.getElementById('split-sets')?.checked, _groupByTagOn());
  currentSet = out.songs;
  _splitAt = out.splitAt;
}

function moveSong(index, dir) {
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= currentSet.length) return;
  [currentSet[index], currentSet[newIndex]] = [currentSet[newIndex], currentSet[index]];
  _splitAt = null;
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
  _refreshTagOptions(base);
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
      return `<button class="filter-btn${currentActive.has(v) ? ' active' : ''}" data-field="${escHtml(f.field)}" data-value="${escHtml(v)}" data-onclick="toggleFilter(this)">${escHtml(label)}</button>`;
    }).join('');
  }
}

function _refreshTagOptions(base) {
  const container = document.querySelector('.filter-buttons[data-field="tags"]');
  const filterSet = activeFilters.get('tags');
  if (!container || !filterSet) return;
  const tags = bandTags(base);
  for (const v of [...filterSet]) { if (tags.indexOf(v) === -1) filterSet.delete(v); }
  container.innerHTML = tags.map(v =>
    `<button class="filter-btn${filterSet.has(v) ? ' active' : ''}" data-field="tags" data-value="${escHtml(v)}" data-onclick="toggleFilter(this)">${escHtml(v)}</button>`
  ).join('');
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
  const hasTags = bandTags(allSongs).length > 0;
  if (hasTags) activeFilters.set('tags', new Set());

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
  ).join('') + (hasTags
    ? `<div class="filter-row">
      <span class="filter-label">${t('setlist.tags')}</span>
      <div class="filter-buttons" data-field="tags"></div>
    </div>`
    : '');

  document.getElementById('setlist-content').innerHTML = `
    <div class="setlist-controls">
      <div class="gen-sentence">
        <button class="btn generate-btn" data-onclick="onGenerate()">${t('setlist.generateBtn')}</button>
        <span class="gen-prose">${t('setlist.genProseOf')}</span>
        <input type="number" id="target-min" min="0" max="300" value="45" class="gen-duration-input">
        <span class="gen-prose">${t('setlist.genProseMin')}${filterRows ? ' ' + t('setlist.genProseWith') : ''}</span>
        ${filterRows ? `<button class="controls-toggle" id="controls-toggle" data-onclick="toggleControls()" aria-expanded="false"><span class="toggle-arrow">▼</span> ${t('setlist.filtersBtn')}</button>` : ''}
      </div>
      <div id="controls-body" style="display:none">
        ${filterRows}
      </div>
      <div class="gen-options">
        <label class="active-toggle">
          <input type="checkbox" id="active-only" checked data-onchange="refreshFilterOptions()">
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
        ${hasTags ? `<label class="active-toggle">
          <input type="checkbox" id="group-by-tag">
          ${t('setlist.groupByTag')}
        </label>` : ''}
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
  const splitAt = split && songs.length >= 2 ? (_splitAt ?? computeSplitIndex(songs)) : null;

  let totalMin = 0;
  let set1Min  = 0;

  const tagStarts = _groupByTagOn() ? tagGroupStarts(songs) : null;
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
    const heading = tagStarts && tagStarts.has(i)
      ? `<li class="tag-heading">${escHtml(songTags(song)[0] || t('setlist.untagged'))}</li>`
      : '';
    return `${heading}<li class="song-item" draggable="true" data-index="${i}">
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
        <button class="move-btn" data-onclick="moveSong(${i},-1)" ${isFirst ? 'disabled' : ''} aria-label="${t('setlist.moveUp')}">↑</button>
        <button class="move-btn" data-onclick="moveSong(${i},1)"  ${isLast  ? 'disabled' : ''} aria-label="${t('setlist.moveDown')}">↓</button>
        <button class="song-remove-btn" data-onclick="removeFromSet(${i})" title="${t('setlist.removeTitle')}">&#215;</button>
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
        <select id="add-song-select" data-onchange="addSongToSet(this)">
          <option value="">${t('setlist.addSongPlaceholder')}</option>
          ${options}
          ${artistSlug && getToken() ? `<option value="__new">${t('setlist.newSongOption')}</option>` : ''}
        </select>
      </div>
      <p class="total-time">${t('setlist.total', { duration: formatLength(totalMin) })}</p>
      <div class="result-actions">
        <button class="btn" data-onclick="onGenerate()" title="${t('setlist.regenTitle')}">${t('setlist.regenBtn')}</button>
        <button class="btn" data-onclick="onOptimize()" title="${t('setlist.optimizeTitle')}">${t('setlist.optimizeBtn')}</button>
        <button class="btn" data-onclick="printSetlist()">${t('setlist.exportPdfBtn')}</button>
        ${artistSlug ? `<button class="btn active" data-onclick="openAcceptModal()">${t('setlist.acceptBtn')}</button>` : ''}
      </div>
    </div>`;

  initDragAndDrop();
}

function removeFromSet(index) {
  currentSet.splice(index, 1);
  _splitAt = null;
  renderResult(currentSet);
}

function addSongToSet(select) {
  if (select.value === '__new') { select.value = ''; _openQuickSong(); return; }
  const songId = Number(select.value);
  if (!songId) return;
  const song = allSongs.find(s => s.id === songId);
  if (!song) return;
  currentSet.push(song);
  _splitAt = null;
  renderResult(currentSet);
}

// --- Quick new song: created in the band's catalogue, then added to the set ---

function _openQuickSong() {
  document.getElementById('quick-song-name').value   = '';
  document.getElementById('quick-song-key').innerHTML = _keyOptions('');
  document.getElementById('quick-song-length').value = '';
  document.getElementById('quick-song-error').className = 'status-msg';
  document.getElementById('quick-song-modal').classList.add('open');
  setTimeout(() => document.getElementById('quick-song-name').focus(), 50);
}

function _closeQuickSong() {
  document.getElementById('quick-song-modal').classList.remove('open');
}
registerModal('quick-song-modal', _closeQuickSong);

async function _saveQuickSong() {
  const nameEl = document.getElementById('quick-song-name');
  const title  = nameEl.value.trim();
  if (!title) { nameEl.focus(); return; }
  const lenEl  = document.getElementById('quick-song-length');
  const length = timeToMins(lenEl.value);
  if (lenEl.value.trim() && length === null) { lenEl.focus(); return; }

  const btn   = document.getElementById('quick-song-save');
  const errEl = document.getElementById('quick-song-error');
  btn.disabled = true;
  try {
    const r = await apiFetch(`/api/${artistSlug}/songs`, 'POST', {
      title:      title.charAt(0).toUpperCase() + title.slice(1),
      key:        document.getElementById('quick-song-key').value || null,
      length_min: length,
      active:     true,
    });
    if (!r.ok) throw new Error('create failed');
    const song = await r.json();
    invalidateConfigCache();
    allSongs.push(song);
    currentSet.push(song);
    _splitAt = null;
    _closeQuickSong();
    renderResult(currentSet);
  } catch {
    errEl.textContent = t('songs.saveFailed');
    errEl.className   = 'status-msg error';
  } finally {
    btn.disabled = false;
  }
}

// --- Optimize order ---

function onOptimize() {
  if (currentSet.length < 2) return;
  _applyFinalOrder(optimizeSetlist([...currentSet]));
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
    _splitAt = null;
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
    const focus = token ? 'setlist-title' : 'signin-btn';
    document.getElementById(focus)?.focus();
  }, 50);
}

function _closeAcceptModal() {
  document.getElementById('accept-modal').classList.remove('open');
  document.getElementById('auth-error').className = 'status-msg';
  document.getElementById('save-error').className = 'status-msg';
  document.getElementById('new-gig-form').classList.remove('open');
  document.getElementById('setlist-title').value = '';
  document.getElementById('setlist-comment').value = '';
}
registerModal('accept-modal', _closeAcceptModal);

// Sessions come from the login page; it brings the visitor back here.
document.getElementById('signin-btn').addEventListener('click', () => {
  window.location.assign(loginPageUrl());
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
  const r = await withBusy(document.getElementById('create-gig-btn'),
    () => apiFetch(`/api/${artistSlug}/gigs`, 'POST', { title: name, date }));
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

// --- PDF export ---

async function printSetlist() {
  var cfg = await loadConfig();
  printSetlistSongs(currentSet, '', cfg, { headings: _groupByTagOn() ? tagGroupStarts(currentSet) : null });
}
