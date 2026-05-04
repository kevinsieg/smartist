// History page — setlists + gigs browser

let bandSlug    = '';
let allSongs    = [];
let allSetlists = [];
let allGigs     = [];

let currentView    = 'setlists';
let filterName     = '';
let filterSong     = '';
let filterDateFrom = '';
let filterDateTo   = '';
let songFilterIds  = null; // null = no filter; Set<id> = matching setlist IDs
let songTimer      = null;

const loadedSets = new Set();
const loadedData = new Map(); // setlist id → { meta + songs }
const loadedGigs = new Map(); // gig id → gig object (shared with edit modal)

window.onNavAuthEmpty = function(el) {
  el.innerHTML = '<button class="nav-auth-login" onclick="openHistoryLogin()">login to edit</button>';
};

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  try {
    const cfg = await loadConfig();
    bandSlug = cfg.slug;
    allSongs = cfg.songs ?? [];
    applyNav(cfg.name, cfg.config);
    if (cfg.config?.logoUrl) {
      const printLogo = document.querySelector('#print-header .app-logo-img');
      if (printLogo) printLogo.src = cfg.config.logoUrl;
    }
    const [setlists, gigs] = await Promise.all([
      fetch(`/api/${bandSlug}/setlists`).then(r => r.json()),
      fetch(`/api/${bandSlug}/gigs`).then(r => r.json()),
    ]);
    allSetlists = setlists;
    allGigs     = gigs;
    for (const g of gigs) loadedGigs.set(g.id, g);
    applyFilters();
    await expandFromHash();
  } catch {
    document.getElementById('history-content').innerHTML =
      '<p style="text-align:center;color:var(--third-color);">Could not load history.</p>';
  }
}

// ── View switching ────────────────────────────────────────────────────────

function setView(view) {
  currentView = view;
  document.getElementById('subnav-setlists').classList.toggle('active', view === 'setlists');
  document.getElementById('subnav-gigs').classList.toggle('active', view === 'gigs');
  // Song filter only applies to setlists
  document.getElementById('filter-song').hidden = view === 'gigs';
  if (view === 'gigs') {
    filterSong = '';
    document.getElementById('filter-song').value = '';
    songFilterIds = null;
    clearTimeout(songTimer);
  }
  updateClearBtn();
  applyFilters();
}

// ── Filters ───────────────────────────────────────────────────────────────

function onFilterInput() {
  filterName     = document.getElementById('filter-name').value.trim();
  filterDateFrom = document.getElementById('filter-date-from').value;
  filterDateTo   = document.getElementById('filter-date-to').value;
  updateClearBtn();
  applyFilters();
}

function onSongInput(value) {
  clearTimeout(songTimer);
  filterSong = value.trim();
  updateClearBtn();
  if (!filterSong) { songFilterIds = null; applyFilters(); return; }
  songTimer = setTimeout(() => runSongFilter(filterSong), 400);
}

async function runSongFilter(query) {
  const q       = query.toLowerCase();
  const matches = allSongs.filter(s => s.title.toLowerCase().includes(q));
  if (!matches.length) { songFilterIds = new Set(); applyFilters(); return; }
  const results = await Promise.all(
    matches.map(s =>
      fetch(`/api/${bandSlug}/songs/${s.id}/setlists`)
        .then(r => r.ok ? r.json() : [])
        .then(rows => rows.map(r => r.id))
        .catch(() => [])
    )
  );
  songFilterIds = new Set(results.flat());
  applyFilters();
}

function updateClearBtn() {
  const active = filterName || filterSong || filterDateFrom || filterDateTo;
  document.getElementById('filter-clear-btn').style.display = active ? '' : 'none';
}

