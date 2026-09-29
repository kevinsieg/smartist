// Songs bulk-edit table: the spreadsheet view behind the Bulk edit toggle.
// Split out of songs.js — same global scope, loaded before it. Uses COLS, songs,
// getVisibleSongs, getVal and the dirty set from songs.js.
// SPA rule applies here too: no top-level const/let (see tests/unit/page_scripts.js).

function _renderBulkEditTable() {
  // bulk edit table — populated below by moving old renderTable body
  const saved = getSavedWidths();
  const headers = _visibleCols().map((c, i) => {
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
      <button class="btn" data-onclick="toggleBulkEdit()">← ${t('songs.list')}</button>
      <button class="btn icon-btn auth-action" title="${t('songs.share')}" data-onclick="_songsShareMenu(this)">${SHARE_ICON}</button>
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
  const cells = _visibleCols().map((c, i) => {
    const val = getVal(song, c.key);
    const sticky = i === 0 ? ' col-sticky' : '';
    if (c.type === 'stat') {
      let display = '—';
      if (val !== '' && val !== null && val !== undefined) {
        if (c.key === 'last_played_at') {
          display = formatDate(val);
        } else {
          display = String(val);
        }
      }
      let clickable = false, attrs = '';
      if (c.key === 'play_count' && song.id) {
        clickable = true;
        attrs = ` data-onclick="openAppearances(${song.id})"`;
      } else if (c.key === 'gema_work_number' && val && val !== '—' && song.id) {
        clickable = true;
        attrs = ` data-onclick="openGema(${song.id})"`;
      }
      return `<td class="${c.cls}${sticky}">
        <span class="stat-cell${clickable ? ' clickable' : ''}"${attrs}>${escHtml(display)}</span>
      </td>`;
    }
    if (c.type === 'listen') {
      const hasUrl = !!val;
      const actionBtn = hasUrl
        ? `<button class="listen-play-btn" data-onclick="openPlayer('${sid}')" title="${t('songs.play')}">▶</button>`
        : `<button class="listen-upload-btn" data-onclick="triggerAudioUpload('${sid}')" title="${t('songs.uploadAudio')}">↑</button>`;
      return `<td class="${c.cls}${sticky} listen-cell">
        <input type="text" data-id="${sid}" data-key="${c.key}"
          value="${escHtml(String(val))}" style="display:none">
        ${actionBtn}
        <input type="file" class="listen-file-input" accept="audio/*" style="display:none"
          data-onchange="handleAudioFile(this, '${sid}')">
      </td>`;
    }
    if (c.type === 'sheet') {
      const hasUrl = !!val;
      const actionBtn = hasUrl
        ? `<button class="sheet-open-btn" data-onclick="openSheet('${sid}')" title="${t('songs.openSheet')}">≡</button>`
        : `<button class="sheet-upload-btn" data-onclick="triggerSheetUpload('${sid}')" title="${t('songs.uploadPdf')}">↑</button>`;
      return `<td class="${c.cls}${sticky} sheet-cell">
        <input type="text" data-id="${sid}" data-key="${c.key}"
          value="${escHtml(String(val))}" style="display:none">
        ${actionBtn}
        <input type="file" class="sheet-file-input" accept=".pdf,application/pdf" style="display:none"
          data-onchange="handleSheetFile(this, '${sid}')">
      </td>`;
    }
    if (c.type === 'playback') {
      const hasUrl = !!val;
      const actionBtn = hasUrl
        ? `<button class="playback-open-btn" data-onclick="openPlayback('${sid}')" title="${t('songs.playPlayback')}">▷</button>`
        : `<button class="playback-upload-btn" data-onclick="triggerPlaybackUpload('${sid}')" title="${t('songs.uploadPlayback')}">↑</button>`;
      return `<td class="${c.cls}${sticky} playback-cell">
        <input type="text" data-id="${sid}" data-key="${c.key}"
          value="${escHtml(String(val))}" style="display:none">
        ${actionBtn}
        <input type="file" class="playback-file-input" accept="audio/*" style="display:none"
          data-onchange="handlePlaybackFile(this, '${sid}')">
      </td>`;
    }
    if (c.type === 'lyrics') {
      // The list carries has_lyrics; the text is loaded when the modal opens.
      const hasLyrics = !!(song.has_lyrics || song.lyrics);
      const actionBtn = hasLyrics
        ? `<button class="lyrics-open-btn" data-onclick="openLyrics('${sid}')" title="${t('songs.viewLyrics')}">¶</button>`
        : (_viewMode ? '' : `<button class="lyrics-add-btn"  data-onclick="openLyricsEdit('${sid}')" title="${t('songs.addLyrics')}">+</button>`);
      return `<td class="${c.cls}${sticky} lyrics-cell">
        ${actionBtn}
      </td>`;
    }
    if (c.type === 'arr') {
      const hasArr = !!val;
      const btn = (hasArr || !_viewMode)
        ? `<button class="arr-col-btn${hasArr ? '' : ' arr-col-btn--empty'}"
             data-onclick="_openSongArrangement(${Number(song.id)})"
             title="${hasArr ? t('songs.openArrangement') : t('songs.noArrangement')}">&#8862;</button>`
        : '';
      return `<td class="${c.cls}${sticky} arr-cell">${btn}</td>`;
    }
    if (c.type === 'bool') {
      return `<td class="${c.cls}${sticky}">
        <input type="checkbox" data-id="${sid}" data-key="${c.key}"
          ${val === true || val === 'true' || val === 1 ? 'checked' : ''}
          data-onchange="markDirty('${sid}')">
      </td>`;
    }
    if (c.type === 'time') {
      return `<td class="${c.cls}${sticky}">
        <input type="text" data-id="${sid}" data-key="${c.key}" data-type="time"
          value="${escHtml(minsToTime(val ?? 4))}" placeholder="MM:SS"
          data-oninput="markDirty('${sid}')">
      </td>`;
    }
    if (c.type === 'energy') {
      return `<td class="${c.cls}${sticky}">${energyInputHtml(sid, c.key, val, `markDirty('${sid}')`)}</td>`;
    }
    if (c.type === 'number') {
      return `<td class="${c.cls}${sticky}">
        <input type="number" data-id="${sid}" data-key="${c.key}"
          value="${escHtml(String(val))}" min="0" step="1" inputmode="numeric"
          data-oninput="markDirty('${sid}')">
      </td>`;
    }
    if (c.type === 'select') {
      const isLang = c.key === 'gema_language';
      // GEMA language is shadowed (read-only) once a GEMA work is linked.
      if (isLang && song.gema_work_number) {
        return `<td class="${c.cls}${sticky}"><span class="stat-cell">${escHtml(val || '—')}</span></td>`;
      }
      const cur = isLang ? (song.language || c.default || '') : (val ?? '');
      const dataKey = isLang ? 'language' : c.key;
      let list = c.options || [];
      if (cur && list.indexOf(cur) === -1) list = [cur, ...list];
      const placeholder = isLang ? '' : '<option value="">—</option>';
      const opts = placeholder + list.map(o =>
        `<option value="${escHtml(o)}"${o === cur ? ' selected' : ''}>${escHtml(o)}</option>`
      ).join('');
      return `<td class="${c.cls}${sticky}">
        <select data-id="${sid}" data-key="${dataKey}" data-onchange="markDirty('${sid}')">${opts}</select>
      </td>`;
    }
    if (c.type === 'url') {
      const hasUrl = !!val;
      const btnCls = hasUrl ? 'url-edit-btn url-edit-btn--set' : 'url-edit-btn';
      const btnLbl = hasUrl ? '✓ Link' : '+ Add';
      return `<td class="${c.cls}${sticky} url-cell">
        <input type="text" data-id="${sid}" data-key="${c.key}" value="${escHtml(String(val))}" style="display:none">
        <button class="${btnCls}" data-onclick="openUrlPreview(this.previousElementSibling.value,this.previousElementSibling)">${btnLbl}</button>
      </td>`;
    }
    return `<td class="${c.cls}${sticky}">
      <input type="text" data-id="${sid}" data-key="${c.key}"
        value="${escHtml(String(val))}"
        data-oninput="markDirty('${sid}')">
    </td>`;
  }).join('');

  return `<tr id="row-${sid}" data-id="${sid}">${cells}
    <td class="col-del">
      <button class="del-btn" data-onclick="deleteRow('${sid}')" title="${t('songs.delete')}">&#215;</button>
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

// Energy 0–10 as a slider. A range input always has a value, so "not set" lives in
// the hidden field collectRow reads; the slider itself carries no data-id.
function energyInputHtml(sid, key, val, onDirty) {
  const has = val !== null && val !== undefined && val !== '';
  const n = has ? Number(val) : 5;
  return `<span class="energy-input">` +
    `<input type="text" data-id="${sid}" data-key="${key}" value="${has ? n : ''}" style="display:none">` +
    `<span class="energy-end">${escHtml(t('songs.energyLow'))}</span>` +
    `<input type="range" min="0" max="10" step="1" value="${n}" class="energy-range${has ? '' : ' energy-range--unset'}"` +
      ` title="${has ? n : ''}" aria-label="${escHtml(t('songs.fieldEnergy'))}" data-oninput="_energySet(this, this.value);${onDirty}">` +
    `<span class="energy-end">${escHtml(t('songs.energyHigh'))}</span>` +
    `<button type="button" class="energy-clear" title="${escHtml(t('songs.energyClear'))}"` +
      ` data-onclick="_energyClear(this);${onDirty}">×</button>` +
  `</span>`;
}

function _energyClear(btn) { _energySet(btn.parentNode.querySelector('.energy-range'), ''); }

function _energySet(range, value) {
  const wrap = range.parentNode;
  wrap.querySelector('input[type="text"]').value = value;
  range.classList.toggle('energy-range--unset', value === '');
  range.title = value;
}

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

  const token = getToken();
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
    if (!isViewMode()) { clearToken(); requireLogin(); }
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
  const token = getToken();
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

    var rejected = [];
    if (toUpdate.length > 0) {
      const r = await fetch(`/api/${artistSlug}/songs`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(toUpdate),
      });
      if (r.status === 401) { if (!isViewMode()) { clearToken(); requireLogin(); } return; }
      if (!r.ok) throw new Error('patch failed');
      // Rows the server refused: say so instead of reporting a silent success.
      rejected = (await r.json().catch(function() { return {}; })).rejected || [];
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
    if (rejected.length) {
      _setBulkStatus('error', t('songs.savedWithErrors', { n: rejected.length, error: rejected[0].error }));
      rejected.forEach(function(rej) {
        var row = document.getElementById('row-' + rej.id);
        if (row) { row.classList.add('dirty'); row.title = rej.error; }
      });
    } else {
      _setBulkStatus('saved', t('songs.allChangesSaved'));
      setTimeout(() => _setBulkStatus('', ''), 3000);
    }

  } catch {
    _setBulkStatus('error', t('songs.saveFailed'));
  } finally {
    const b = document.getElementById('save-btn');
    if (b) { b.disabled = false; b.textContent = t('songs.save'); }
  }
}
