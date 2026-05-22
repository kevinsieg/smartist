// Setlist generator

var artistSlug = '';
var bandConfig = null;
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
    allSongs   = cfg.songs ?? [];
    applyNav(cfg.name, cfg.config);
    if (cfg.config?.logoUrl) {
      const printLogo = document.querySelector('#print-header .app-logo-img');
      if (printLogo) printLogo.src = cfg.config.logoUrl;
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

    if (_activeView === 'history') {
      document.getElementById('setlist-page-title').style.display = 'none';
      await _renderHistoryTab();
    } else {
      renderControls();
      applyDemoFilters();
    }
  } catch {
    document.getElementById('setlist-content').innerHTML =
      '<p style="text-align:center;color:var(--third-color);">Could not load songs.</p>';
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

function getFilteredSongs() {
  const activeOnly = document.getElementById('active-only')?.checked ?? true;
  const tempoSet = getTempoSet();
  return allSongs.filter(song => {
    if (activeOnly && !song.active) return false;
    for (const [field, values] of activeFilters) {
      if (values.size === 0) continue;
      const v = getFieldValue(song, field);
      if (!values.has(v)) return false;
    }
    if (tempoSet) {
      const t = (song.tempo || '').toLowerCase();
      if (t && !tempoSet.has(t)) return false;
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
  if (!targetMin || targetMin <= 0)
    return [...songs].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const shuffled = shuffleArray(songs);
  const set = [];
  let total = 0;
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

function onGenerate() {
  const filtered  = getFilteredSongs();
  const targetMin = parseFloat(document.getElementById('target-min')?.value) || 0;
  currentSet = generateSet(filtered, targetMin);
  currentSet = applyCapoOpts(currentSet);
  renderResult(currentSet);
  if (window.innerWidth < 640) toggleControls(true);
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

var EXCLUDED_FILTER_FIELDS = new Set(['tempo', 'interpret', 'reference_interpret', 'comment', 'length_min']);

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
      const label = f.field === 'length_min' ? formatLength(Number(v)) : v;
      return `<button class="filter-btn${currentActive.has(v) ? ' active' : ''}" data-field="${escHtml(f.field)}" data-value="${escHtml(v)}" onclick="toggleFilter(this)">${escHtml(label)}</button>`;
    }).join('');
  }
}

function renderControls() {
  const fields = (bandConfig.filterFields ?? []).filter(f => !EXCLUDED_FILTER_FIELDS.has(f.field));
  for (const f of fields) activeFilters.set(f.field, new Set());

  const filterRows = fields.map(f =>
    `<div class="filter-row">
      <span class="filter-label">${escHtml(f.label)}</span>
      <div class="filter-buttons" data-field="${escHtml(f.field)}"></div>
    </div>`
  ).join('');

  document.getElementById('setlist-content').innerHTML = `
    <div class="setlist-controls">
      <div class="controls-header">
        <button class="controls-toggle" id="controls-toggle" onclick="toggleControls()" aria-expanded="true">
          <span class="toggle-arrow">▲</span> Filters
        </button>
        <div class="duration-input">
          <label for="target-min">Min</label>
          <input type="number" id="target-min" min="0" max="300" value="45">
        </div>
        <button class="btn generate-btn" onclick="onGenerate()">Generate</button>
      </div>
      <hr class="controls-divider">
      <div id="controls-body">
        ${filterRows}
        <div class="filter-row">
          <span class="filter-label">Tempo</span>
          <div class="tempo-slider-wrap">
            <span class="tempo-label">Slow</span>
            <input type="range" id="tempo-slider" min="0" max="100" value="50" class="tempo-slider">
            <span class="tempo-label">Fast</span>
          </div>
        </div>
        <hr class="controls-divider">
        <div class="filter-row">
          <label class="active-toggle">
            <input type="checkbox" id="active-only" checked onchange="refreshFilterOptions()">
            Active songs only
          </label>
        </div>
        <div class="filter-row">
          <span class="active-toggle">
            Minimize capo changes
            <label class="active-toggle"><input type="checkbox" id="minimize-banjo-capo"> banjo</label>
            <label class="active-toggle"><input type="checkbox" id="minimize-git-capo"> guitar</label>
          </span>
        </div>
      </div>
    </div>
    <div id="result-area"></div>`;
  refreshFilterOptions();
}

function getTempoSet() {
  const v = Number(document.getElementById('tempo-slider')?.value ?? 50);
  if (v <= 15) return new Set(['slow']);
  if (v <= 35) return new Set(['slow', 'medium']);
  if (v <= 65) return null; // all tempos
  if (v <= 85) return new Set(['medium', 'fast']);
  return new Set(['fast']);
}

// --- Render result ---

function renderResult(songs) {
  const resultArea = document.getElementById('result-area');
  if (songs.length === 0) {
    resultArea.innerHTML = '<p style="color:var(--third-color);margin-top:1rem;">No songs match the current filters.</p>';
    return;
  }

  let totalMin = 0;

  const items = songs.map((song, i) => {
    totalMin += song.length_min || 4;
    const prev = i > 0 ? songs[i - 1] : null;

    const banjo = song.extra?.banjoCapo != null ? String(song.extra.banjoCapo) : null;
    const git   = song.extra?.gitCapo   != null ? String(song.extra.gitCapo)   : null;
    const prevBanjo = prev?.extra?.banjoCapo != null ? String(prev.extra.banjoCapo) : null;
    const prevGit   = prev?.extra?.gitCapo   != null ? String(prev.extra.gitCapo)   : null;
    const capoChanged = (banjo !== null && prevBanjo !== null && banjo !== prevBanjo)
                     || (git   !== null && prevGit   !== null && git   !== prevGit);
    const capoParts = [
      banjo !== null && banjo !== '0' ? `B&nbsp;${escHtml(banjo)}` : '',
      git   !== null && git   !== '0' ? `G&nbsp;${escHtml(git)}`   : '',
    ].filter(Boolean);
    const capoSpan = capoParts.length
      ? `<span class="capo-badge${capoChanged ? ' capo-change' : ''}" title="Capo position — Banjo and Guitar${capoChanged ? ' — changed from previous song' : ''}">Capo: ${capoParts.join(' | ')}</span>`
      : '';

    const s = (v, field, title) => v ? `<span data-field="${escHtml(field)}" title="${escHtml(title)}">${escHtml(v)}</span>` : '';
    const metaSpans = [
      s(song.extra?.lead || '',  'extra.lead',   'Lead vocalist / instrument'),
      s(song.key         || '',  'key',           'Key'),
      capoSpan,
      s(song.tempo       || '',  'tempo',         'Tempo'),
      s(song.genre       || '',  'genre',         'Genre'),
      song.extra?.harp ? s('harmonica', 'extra.harp', 'Harmonica needed') : '',
      song.extra?.git2 ? s('guitar 2',  'extra.git2', 'Second guitar') : '',
    ].filter(Boolean).join('');

    const printLabels = song.genre ? `<span>${escHtml(song.genre)}</span>` : '';

    const isFirst = i === 0, isLast = i === songs.length - 1;
    return `<li class="song-item" draggable="true" data-index="${i}">
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <span class="song-num">${i + 1}.</span>
      <div class="song-main">
        <div class="song-top">
          <span class="song-title">${escHtml(song.title)}</span>
          ${printLabels ? `<span class="print-labels">${printLabels}</span>` : ''}
          <span class="song-time">${formatLength(song.length_min)}</span>
        </div>
        ${metaSpans ? `<div class="song-meta">${metaSpans}</div>` : ''}
      </div>
      <div class="song-actions">
        <button class="move-btn" onclick="moveSong(${i},-1)" ${isFirst ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="move-btn" onclick="moveSong(${i},1)"  ${isLast  ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="song-remove-btn" onclick="removeFromSet(${i})" title="Remove">&#215;</button>
      </div>
    </li>`;
  }).join('');

  const inSetIds = new Set(songs.map(s => s.id));
  const available = allSongs
    .filter(s => s.active && !inSetIds.has(s.id))
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const options = available.map(s =>
    `<option value="${s.id}">${escHtml(s.title)}</option>`
  ).join('');

  resultArea.innerHTML = `
    <div class="setlist-result">
      <h2>${songs.length} songs &bull; ${formatLength(totalMin)}</h2>
      <ul class="song-list">${items}</ul>
      <div class="add-song-row">
        <select id="add-song-select" onchange="addSongToSet(this)">
          <option value="">+ add a song…</option>
          ${options}
        </select>
      </div>
      <p class="total-time">Total: ${formatLength(totalMin)}</p>
      <div class="result-actions">
        <button class="btn" onclick="onGenerate()" title="Pick a new random selection from the filtered songs">Re-generate</button>
        <button class="btn" onclick="onOptimize()" title="Reorder the current songs: slow opener → build-up → dip → climax → fast closer">Optimize order</button>
        <button class="btn" onclick="printSetlist()">Export PDF</button>
        ${artistSlug ? `<button class="btn active" onclick="openAcceptModal()">Accept setlist</button>` : ''}
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
  const tempoRank = { slow: 1, medium: 2, fast: 3 };
  const rank = s => tempoRank[(s.tempo || '').toLowerCase()] ?? 2;

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
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  document.getElementById('auth-step').style.display  = token ? 'none'  : 'block';
  document.getElementById('save-step').style.display  = token ? 'block' : 'none';
  if (token) loadGigs();
  document.getElementById('accept-modal').classList.add('open');
  setTimeout(() => {
    const focus = token ? 'setlist-title' : 'password-input';
    document.getElementById(focus)?.focus();
  }, 50);
}

function closeModal() {
  document.getElementById('accept-modal').classList.remove('open');
  document.getElementById('auth-error').className = 'status-msg';
  document.getElementById('save-error').className = 'status-msg';
  document.getElementById('new-gig-form').classList.remove('open');
  document.getElementById('password-input').value = '';
  document.getElementById('setlist-title').value = '';
  document.getElementById('setlist-comment').value = '';
}

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
    err.textContent = 'Wrong password.';
    err.className = 'status-msg error';
  }
});

document.getElementById('password-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('verify-btn').click();
});

async function loadGigs() {
  try {
    const r = await fetch(`/api/${artistSlug}/gigs`);
    if (!r.ok) return;
    const gigs = await r.json();
    const sel = document.getElementById('gig-select');
    while (sel.options.length > 1) sel.remove(1);
    for (const g of gigs) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name + (g.date ? ' — ' + String(g.date).slice(0, 10) : '');
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
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const r = await fetch(`/api/${artistSlug}/gigs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ title: name, date }),
  });
  if (r.ok) {
    const gig = await r.json();
    const sel = document.getElementById('gig-select');
    const opt = document.createElement('option');
    opt.value = gig.id;
    opt.textContent = gig.title + (gig.date ? ' — ' + String(gig.date).slice(0, 10) : '');
    sel.appendChild(opt);
    sel.value = String(gig.id);
    document.getElementById('new-gig-form').classList.remove('open');
    ['gig-name', 'gig-date'].forEach(id => { document.getElementById(id).value = ''; });
  }
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const token   = sessionStorage.getItem(AUTH_TOKEN_KEY);
  const title   = document.getElementById('setlist-title').value.trim();
  const gigId   = document.getElementById('gig-select').value || null;
  const comment = document.getElementById('setlist-comment').value.trim() || null;
  const songIds = currentSet.map(s => s.id).filter(id => Number.isInteger(id) && id > 0);

  if (!title) {
    const err = document.getElementById('save-error');
    err.textContent = 'Please enter a name for this setlist.';
    err.className = 'status-msg error';
    document.getElementById('setlist-title').focus();
    return;
  }

  if (songIds.length !== currentSet.length) {
    const err = document.getElementById('save-error');
    err.textContent = 'Cannot save — songs are missing IDs. Reload the page and try again.';
    err.className = 'status-msg error';
    return;
  }

  const r = await fetch(`/api/${artistSlug}/setlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ title: title || null, gig_id: gigId ? Number(gigId) : null, comment, song_ids: songIds }),
  });

  if (r.status === 401) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    document.getElementById('save-step').style.display = 'none';
    document.getElementById('auth-step').style.display = 'block';
    const err = document.getElementById('auth-error');
    err.textContent = 'Session expired. Please re-enter your password.';
    err.className = 'status-msg error';
    return;
  }

  if (r.ok) {
    const saved = await r.json();
    closeModal();
    _histLoaded = false;  // force fresh fetch so the new setlist appears
    _histPendingOpenId = String(saved.id);
    switchTab('history');
  } else {
    const err = document.getElementById('save-error');
    err.textContent = 'Failed to save. Please try again.';
    err.className = 'status-msg error';
  }
});

document.getElementById('accept-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

// --- Tab routing ---

function _updateTabBar() {
  document.querySelectorAll('.setlist-tab').forEach(function(t) {
    t.classList.toggle('setlist-tab--active', t.dataset.tab === _activeView);
  });
}

function switchTab(view) {
  _activeView = view;
  history.pushState(null, '', view === 'history' ? '/setlist?view=history' : '/setlist');
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
    : (s.gig_date ? String(s.gig_date).slice(0, 4) : '—');
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
        return fetch('/api/' + artistSlug + '/songs/' + s.id + '/setlists')
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
    ? '<div class="vsp-section-label">Gig</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:flex-start;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' +
          '<strong>' + escHtml(gig.title) + '</strong>' +
          (gig.date ? '<br><span style="color:var(--third-color);font-size:0.8rem">' + escHtml(String(gig.date).slice(0, 10)) + '</span>' : '') +
        '</div>' +
        '<button class="hist-nav-btn" onclick="navigate(\'/gigs?id=' + gig.id + '\')" title="Open in Gigs">&#8599;</button>' +
      '</div>'
    : '<div class="vsp-section-label">Gig</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="color:var(--third-color)">No gig linked</div></div>';

  var venueBlock = (gig && gig.venue_id)
    ? '<div class="vsp-section-label">Venue</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:center;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' +
          escHtml(gig.venue_name || '') +
          (gig.venue_city ? ', ' + escHtml(gig.venue_city) : '') +
        '</div>' +
        '<button class="hist-nav-btn" onclick="navigate(\'/venues?id=' + gig.venue_id + '\')" title="Open in Venues">&#8599;</button>' +
      '</div>'
    : '';

  var orgBlock = (gig && gig.organizer_id)
    ? '<div class="vsp-section-label">Organizer</div>' +
      '<div class="vsp-cell vsp-cell--full" style="display:flex;align-items:center;gap:0.5rem;">' +
        '<div class="vsp-cell-value" style="flex:1">' + escHtml(gig.organizer_name || '') + '</div>' +
        '<button class="hist-nav-btn" onclick="navigate(\'/organizers?id=' + gig.organizer_id + '\')" title="Open in Organizers">&#8599;</button>' +
      '</div>'
    : '';

  var commentBlock = s.comment
    ? '<div class="vsp-section-label">Comment</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="white-space:pre-wrap">' + escHtml(s.comment) + '</div></div>'
    : '';

  panelEl.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">' + escHtml(s.title || 'Untitled') + '</h2></div>' +
      '<button class="vsp-close" onclick="_histView && _histView.deselect()" aria-label="Close">&#215;</button>' +
    '</div>' +
    '<div class="vsp-actions" style="margin-bottom:1rem;">' +
      '<button class="btn icon-btn" data-tooltip="Edit setlist" onclick="_histEdit(\'' + sid + '\')">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 9.5-9.5z"/>' +
        '</svg>' +
      '</button>' +
      '<button class="btn icon-btn" data-tooltip="Duplicate" onclick="_histDuplicate(\'' + sid + '\')">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
          '<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>' +
        '</svg>' +
      '</button>' +
      '<button class="btn" onclick="_histStage(\'' + sid + '\')">Stage</button>' +
      '<button class="btn share-btn" onclick="_histShareMenu(\'' + sid + '\', this)">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px">' +
          '<path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>' +
          '<polyline points="16 6 12 2 8 6"/>' +
          '<line x1="12" y1="2" x2="12" y2="15"/>' +
        '</svg>Share' +
      '</button>' +
    '</div>' +
    gigBlock + venueBlock + orgBlock + commentBlock +
    '<div id="hist-song-detail"></div>';

  // Expand accordion body to show songs (lazy-loads if not yet fetched)
  var body = document.getElementById('hist-body-' + sid);
  if (body && body.hidden) {
    body.hidden = false;
    var toggle = document.querySelector('[data-id="' + sid + '"] .hist-toggle');
    if (toggle) toggle.innerHTML = '&#9660;';
    if (!_histLoadedSongs[sid]) body.innerHTML = '<p style="color:var(--third-color);font-size:0.82rem;padding:0.5rem 0.25rem">Loading songs…</p>';
  }
  _loadAndRenderHistSongs(sid);
}

async function _renderHistoryTab() {
  var content = document.getElementById('setlist-content');
  if (!content) return;
  content.innerHTML = '<p style="text-align:center;color:var(--third-color);">Loading…</p>';

  if (!_histLoaded) {
    try {
      var setsRes = await fetch('/api/' + artistSlug + '/setlists');
      var gigsRes = await fetch('/api/' + artistSlug + '/gigs?limit=500');
      _histSets = await setsRes.json();
      if (!Array.isArray(_histSets)) _histSets = [];
      var gigsData = await gigsRes.json();
      _histGigs = gigsData.rows || [];
      _histGigMap = {};
      _histGigs.forEach(function(g) { _histGigMap[g.id] = g; });
      _histLoaded = true;
    } catch {
      content.innerHTML = '<p style="text-align:center;color:var(--third-color);">Could not load history.</p>';
      return;
    }
  }

  _histView = createListView({
    container:  content,
    filters: [
      { id: 'setlist',   label: 'Setlist',   type: FILTER_TYPES.TEXT,       field: 'title' },
      { id: 'gig',       label: 'Gig',       type: FILTER_TYPES.TEXT,       field: 'gig.title' },
      { id: 'venue',     label: 'Venue',     type: FILTER_TYPES.TEXT,       field: 'gig.venue_name' },
      { id: 'organizer', label: 'Organizer', type: FILTER_TYPES.TEXT,       field: 'gig.organizer_name' },
      { id: 'song',      label: 'Song',      type: FILTER_TYPES.ASYNC_TEXT,
        resolve: _resolveHistSongFilter },
    ],
    getData:   _getVisibleSets,
    getTotal:  function() { return _histSets.length; },
    getItemId: function(s) { return s.id; },
    renderRow: _renderHistRow,
    groupBy:   _getSetYear,
    groupSort: function(a, b) { return b > a ? 1 : -1; },
    onOpen:    _openHistPanelContent,
  });

  var qp = new URLSearchParams(location.search);
  ['setlist', 'gig', 'venue', 'organizer', 'song'].forEach(function(k) {
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
  var countBadge = '<span class="hist-badge hist-badge--count">' + count + ' ' + (count !== 1 ? 'songs' : 'song') + '</span>';
  var dateBadge  = gigDate
    ? '<span class="hist-badge hist-badge--date">' + new Date(gigDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + '</span>'
    : '';

  var orgName = (gig && gig.organizer_name) || '';
  var headerLinks = [];
  if (gigName)   headerLinks.push(gig && gig.id
    ? '<span class="hist-meta-link" onclick="event.stopPropagation();navigate(\'/gigs?id=' + gig.id + '\')">' + escHtml(gigName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(gigName) + '</span>');
  if (venueName) headerLinks.push(gig && gig.venue_id
    ? '<span class="hist-meta-link" onclick="event.stopPropagation();navigate(\'/venues?id=' + gig.venue_id + '\')">' + escHtml(venueName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(venueName) + '</span>');
  if (orgName)   headerLinks.push(gig && gig.organizer_id
    ? '<span class="hist-meta-link" onclick="event.stopPropagation();navigate(\'/organizers?id=' + gig.organizer_id + '\')">' + escHtml(orgName) + ' &#8599;</span>'
    : '<span class="hist-meta-link" style="cursor:default">' + escHtml(orgName) + '</span>');

  var sid = String(s.id);
  return '<div class="hist-item" data-id="' + escHtml(sid) + '">' +
    '<div class="hist-item-header">' +
      '<div class="hist-item-main">' +
        '<div class="hist-item-titlerow">' +
          '<span class="hist-item-title">' + escHtml(s.title || 'Untitled') + '</span>' +
          '<div class="hist-item-badges">' + countBadge + dateBadge + '</div>' +
        '</div>' +
        (s.comment ? '<div class="hist-item-comment">' + escHtml(s.comment) + '</div>' : '') +
        (headerLinks.length ? '<div class="hist-meta-links hist-meta-links--header">' + headerLinks.join('') + '</div>' : '') +
      '</div>' +
      '<button class="hist-toggle" onclick="event.stopPropagation();_toggleHistItemBody(\'' + escHtml(sid) + '\')" title="Show songs">&#9654;</button>' +
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
    if (!_histLoadedSongs[sid]) body.innerHTML = '<p style="color:var(--third-color);font-size:0.82rem;padding:0.5rem 0.25rem">Loading songs…</p>';
    _loadAndRenderHistSongs(sid);
  } else {
    body.hidden = true;
    if (toggle) toggle.innerHTML = '&#9654;';
  }
}

async function _loadAndRenderHistSongs(sid) {
  sid = String(sid);
  var body = document.getElementById('hist-body-' + sid);
  if (!body) return;

  if (!_histLoadedSongs[sid]) {
    try {
      var detail = await fetch('/api/' + artistSlug + '/setlists/' + sid).then(function(r) { return r.json(); });
      var songs = Array.isArray(detail) ? detail : (detail.songs || []);
      songs = songs.slice().sort(function(a, b) { return (a.position || 0) - (b.position || 0); });
      _histLoadedSongs[sid] = songs;
    } catch {
      _histLoadedSongs[sid] = [];
    }
  }

  // If row was removed while loading, accordion body may no longer exist
  body = document.getElementById('hist-body-' + sid);
  if (!body) return;

  var loaded = _histLoadedSongs[sid];
  if (!loaded || !loaded.length) {
    body.innerHTML = '<p style="color:var(--third-color);font-size:0.82rem;padding:0.5rem 0.25rem">No songs.</p>';
    return;
  }

  var total = 0;
  var rows = loaded.map(function(song, i) {
    total += song.length_min || 0;
    return '<div class="hist-song-row" data-song-id="' + song.id + '" onclick="_openSongPanel(\'' + sid + '\',' + song.id + ')">' +
      '<span class="hist-song-pos">' + (i + 1) + '.</span>' +
      '<span class="hist-song-name">' + escHtml(song.title || '') + '</span>' +
      (song.key ? '<span class="hist-song-key">' + escHtml(song.key) + '</span>' : '') +
      '<span class="hist-song-len">' + formatLength(song.length_min) + '</span>' +
    '</div>';
  }).join('');

  body.innerHTML = rows + '<div class="hist-songs-total">Total: ' + formatLength(total) + '</div>';
}

function _histCancelEdit(sid) {
  if (_histView) _histView.select(String(sid));
}

function _histEdit(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var inner = document.getElementById('view-side-panel-inner');
  if (!inner) return;

  var gigOptions = '<option value="">— no gig —</option>' +
    _histGigs.map(function(g) {
      var sel = String(g.id) === String(s.gig_id) ? ' selected' : '';
      var label = escHtml(g.title || '') + (g.date ? ' — ' + String(g.date).slice(0, 10) : '');
      return '<option value="' + g.id + '"' + sel + '>' + label + '</option>';
    }).join('');

  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">Edit Setlist</h2></div>' +
      '<button class="vsp-close" onclick="_histCancelEdit(\'' + sid + '\')" aria-label="Cancel">×</button>' +
    '</div>' +
    '<div style="padding:0 1rem;">' +
      '<div class="modal-field">' +
        '<label for="hist-edit-title">Name</label>' +
        '<input type="text" id="hist-edit-title" value="' + escHtml(s.title || '') + '" autocomplete="off">' +
      '</div>' +
      '<div class="modal-field">' +
        '<label for="hist-edit-gig">Gig (optional)</label>' +
        '<select id="hist-edit-gig">' + gigOptions + '</select>' +
      '</div>' +
      '<div class="modal-field">' +
        '<label for="hist-edit-comment">Comment (optional)</label>' +
        '<textarea id="hist-edit-comment" placeholder="Notes…">' + escHtml(s.comment || '') + '</textarea>' +
      '</div>' +
      '<div class="status-msg" id="hist-edit-error"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn active" id="hist-edit-save" onclick="_saveHistEdit(\'' + sid + '\')">Save</button>' +
        '<button class="btn" onclick="_histCancelEdit(\'' + sid + '\')">Cancel</button>' +
      '</div>' +
    '</div>';

  document.getElementById('hist-edit-title').focus();
}

async function _saveHistEdit(sid) {
  sid = String(sid);
  var s = _histSets.find(function(x) { return String(x.id) === sid; });
  if (!s) return;

  var titleVal = (document.getElementById('hist-edit-title').value || '').trim();
  var gigId    = document.getElementById('hist-edit-gig').value || null;
  var comment  = (document.getElementById('hist-edit-comment').value || '').trim() || null;
  var token    = sessionStorage.getItem(AUTH_TOKEN_KEY);

  if (!titleVal) {
    var errEl = document.getElementById('hist-edit-error');
    if (errEl) { errEl.textContent = 'Name is required.'; errEl.className = 'status-msg error'; }
    document.getElementById('hist-edit-title').focus();
    return;
  }

  var saveBtn = document.getElementById('hist-edit-save');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  // Get song IDs — use cached songs if already loaded, else fetch
  var songs = _histLoadedSongs[sid];
  var songIds;
  if (songs) {
    songIds = songs.map(function(song) { return song.id; });
  } else {
    try {
      var detail = await fetch('/api/' + artistSlug + '/setlists/' + sid).then(function(r) { return r.json(); });
      songs = Array.isArray(detail) ? detail : (detail.songs || []);
      songs = songs.slice().sort(function(a, b) { return (a.position || 0) - (b.position || 0); });
      _histLoadedSongs[sid] = songs;
      songIds = songs.map(function(song) { return song.id; });
    } catch {
      var errEl2 = document.getElementById('hist-edit-error');
      if (errEl2) { errEl2.textContent = 'Could not load songs. Please try again.'; errEl2.className = 'status-msg error'; }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      return;
    }
  }

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists/' + sid, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ title: titleVal, gig_id: gigId ? Number(gigId) : null, comment: comment, song_ids: songIds })
    });

    if (r.status === 401) {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      var errEl3 = document.getElementById('hist-edit-error');
      if (errEl3) { errEl3.textContent = 'Session expired. Please refresh and log in again.'; errEl3.className = 'status-msg error'; }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      return;
    }

    if (!r.ok) {
      var errEl4 = document.getElementById('hist-edit-error');
      if (errEl4) { errEl4.textContent = 'Failed to save. Please try again.'; errEl4.className = 'status-msg error'; }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      return;
    }

    // Update in-memory cache
    s.title   = titleVal;
    s.gig_id  = gigId ? Number(gigId) : null;
    s.comment = comment;
    var updGig   = s.gig_id ? _histGigMap[s.gig_id] : null;
    s.gig_name  = updGig ? (updGig.title      || '') : null;
    s.gig_date  = updGig ? (updGig.date        || '') : null;
    s.gig_venue = updGig ? (updGig.venue_name  || '') : null;
    // Bust song cache so reopening panel reloads fresh
    delete _histLoadedSongs[sid];

    if (_histView) {
      _histView.refresh();
      _histView.select(sid);
    }
  } catch {
    var errEl5 = document.getElementById('hist-edit-error');
    if (errEl5) { errEl5.textContent = 'Network error. Please try again.'; errEl5.className = 'status-msg error'; }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

function _closeSongPanel() {
  document.querySelectorAll('.hist-song-row--active').forEach(function(el) {
    el.classList.remove('hist-song-row--active');
  });
  var detail = document.getElementById('hist-song-detail');
  if (detail) detail.innerHTML = '';
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

  // If panel not open yet, open setlist panel first (synchronously sets up #hist-song-detail)
  var panel = document.getElementById('view-side-panel');
  if (!panel || !panel.classList.contains('open')) {
    if (_histView) _histView.select(setlistSid);
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

  var defaultFields = ['key', 'genre', 'tempo', 'length_min', 'extra.lead', 'extra.banjoCapo', 'extra.gitCapo'];
  var shownFields = displayFields.length ? displayFields.map(function(f) { return f.field; }) : defaultFields;
  if (shownFields.indexOf('length_min') === -1) shownFields = shownFields.concat(['length_min']);

  var cells = shownFields.map(function(field) {
    var val = cellVal(field);
    if (val === null || val === undefined || val === '') return '';
    var label = fieldMap[field] || field.replace('extra.', '').replace(/_/g, ' ');
    var display = field === 'length_min' ? formatLength(val) : escHtml(String(val));
    return '<div class="vsp-cell">' +
      '<div class="vsp-cell-label">' + escHtml(label) + '</div>' +
      '<div class="vsp-cell-value">' + display + '</div>' +
    '</div>';
  }).filter(Boolean).join('');

  var commentBlock = song.comment
    ? '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="white-space:pre-wrap;color:var(--third-color);font-size:0.82rem">' + escHtml(song.comment) + '</div></div>'
    : '';

  var lyricsBlock = (song.extra && song.extra.lyrics)
    ? '<div class="vsp-section-label">Lyrics</div>' +
      '<div class="vsp-cell vsp-cell--full"><div class="vsp-cell-value" style="white-space:pre-wrap;font-size:0.8rem;max-height:12rem;overflow-y:auto">' + escHtml(song.extra.lyrics) + '</div></div>'
    : '';

  detail.innerHTML =
    '<hr style="margin:1rem 0;border:none;border-top:1px solid var(--border-color)">' +
    '<div class="vsp-section-label" style="display:flex;align-items:center;justify-content:space-between;">' +
      escHtml(song.title || '') +
      '<button class="hist-nav-btn" onclick="_closeSongPanel()" style="font-size:0.78rem">&#215;</button>' +
    '</div>' +
    (cells || '') +
    commentBlock + lyricsBlock +
    '<div class="vsp-actions" style="margin-top:0.75rem;">' +
      '<button class="btn" onclick="navigate(\'/songs?id=' + song.id + '\')">Open in Songs &#8599;</button>' +
    '</div>';

  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _histStage(sid) {
  window.open('/stage?id=' + sid, '_blank');
}

function _histExportPdf(sid) {
  window.open('/stage?id=' + sid + '&print=1', '_blank');
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
    '<div class="share-menu-item" onclick="_histExportPdf(\'' + sid + '\');var m=document.getElementById(\'share-menu-popup\');if(m)m.remove()">' +
      '<span class="share-menu-icon">⎙</span><span class="share-menu-label">Export PDF</span>' +
    '</div>' +
    '<div class="share-menu-item" onclick="_histCopyLink(\'' + sid + '\')">' +
      '<span class="share-menu-icon">⧉</span><span class="share-menu-label">Copy link</span>' +
    '</div>' +
    '<div class="share-menu-item" onclick="var m=document.getElementById(\'share-menu-popup\');if(m)m.remove();_histShare(\'' + sid + '\')">' +
      '<span class="share-menu-icon">✉</span><span class="share-menu-label">Share via email</span>' +
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
  var url = location.origin + '/stage?id=' + sid;
  var menu = document.getElementById('share-menu-popup');
  var item = menu && menu.querySelectorAll('.share-menu-item')[1];
  if (item) item.innerHTML = '<span class="share-menu-icon">✓</span><span class="share-menu-label">Copied!</span>';
  navigator.clipboard.writeText(url).catch(function() {
    if (item) item.innerHTML = '<span class="share-menu-icon">⧉</span><span class="share-menu-label">Copy link</span>';
  });
  setTimeout(function() { if (menu && menu.parentNode) menu.remove(); }, 900);
}

function _histShare(sid) {
  sid = String(sid);
  var inner = document.getElementById('view-side-panel-inner');
  if (!inner) return;
  var hasToken = !!sessionStorage.getItem(AUTH_TOKEN_KEY);

  inner.innerHTML =
    '<div class="vsp-header">' +
      '<div class="vsp-header-text"><h2 class="vsp-title">Share Setlist</h2></div>' +
      '<button class="vsp-close" onclick="_histCancelEdit(\'' + sid + '\')" aria-label="Cancel">×</button>' +
    '</div>' +
    '<p style="padding:0 1rem;font-size:0.84rem;color:var(--third-color);">Send a PDF of this setlist by email.</p>' +
    '<div style="padding:0 1rem;">' +
      (!hasToken
        ? '<div class="modal-field"><label for="hist-share-pw">Password</label>' +
          '<input type="password" id="hist-share-pw" autocomplete="current-password" placeholder="Band password"></div>'
        : '') +
      '<div class="modal-field"><label for="hist-share-email">Email</label>' +
        '<input type="email" id="hist-share-email" placeholder="recipient@example.com"></div>' +
      '<div class="status-msg" id="hist-share-status"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn active" id="hist-share-send" onclick="_histShareSend(\'' + sid + '\')">Send PDF</button>' +
        '<button class="btn" onclick="_histCancelEdit(\'' + sid + '\')">Cancel</button>' +
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
    if (st) { st.textContent = 'Please enter an email address.'; st.className = 'status-msg error'; }
    document.getElementById('hist-share-email').focus();
    return;
  }

  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  var pwEl = document.getElementById('hist-share-pw');
  if (pwEl && pwEl.value.trim()) token = pwEl.value.trim();

  if (!token) {
    if (st) { st.textContent = 'Password required.'; st.className = 'status-msg error'; }
    if (pwEl) pwEl.focus();
    return;
  }

  var btn = document.getElementById('hist-share-send');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  if (st) { st.textContent = ''; st.className = 'status-msg'; }

  try {
    var r = await fetch('/api/' + artistSlug + '/setlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ share_id: Number(sid), email: email })
    });

    if (r.status === 401) {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      if (st) { st.textContent = 'Wrong password.'; st.className = 'status-msg error'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Send PDF'; }
      return;
    }

    if (r.ok) {
      sessionStorage.setItem(AUTH_TOKEN_KEY, token);
      if (st) { st.textContent = 'Sent to ' + escHtml(email); st.className = 'status-msg success'; st.style.display = 'block'; }
      if (btn) btn.disabled = true;
      setTimeout(function() { _histCancelEdit(sid); }, 1800);
    } else {
      var errData = await r.json().catch(function() { return {}; });
      if (st) { st.textContent = errData.error || 'Failed to send.'; st.className = 'status-msg error'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Send PDF'; }
    }
  } catch {
    if (st) { st.textContent = 'Network error. Please try again.'; st.className = 'status-msg error'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Send PDF'; }
  }
}

async function _histDuplicate(sid) {
  sid = String(sid);
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);

  var dupBtn = document.querySelector('.vsp-actions button[onclick*="_histDuplicate"]');

  if (!token) {
    if (dupBtn) {
      dupBtn.insertAdjacentHTML('afterend', '<span id="dup-status" style="font-size:0.78rem;color:var(--third-color);display:block;margin-top:0.4rem;">Log in first to duplicate.</span>');
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
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = 'Duplicate'; }
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
      if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = 'Duplicate'; }
    }
  } catch {
    if (dupBtn) { dupBtn.disabled = false; dupBtn.textContent = 'Duplicate'; }
  }
}

// --- PDF export ---

function printSetlist() {
  const now = new Date();
  const date = now.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('print-timestamp').textContent = `${date} — ${time}`;

  const size = calcPrintFontSize(currentSet.length);
  document.documentElement.style.setProperty('--print-song-size', size + 'pt');

  setTimeout(() => {
    window.print();
    setTimeout(() => document.documentElement.style.removeProperty('--print-song-size'), 500);
  }, 50);
}

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  _closeSongPanel();
  if (_histView) _histView.deselect();
});

init();