function clearFilters() {
  filterName = filterSong = filterDateFrom = filterDateTo = '';
  songFilterIds = null;
  clearTimeout(songTimer);
  ['filter-name','filter-song','filter-date-from','filter-date-to'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('filter-clear-btn').style.display = 'none';
  applyFilters();
}

function applyFilters() {
  if (currentView === 'setlists') renderSetlistsView();
  else renderGigsView();
}

// ── Setlists view ─────────────────────────────────────────────────────────

function filteredSetlists() {
  return allSetlists.filter(s => {
    if (filterName) {
      const q = filterName.toLowerCase();
      if (!(s.title || '').toLowerCase().includes(q) &&
          !(s.gig_name || '').toLowerCase().includes(q)) return false;
    }
    const date = s.gig_date ? String(s.gig_date).slice(0, 10) : String(s.created_at).slice(0, 10);
    if (filterDateFrom && date < filterDateFrom) return false;
    if (filterDateTo   && date > filterDateTo)   return false;
    if (songFilterIds !== null && !songFilterIds.has(s.id)) return false;
    return true;
  });
}

function renderSetlistsView() {
  const container = document.getElementById('history-content');
  const sets = filteredSetlists();

  if (!sets.length) {
    const hasFilter = filterName || filterSong || filterDateFrom || filterDateTo;
    container.innerHTML = `<p style="text-align:center;color:var(--third-color);">${
      hasFilter ? 'No setlists match the current filters.' : 'No setlists saved yet.'
    }</p>`;
    return;
  }

  const currentYear = new Date().getFullYear();
  const byYear = new Map();
  for (const s of sets) {
    const year = new Date(s.created_at).getFullYear();
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(s);
  }

  const years = [...byYear.keys()].sort((a, b) => b - a);
  container.innerHTML = years.map(year => {
    const isCurrentYear = year === currentYear;
    const items = byYear.get(year).map(s => `
      <div class="history-item" id="set-${s.id}">
        <div class="history-header" onclick="toggleSet(${s.id})">
          <div class="history-meta">${renderSetlistMeta(s)}</div>
          <button class="toggle-btn" aria-label="Toggle setlist" aria-expanded="false">&#9660;</button>
        </div>
        <div class="history-songs" id="songs-${s.id}" hidden>
          <p style="color:var(--third-color);font-size:0.82rem;padding:0.25rem 0;">Loading…</p>
        </div>
      </div>`).join('');
    return `<div class="year-section">
      <div class="year-header" onclick="toggleYear(${year})" aria-expanded="${isCurrentYear}">
        <span class="year-label">${year}</span>
        <span class="year-count">${byYear.get(year).length} set${byYear.get(year).length !== 1 ? 's' : ''}</span>
        <span class="year-arrow">${isCurrentYear ? '▲' : '▼'}</span>
      </div>
      <div class="year-body" id="year-${year}" ${isCurrentYear ? '' : 'hidden'}>
        ${items}
      </div>
    </div>`;
  }).join('');
}

// ── Gigs view ─────────────────────────────────────────────────────────────

function filteredGigs() {
  return allGigs.filter(g => {
    if (filterName) {
      if (!(g.name || '').toLowerCase().includes(filterName.toLowerCase())) return false;
    }
    const date = g.date ? String(g.date).slice(0, 10) : '';
    if (filterDateFrom && (!date || date < filterDateFrom)) return false;
    if (filterDateTo   && (!date || date > filterDateTo))   return false;
    return true;
  });
}

function renderGigsView() {
  const container = document.getElementById('history-content');
  const gigs = filteredGigs();

  if (!gigs.length) {
    const hasFilter = filterName || filterDateFrom || filterDateTo;
    container.innerHTML = `<p style="text-align:center;color:var(--third-color);">${
      hasFilter ? 'No gigs match the current filters.' : 'No gigs saved yet.'
    }</p>`;
    return;
  }

  const sorted = [...gigs].sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return String(b.date).localeCompare(String(a.date));
  });

  const byYear = new Map();
  for (const g of sorted) {
    const year = g.date ? new Date(g.date).getFullYear() : 0;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(g);
  }

  const currentYear = new Date().getFullYear();
  const years = [...byYear.keys()].sort((a, b) => b - a);

  container.innerHTML = years.map(year => {
    const label = year === 0 ? 'TBD' : year;
    const isCurrentYear = year === currentYear;
    const items = byYear.get(year).map(g => {
      const linkedSets = allSetlists.filter(s => s.gig_id === g.id);
      const setCount   = linkedSets.length;
      const dateStr    = g.date ? String(g.date).slice(0, 10) : 'Date TBD';
      const venuePart  = g.venue ? ` — ${escHtml(g.venue)}` : '';
      return `
        <div class="history-item" id="gig-${g.id}">
          <div class="history-header" onclick="toggleGig(${g.id})">
            <div class="history-meta">
              <span class="gig-name">${escHtml(g.name)}</span>
              <span class="set-info">${dateStr}${venuePart} &bull; ${setCount} setlist${setCount !== 1 ? 's' : ''}</span>
              ${g.notes ? `<span class="set-comment">${escHtml(g.notes)}</span>` : ''}
            </div>
            <button class="toggle-btn" aria-label="Toggle gig" aria-expanded="false">&#9660;</button>
          </div>
          <div class="history-songs" id="gig-body-${g.id}" hidden>
            ${renderGigSetlists(linkedSets)}
          </div>
        </div>`;
    }).join('');

    return `<div class="year-section">
      <div class="year-header" onclick="toggleYear('gy${year}')" aria-expanded="${isCurrentYear}">
        <span class="year-label">${label}</span>
        <span class="year-count">${byYear.get(year).length} gig${byYear.get(year).length !== 1 ? 's' : ''}</span>
        <span class="year-arrow">${isCurrentYear ? '▲' : '▼'}</span>
      </div>
      <div class="year-body" id="year-gy${year}" ${isCurrentYear ? '' : 'hidden'}>
        ${items}
      </div>
    </div>`;
  }).join('');
}

