// Setlist generator

let bandSlug = '';
let bandConfig = null;
let allSongs = [];
let currentSet = [];

// --- Init ---

async function init() {
  try {
    const cfg = await loadConfig();
    bandSlug   = cfg.slug;
    bandConfig = cfg.config ?? {};
    allSongs   = cfg.songs ?? [];
    applyNav(cfg.name, cfg.config);
    if (cfg.config?.logoUrl) {
      const printLogo = document.querySelector('#print-header .app-logo-img');
      if (printLogo) printLogo.src = cfg.config.logoUrl;
    }
    renderControls();
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

const activeFilters = new Map(); // field -> Set<value>

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

function refreshFilterOptions() {
  const base = getBaseSongs();
  const fields = (bandConfig.filterFields ?? []).filter(f => f.field !== 'tempo');
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
    container.innerHTML = sorted.map(v =>
      `<button class="filter-btn${currentActive.has(v) ? ' active' : ''}" data-field="${escHtml(f.field)}" data-value="${escHtml(v)}" onclick="toggleFilter(this)">${escHtml(v)}</button>`
    ).join('');
  }
}

function renderControls() {
  const fields = (bandConfig.filterFields ?? []).filter(f => f.field !== 'tempo');
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
        ${bandSlug ? `<button class="btn active" onclick="openAcceptModal()">Accept setlist</button>` : ''}
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
  const token = sessionStorage.getItem('setlist_token');
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
  const r = await fetch(`/api/${bandSlug}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (r.ok) {
    sessionStorage.setItem('setlist_token', pw);
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
    const r = await fetch(`/api/${bandSlug}/gigs`);
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
  const venue = document.getElementById('gig-venue').value.trim() || null;
  const token = sessionStorage.getItem('setlist_token');
  const r = await fetch(`/api/${bandSlug}/gigs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ name, date, venue }),
  });
  if (r.ok) {
    const gig = await r.json();
    const sel = document.getElementById('gig-select');
    const opt = document.createElement('option');
    opt.value = gig.id;
    opt.textContent = gig.name + (gig.date ? ' — ' + String(gig.date).slice(0, 10) : '');
    sel.appendChild(opt);
    sel.value = String(gig.id);
    document.getElementById('new-gig-form').classList.remove('open');
    ['gig-name', 'gig-date', 'gig-venue'].forEach(id => { document.getElementById(id).value = ''; });
  }
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const token   = sessionStorage.getItem('setlist_token');
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

  const r = await fetch(`/api/${bandSlug}/setlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ title: title || null, gig_id: gigId ? Number(gigId) : null, comment, song_ids: songIds }),
  });

  if (r.status === 401) {
    sessionStorage.removeItem('setlist_token');
    document.getElementById('save-step').style.display = 'none';
    document.getElementById('auth-step').style.display = 'block';
    const err = document.getElementById('auth-error');
    err.textContent = 'Session expired. Please re-enter your password.';
    err.className = 'status-msg error';
    return;
  }

  if (r.ok) {
    closeModal();
    const msg = document.createElement('div');
    msg.className = 'status-msg success';
    msg.style.display = 'block';
    msg.innerHTML = 'Setlist saved! <a href="/setlist-history">View history &rsaquo;</a>';
    const resultArea = document.getElementById('result-area');
    if (resultArea) resultArea.prepend(msg);
  } else {
    const err = document.getElementById('save-error');
    err.textContent = 'Failed to save. Please try again.';
    err.className = 'status-msg error';
  }
});

document.getElementById('accept-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

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

init();