function renderGigSetlists(linkedSets) {
  if (!linkedSets.length) {
    return '<p style="color:var(--third-color);font-size:0.82rem;padding:0.5rem 0;">No setlists linked to this gig.</p>';
  }
  return `<div class="gig-setlist-list">${linkedSets.map(s => `
    <div class="gig-setlist-item" id="set-${s.id}">
      <div class="history-header" onclick="toggleSet(${s.id})">
        <div class="history-meta">${renderSetlistMeta(s)}</div>
        <button class="toggle-btn" aria-label="Toggle setlist" aria-expanded="false">&#9660;</button>
      </div>
      <div class="history-songs" id="songs-${s.id}" hidden>
        <p style="color:var(--third-color);font-size:0.82rem;padding:0.25rem 0;">Loading…</p>
      </div>
    </div>`).join('')}</div>`;
}

function toggleGig(id) {
  const body = document.getElementById(`gig-body-${id}`);
  const btn  = document.querySelector(`#gig-${id} > .history-header .toggle-btn`);
  if (!body) return;
  const open = !body.hidden;
  body.hidden = open;
  if (btn) { btn.innerHTML = open ? '&#9660;' : '&#9650;'; btn.setAttribute('aria-expanded', String(!open)); }
}

// ── Shared rendering helpers ──────────────────────────────────────────────

function formatSavedDate(createdAt) {
  return new Date(createdAt).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function renderSetlistMeta(s) {
  const gigParts = [];
  if (s.gig_name)  gigParts.push(escHtml(s.gig_name));
  if (s.gig_date)  gigParts.push(String(s.gig_date).slice(0, 10));
  if (s.gig_venue) gigParts.push(escHtml(s.gig_venue));
  const gigLine = gigParts.length ? `<span class="gig-name">${gigParts.join(' — ')}</span>` : '';
  const count   = s.song_count ?? 0;
  return `${gigLine}
    ${s.title   ? `<span class="set-title">&ldquo;${escHtml(s.title)}&rdquo;</span>` : ''}
    <span class="set-info">${count} song${count !== 1 ? 's' : ''} &bull; saved ${formatSavedDate(s.created_at)}</span>
    ${s.comment ? `<span class="set-comment">${escHtml(s.comment)}</span>` : ''}`;
}

function renderSongRow(song, i) {
  return `<div class="song-row">
    <span class="song-pos">${i + 1}.</span>
    <span class="song-name">${escHtml(song.title)}</span>
    ${song.key ? `<span class="song-key">${escHtml(song.key)}</span>` : ''}
    <span class="song-len">${formatLength(song.length_min)}</span>
  </div>`;
}

// ── Toggle helpers ────────────────────────────────────────────────────────

function toggleYear(year) {
  const body   = document.getElementById(`year-${year}`);
  const header = body?.previousElementSibling;
  if (!body) return;
  const open = !body.hidden;
  body.hidden = open;
  if (header) {
    header.setAttribute('aria-expanded', String(!open));
    const arrow = header.querySelector('.year-arrow');
    if (arrow) arrow.textContent = open ? '▼' : '▲';
  }
}

async function toggleSet(id) {
  const songsEl = document.getElementById(`songs-${id}`);
  const btn     = document.querySelector(`#set-${id} > .history-header .toggle-btn,
                                          #set-${id} .history-header .toggle-btn`);
  if (!songsEl) return;

  if (!songsEl.hidden) {
    songsEl.hidden = true;
    if (btn) { btn.innerHTML = '&#9660;'; btn.setAttribute('aria-expanded', 'false'); }
    return;
  }

  songsEl.hidden = false;
  if (btn) { btn.innerHTML = '&#9650;'; btn.setAttribute('aria-expanded', 'true'); }

  // Render from cache if available
  if (loadedData.has(id)) {
    renderSetlistSongs(id, loadedData.get(id), songsEl);
    return;
  }
  if (loadedSets.has(id)) return; // fetch already in flight
  loadedSets.add(id);

  try {
    const r = await fetch(`/api/${bandSlug}/setlists/${id}`);
    if (!r.ok) throw new Error(`${r.status}`);
    const data = await r.json();
    loadedData.set(id, data);
    renderSetlistSongs(id, data, songsEl);
  } catch {
    loadedSets.delete(id);
    songsEl.innerHTML = '<p style="color:var(--third-color);font-size:0.82rem;padding:0.25rem 0;">Failed to load. Click to retry.</p>';
  }
}

function renderSetlistSongs(id, data, songsEl) {
  if (!data.songs?.length) {
    songsEl.innerHTML = '<p style="color:var(--third-color);font-size:0.82rem;padding:0.25rem 0;">No songs.</p>';
    return;
  }
  const rows  = data.songs.map(renderSongRow).join('');
  const total = data.songs.reduce((acc, s) => acc + (s.length_min || 0), 0);
  songsEl.innerHTML = `
    <div>${rows}</div>
    <div class="songs-total">Total: ${formatLength(total)}</div>
    <div class="history-actions" id="actions-${id}">${renderActionBtns(id)}</div>`;
}

async function expandFromHash() {
  const match = window.location.hash.match(/^#set-(\d+)$/);
  if (!match) return;
  const id = Number(match[1]);
  const el = document.getElementById(`set-${id}`);
  if (!el) return;

  const yearBody = el.closest('[id^="year-"]');
  if (yearBody?.hidden) {
    yearBody.hidden = false;
    const yearHeader = yearBody.previousElementSibling;
    if (yearHeader) {
      yearHeader.setAttribute('aria-expanded', 'true');
      const arrow = yearHeader.querySelector('.year-arrow');
      if (arrow) arrow.textContent = '▲';
    }
  }

  await toggleSet(id);
  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

// ── History page login ────────────────────────────────────────────────────

function openHistoryLogin() {
  document.getElementById('history-login-pw').value = '';
  const st = document.getElementById('history-login-status');
  st.className = 'status-msg'; st.textContent = '';
  document.getElementById('history-login-modal').classList.add('open');
  setTimeout(() => document.getElementById('history-login-pw').focus(), 50);
}

function closeHistoryLogin() {
  document.getElementById('history-login-modal').classList.remove('open');
}

async function doHistoryLogin() {
  const pw = document.getElementById('history-login-pw').value.trim();
  const st = document.getElementById('history-login-status');
  if (!pw) return;
  const r = await fetch(`/api/${bandSlug}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (r.ok) {
    sessionStorage.setItem('setlist_token', pw);
    refreshAllActionBtns();
    closeHistoryLogin();
  } else {
    st.textContent = 'Wrong password.';
    st.className = 'status-msg error';
  }
}

document.getElementById('history-login-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeHistoryLogin();
});
document.getElementById('history-login-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') doHistoryLogin();
});

// ── Action buttons (auth-aware) ───────────────────────────────────────────

function renderActionBtns(id) {
  const authed = !!sessionStorage.getItem('setlist_token');
  return (authed
    ? `<button class="btn history-export-btn" onclick="openEditModal(${id})">Edit</button>`
    : '')
    + `<button class="btn history-export-btn" onclick="printHistorySetlist(${id})">Export PDF</button>`
    + `<button class="btn history-export-btn" onclick="openStageView(${id})">Stage</button>`
    + (authed
    ? `<button class="btn history-export-btn" onclick="openShareModal(${id})">Share</button>`
      + `<button class="btn history-export-btn" id="dup-btn-${id}" onclick="doDuplicate(${id})">Duplicate</button>`
    : '');
}

function refreshAllActionBtns() {
  for (const id of loadedSets) {
    const el = document.getElementById(`actions-${id}`);
    if (el) el.innerHTML = renderActionBtns(id);
  }
  updateAuthIndicator();
}

// ── Edit modal ────────────────────────────────────────────────────────────

let editTargetId = null;
let editSongs    = [];

async function openEditModal(id) {
  editTargetId = id;
  editSongs = [];

  const st = document.getElementById('edit-status');
  st.className = 'status-msg'; st.textContent = '';
  document.getElementById('edit-save-btn').disabled = false;

  const hasToken = !!sessionStorage.getItem('setlist_token');
  document.getElementById('edit-auth-field').style.display = hasToken ? 'none' : '';
  document.getElementById('edit-password').value = '';

  let data = loadedData.get(id);
  if (!data) {
    const r = await fetch(`/api/${bandSlug}/setlists/${id}`);
    if (!r.ok) { closeEditModal(); return; }
    data = await r.json();
    loadedData.set(id, data);
  }
  editSongs = [...(data.songs ?? [])];

  document.getElementById('edit-title').value   = data.title   ?? '';
  document.getElementById('edit-comment').value = data.comment ?? '';

  const gigSel = document.getElementById('edit-gig');
  gigSel.innerHTML = '<option value="">— no gig —</option>';
  try {
    if (!loadedGigs.size) {
      const gigs = await fetch(`/api/${bandSlug}/gigs`).then(r => r.json());
      for (const g of gigs) loadedGigs.set(g.id, g);
    }
    for (const [, g] of loadedGigs) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name + (g.date ? ' — ' + String(g.date).slice(0, 10) : '');
      if (g.id === data.gig_id) opt.selected = true;
      gigSel.appendChild(opt);
    }
  } catch {}
  onGigSelect();

  renderEditSongList();
  renderEditAddDropdown();

  document.getElementById('edit-modal').classList.add('open');
  const focusId = hasToken ? 'edit-title' : 'edit-password';
  setTimeout(() => document.getElementById(focusId).focus(), 50);
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('open');
  editTargetId = null;
  editSongs = [];
}

function renderEditSongList() {
  const ul = document.getElementById('edit-song-list');
  if (!editSongs.length) {
    ul.innerHTML = '<li style="color:var(--third-color);font-size:0.82rem;padding:0.2rem 0;">No songs yet.</li>';
    return;
  }
  ul.innerHTML = editSongs.map((song, i) => {
    const isFirst = i === 0, isLast = i === editSongs.length - 1;
    return `<li class="edit-song-row">
      <span class="edit-song-num">${i + 1}.</span>
      <span class="edit-song-title">${escHtml(song.title)}</span>
      <div class="song-actions">
        <button class="move-btn" onclick="editMoveSong(${i},-1)" ${isFirst ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="move-btn" onclick="editMoveSong(${i},1)"  ${isLast  ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="song-remove-btn" onclick="editRemoveSong(${i})" title="Remove">&#215;</button>
      </div>
    </li>`;
  }).join('');
}

function renderEditAddDropdown() {
  const sel = document.getElementById('edit-add-song');
  const inSet = new Set(editSongs.map(s => s.id));
  const available = allSongs
    .filter(s => s.active && !inSet.has(s.id))
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  sel.innerHTML = '<option value="">+ add a song…</option>' +
    available.map(s => `<option value="${s.id}">${escHtml(s.title)}</option>`).join('');
}

function editMoveSong(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= editSongs.length) return;
  [editSongs[i], editSongs[j]] = [editSongs[j], editSongs[i]];
  renderEditSongList();
}

function editRemoveSong(i) {
  editSongs.splice(i, 1);
  renderEditSongList();
  renderEditAddDropdown();
}

function editAddSong(sel) {
  const id = Number(sel.value);
  if (!id) return;
  const song = allSongs.find(s => s.id === id);
  if (song) editSongs.push(song);
  renderEditSongList();
  renderEditAddDropdown();
}

async function doEditSave() {
  let token = sessionStorage.getItem('setlist_token');
  const pw  = document.getElementById('edit-password').value.trim();
  if (pw) token = pw;

  const st  = document.getElementById('edit-status');
  const btn = document.getElementById('edit-save-btn');

  if (!token) {
    document.getElementById('edit-auth-field').style.display = '';
    document.getElementById('edit-password').focus();
    st.textContent = 'Password required.'; st.className = 'status-msg error';
    return;
  }

  btn.disabled = true;
  st.textContent = 'Saving…'; st.className = 'status-msg'; st.style.display = 'block';

  const body = {
    title:    document.getElementById('edit-title').value.trim()   || null,
    comment:  document.getElementById('edit-comment').value.trim() || null,
    gig_id:   Number(document.getElementById('edit-gig').value)    || null,
    song_ids: editSongs.map(s => s.id),
  };

  try {
    const r = await fetch(`/api/${bandSlug}/setlists/${editTargetId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    if (r.status === 401) {
      sessionStorage.removeItem('setlist_token');
      document.getElementById('edit-auth-field').style.display = '';
      document.getElementById('edit-password').value = '';
      document.getElementById('edit-password').focus();
      st.textContent = 'Wrong password.'; st.className = 'status-msg error';
      btn.disabled = false;
      return;
    }

    if (r.ok) {
      const updated = await r.json();
      sessionStorage.setItem('setlist_token', token);
      // Update in-memory lists so filters reflect the change
      const idx = allSetlists.findIndex(s => s.id === editTargetId);
      if (idx !== -1) allSetlists[idx] = { ...allSetlists[idx], ...updated };
      loadedData.set(editTargetId, { ...loadedData.get(editTargetId), ...updated, songs: editSongs });
      refreshAllActionBtns();
      refreshHistoryItem(editTargetId, updated);
      closeEditModal();
    } else {
      const data = await r.json().catch(() => ({}));
      st.textContent = data.error || 'Failed to save.'; st.className = 'status-msg error';
      btn.disabled = false;
    }
  } catch {
    st.textContent = 'Network error. Please try again.'; st.className = 'status-msg error';
    btn.disabled = false;
  }
}

function refreshHistoryItem(id, updated) {
  const metaEl = document.querySelector(`#set-${id} .history-meta`);
  if (metaEl) metaEl.innerHTML = renderSetlistMeta(updated);

  const songsEl = document.getElementById(`songs-${id}`);
  if (songsEl && !songsEl.hidden) {
    const total = editSongs.reduce((a, s) => a + (s.length_min || 0), 0);
    const rowsEl = songsEl.querySelector('div:first-child');
    if (rowsEl) rowsEl.innerHTML = editSongs.map(renderSongRow).join('');
    const totalEl = songsEl.querySelector('.songs-total');
    if (totalEl) totalEl.textContent = `Total: ${formatLength(total)}`;
  }
}

document.getElementById('edit-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeEditModal();
});
document.getElementById('edit-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('edit-title').focus();
});

// ── Gig editing (inline in edit modal) ───────────────────────────────────

function onGigSelect() {
  const gigId   = Number(document.getElementById('edit-gig').value);
  const section = document.getElementById('gig-edit-section');
  const form    = document.getElementById('gig-edit-form');
  if (!gigId) { section.style.display = 'none'; form.classList.remove('open'); return; }
  section.style.display = '';
  const gig = loadedGigs.get(gigId);
  if (gig) populateGigForm(gig);
}

function toggleGigEditForm() {
  document.getElementById('gig-edit-form').classList.toggle('open');
}

function populateGigForm(gig) {
  document.getElementById('gig-edit-name').value  = gig.name  ?? '';
  document.getElementById('gig-edit-date').value  = gig.date  ? String(gig.date).slice(0, 10) : '';
  document.getElementById('gig-edit-venue').value = gig.venue ?? '';
  document.getElementById('gig-edit-notes').value = gig.notes ?? '';
  const st = document.getElementById('gig-edit-status');
  st.className = 'status-msg'; st.textContent = '';
}

async function saveGigEdit() {
  const gigId = Number(document.getElementById('edit-gig').value);
  if (!gigId) return;
  const token = sessionStorage.getItem('setlist_token');
  if (!token) return;

  const name = document.getElementById('gig-edit-name').value.trim();
  if (!name) {
    const st = document.getElementById('gig-edit-status');
    st.textContent = 'Name is required.'; st.className = 'status-msg error';
    return;
  }

  const btn = document.getElementById('gig-edit-save-btn');
  const st  = document.getElementById('gig-edit-status');
  btn.disabled = true;
  st.textContent = 'Saving…'; st.className = 'status-msg'; st.style.display = 'block';

  try {
    const r = await fetch(`/api/${bandSlug}/gigs/${gigId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        name,
        date:  document.getElementById('gig-edit-date').value        || null,
        venue: document.getElementById('gig-edit-venue').value.trim() || null,
        notes: document.getElementById('gig-edit-notes').value.trim() || null,
      }),
    });

    if (r.ok) {
      const updated = await r.json();
      loadedGigs.set(gigId, updated);
      // Update in-memory gig list for the gigs view
      const idx = allGigs.findIndex(g => g.id === gigId);
      if (idx !== -1) allGigs[idx] = updated;
      const opt = document.querySelector(`#edit-gig option[value="${gigId}"]`);
      if (opt) opt.textContent = updated.name + (updated.date ? ' — ' + String(updated.date).slice(0, 10) : '');
      st.textContent = 'Gig saved.'; st.className = 'status-msg success';
    } else {
      const data = await r.json().catch(() => ({}));
      st.textContent = data.error || 'Failed to save.'; st.className = 'status-msg error';
    }
  } catch {
    st.textContent = 'Network error.'; st.className = 'status-msg error';
  } finally {
    btn.disabled = false;
  }
}

// ── Share modal ───────────────────────────────────────────────────────────

let shareTargetId = null;

function openShareModal(id) {
  shareTargetId = id;
  document.getElementById('share-email').value    = '';
  document.getElementById('share-password').value = '';
  const hasToken = !!sessionStorage.getItem('setlist_token');
  document.getElementById('share-auth-field').style.display = hasToken ? 'none' : '';
  const st = document.getElementById('share-status');
  st.className = 'status-msg'; st.textContent = '';
  document.getElementById('share-send-btn').disabled = false;
  document.getElementById('share-modal').classList.add('open');
  setTimeout(() => document.getElementById(hasToken ? 'share-email' : 'share-password').focus(), 50);
}

function closeShareModal() {
  document.getElementById('share-modal').classList.remove('open');
  shareTargetId = null;
}

async function doShareSend() {
  const email = document.getElementById('share-email').value.trim();
  const st    = document.getElementById('share-status');
  if (!email) { st.textContent = 'Please enter an email address.'; st.className = 'status-msg error'; return; }

  let token = sessionStorage.getItem('setlist_token');
  const pwInput = document.getElementById('share-password').value.trim();
  if (pwInput) token = pwInput;
  if (!token) {
    document.getElementById('share-auth-field').style.display = '';
    document.getElementById('share-password').focus();
    st.textContent = 'Password required.'; st.className = 'status-msg error';
    return;
  }

  const btn = document.getElementById('share-send-btn');
  btn.disabled = true;
  st.textContent = 'Sending…'; st.className = 'status-msg'; st.style.display = 'block';

  try {
    const r = await fetch(`/api/${bandSlug}/setlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ share_id: shareTargetId, email }),
    });
    if (r.status === 401) {
      sessionStorage.removeItem('setlist_token');
      document.getElementById('share-auth-field').style.display = '';
      document.getElementById('share-password').value = '';
      document.getElementById('share-password').focus();
      st.textContent = 'Wrong password.'; st.className = 'status-msg error';
      btn.disabled = false;
      return;
    }
    if (r.ok) {
      sessionStorage.setItem('setlist_token', token);
      refreshAllActionBtns();
      st.textContent = `Sent to ${email}`; st.className = 'status-msg success';
      setTimeout(closeShareModal, 1800);
    } else {
      const data = await r.json().catch(() => ({}));
      st.textContent = data.error || 'Failed to send. Please try again.'; st.className = 'status-msg error';
      btn.disabled = false;
    }
  } catch {
    st.textContent = 'Network error. Please try again.'; st.className = 'status-msg error';
    btn.disabled = false;
  }
}

document.getElementById('share-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeShareModal();
});
document.getElementById('share-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') doShareSend();
});
document.getElementById('share-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('share-email').focus();
});

// ── Stage / duplicate / print ─────────────────────────────────────────────

function openStageView(id) {
  window.open(`/stage?id=${id}`, '_blank');
}

async function doDuplicate(id) {
  const token = sessionStorage.getItem('setlist_token');
  if (!token) return;

  const btn = document.getElementById(`dup-btn-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    const r = await fetch(`/api/${bandSlug}/setlists`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duplicate_id: id }),
    });

    if (r.status === 401) { sessionStorage.removeItem('setlist_token'); refreshAllActionBtns(); return; }
    if (!r.ok) { const e = await r.json().catch(() => ({})); alert(`Duplicate failed: ${e.error || r.status}`); return; }

    const created = await r.json();
    allSetlists.unshift(created);
    loadedData.set(created.id, created);

    const year     = new Date(created.created_at).getFullYear();
    const yearBody = document.getElementById(`year-${year}`);

    const itemHtml = `
      <div class="history-item" id="set-${created.id}">
        <div class="history-header" onclick="toggleSet(${created.id})">
          <div class="history-meta">${renderSetlistMeta(created)}</div>
          <button class="toggle-btn" aria-label="Toggle setlist" aria-expanded="false">&#9660;</button>
        </div>
        <div class="history-songs" id="songs-${created.id}" hidden>
          <p style="color:var(--third-color);font-size:0.82rem;padding:0.25rem 0;">Loading…</p>
        </div>
      </div>`;

    if (yearBody) {
      yearBody.insertAdjacentHTML('afterbegin', itemHtml);
      yearBody.hidden = false;
      const header = yearBody.previousElementSibling;
      if (header) {
        header.setAttribute('aria-expanded', 'true');
        const arrow = header.querySelector('.year-arrow');
        if (arrow) arrow.textContent = '▲';
        const count = yearBody.querySelectorAll('.history-item').length;
        const yearCount = header.querySelector('.year-count');
        if (yearCount) yearCount.textContent = `${count} set${count !== 1 ? 's' : ''}`;
      }
    } else {
      location.reload();
    }
  } catch {
    // silent
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Duplicate'; }
  }
}

function printHistorySetlist(id) {
  const data = loadedData.get(id);
  if (!data?.songs?.length) return;

  const now = new Date();
  const date = now.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('print-timestamp').textContent = `${date} — ${time}`;

  const titleParts = [];
  if (data.title)    titleParts.push(`"${data.title}"`);
  if (data.gig_name) titleParts.push(data.gig_name);
  if (data.gig_date) titleParts.push(String(data.gig_date).slice(0, 10));
  document.getElementById('print-setlist-title').textContent = titleParts.join(' — ');

  const size = calcPrintFontSize(data.songs.length);
  document.documentElement.style.setProperty('--print-song-size', size + 'pt');

  let totalMin = 0;
  const items = data.songs.map((song, i) => {
    totalMin += song.length_min || 0;
    const printLabels = [
      song.key      ? escHtml(song.key)      : '',
      song.genre    ? escHtml(song.genre)    : '',
    ].filter(Boolean).map(v => `<span>${v}</span>`).join('');
    return `<li class="song-item">
      <span class="song-num">${i + 1}.</span>
      <div class="song-main">
        <div class="song-top">
          <span class="song-title">${escHtml(song.title)}</span>
          ${printLabels ? `<span class="print-labels">${printLabels}</span>` : ''}
          <span class="song-time">${formatLength(song.length_min)}</span>
        </div>
      </div>
    </li>`;
  }).join('');

  document.getElementById('print-area').innerHTML = `
    <div class="setlist-result">
      <h2>${data.songs.length} songs &bull; ${formatLength(totalMin)}</h2>
      <ul class="song-list">${items}</ul>
    </div>`;

  setTimeout(() => {
    window.print();
    setTimeout(() => document.documentElement.style.removeProperty('--print-song-size'), 500);
  }, 50);
}

init();
