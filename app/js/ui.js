// Shared widgets: sortable lists, typeahead, modals, busy buttons, the heart
// toggle, CSV export and printing, the resizable side panel, hard-delete dialog.

// Tell screen readers about a change that has no visible focus of its own
// (a song moved, a row removed). One polite live region per page.
// Errors go to a second, assertive region so they interrupt.
function announce(msg, urgent) {
  var id = urgent ? 'app-live-alert' : 'app-live';
  var live = document.getElementById(id);
  if (!live) {
    live = document.createElement('div');
    live.id = id;
    live.className = 'sr-only';
    live.setAttribute('role', urgent ? 'alert' : 'status');
    live.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
    document.body.appendChild(live);
  }
  // Clearing first makes the same text announced twice in a row.
  live.textContent = '';
  setTimeout(function() { live.textContent = msg; }, 50);
}

// Favourite heart for list rows (songs, venues, organizers). onclick is a JS expression.
function heartButtonHtml(on, onclick, title, readOnly) {
  var cls = 'heart-btn' + (on ? ' heart-btn--on' : '');
  if (readOnly) return on ? '<span class="' + cls + '">&#9829;</span>' : '<span class="heart-btn"></span>';
  return '<button type="button" class="' + cls + '" aria-pressed="' + on + '"' +
    ' title="' + escHtml(title) + '" aria-label="' + escHtml(title) + '"' +
    ' data-onclick="event.stopPropagation();' + onclick + '">' +
    (on ? '&#9829;' : '&#9825;') + '</button>';
}

// Flip item.heart locally, then persist(wanted). On failure the icon goes back, so what
// you see always matches what is stored. persist must throw when the save fails.
async function toggleHeart(item, persist, refresh) {
  var wanted = !item.heart;
  item.heart = wanted;
  refresh();
  try { await persist(wanted); }
  catch { item.heart = !wanted; refresh(); }
}

// One CSV cell. A text starting with = + - @ tab or CR is run as a formula by
// Excel/Sheets, so it gets a leading ' (same rule as api/_export.js); plain
// numbers such as -3 stay numbers.
function csvCell(val) {
  var s = (val === null || val === undefined) ? '' : String(val);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
  if (s.indexOf('"') >= 0 || s.indexOf(',') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// columns: Array<{ label: string, getValue: (row) => string }>
function exportTableCsv(rows, columns, filename) {
  var header = columns.map(function(c) { return csvCell(c.label); }).join(',');
  var body = rows.map(function(row) {
    return columns.map(function(c) { return csvCell(c.getValue(row)); }).join(',');
  }).join('\r\n');
  var csv = '﻿' + header + '\r\n' + body;
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  var d = new Date();
  a.href = url;
  a.download = filename + '-' + d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 100);
}

// opts.headings: Set of indexes that get a tag heading before them (group by tag).
function printSetlistSongs(songs, title, cfg, opts) {
  var headings = opts && opts.headings;
  var area = document.getElementById('print-area');
  if (!area) return;

  var logoEl = document.querySelector('#print-header .app-logo-img');
  if (logoEl) {
    var logoUrl = cfg && cfg.config && cfg.config.logoUrl;
    if (logoUrl) {
      logoEl.src = logoUrl.replace(/^http:/i, 'https:');
      logoEl.alt = (cfg && cfg.name) || '';
      logoEl.style.display = '';
    } else {
      logoEl.style.display = 'none';
    }
  }

  var now = new Date();
  var date = formatDate(now, 'long');
  var time = formatTime(now);
  var tsEl = document.getElementById('print-timestamp');
  if (tsEl) tsEl.textContent = date + ' — ' + time;

  var hidden = function(key) { return songFieldHidden(cfg && cfg.config, key); };
  var items = songs.map(function(song, i) {
    var span = function(v, field, ttl) {
      return v && !hidden(field) ? '<span data-field="' + escHtml(field) + '" title="' + escHtml(ttl) + '">' + escHtml(v) + '</span>' : '';
    };
    var banjo = song.extra && song.extra.banjoCapo != null && !hidden('extra.banjoCapo') ? String(song.extra.banjoCapo) : null;
    var git   = song.extra && song.extra.gitCapo   != null && !hidden('extra.gitCapo')   ? String(song.extra.gitCapo)   : null;
    var capoParts = [
      banjo !== null && banjo !== '0' ? 'B ' + escHtml(banjo) : '',
      git   !== null && git   !== '0' ? 'G ' + escHtml(git)   : ''
    ].filter(Boolean);
    var capoSpan = capoParts.length
      ? '<span class="capo-badge" title="Capo">Capo: ' + capoParts.join(' | ') + '</span>'
      : '';
    var metaSpans = [
      span((song.extra && song.extra.lead) || '', 'extra.lead', 'Lead'),
      span(song.key ? formatKey(song.key) : '',   'key',        'Key'),
      capoSpan,
      span(song.tempo || '', 'tempo', 'Tempo'),
      span(song.genre || '', 'genre', 'Genre'),
      song.extra && song.extra.harp ? span('harmonica', 'extra.harp', 'Harmonica') : '',
      song.extra && song.extra.aCapella ? span('a cappella', 'extra.aCapella', 'A cappella') : '',
      song.extra && song.extra.git2 ? span('guitar 2',  'extra.git2', 'Second guitar') : ''
    ].filter(Boolean).join('');
    var printLabels = song.genre ? '<span>' + escHtml(song.genre) + '</span>' : '';

    var heading = headings && headings.has(i)
      ? '<li class="tag-heading">' + escHtml(songTags(song)[0] || t('setlist.untagged')) + '</li>'
      : '';
    return heading + '<li class="song-item">' +
      '<span class="song-num">' + (i + 1) + '.</span>' +
      '<div class="song-main">' +
        '<div class="song-top">' +
          '<span class="song-title">' + escHtml(song.title || '') + '</span>' +
          (printLabels ? '<span class="print-labels">' + printLabels + '</span>' : '') +
          '<span class="song-time">' + formatLength(song.length_min) + '</span>' +
        '</div>' +
        (metaSpans ? '<div class="song-meta">' + metaSpans + '</div>' : '') +
      '</div>' +
    '</li>';
  }).join('');

  area.innerHTML =
    (title ? '<h2 class="print-setlist-title">' + escHtml(title) + '</h2>' : '') +
    '<ul class="song-list">' + items + '</ul>';

  var size = calcPrintFontSize(songs.length + (headings ? headings.size : 0));
  document.documentElement.style.setProperty('--print-song-size', size + 'pt');

  var _printCleanup = function() {
    document.documentElement.style.removeProperty('--print-song-size');
    area.innerHTML = '';
    window.removeEventListener('afterprint', _printCleanup);
  };
  window.addEventListener('afterprint', _printCleanup);
  setTimeout(function() {
    window.print();
    setTimeout(_printCleanup, 5000); // fallback in case afterprint never fires
  }, 50);
}

function injectViewModeNotice() {
  // badge is now rendered inline by updateAuthIndicator()
}

function injectModalCloseButtons() {
  document.querySelectorAll('.modal-overlay[id] > .modal').forEach(function(modal) {
    if (modal.querySelector('.modal-x-btn')) return;
    var id = modal.closest('.modal-overlay').id;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal-x-btn';
    btn.setAttribute('aria-label', 'Close');
    btn.innerHTML = '&#215;';
    btn.onclick = function() { closeModal(id); };
    modal.insertBefore(btn, modal.firstChild);
  });
}

// Disable all write-action buttons currently in the DOM.
// Pages that render buttons dynamically should also check isViewMode()
// in their render functions and add the disabled attribute there.
function applyViewMode() {
  document.querySelectorAll('button.auth-action, input.auth-action').forEach(function(el) {
    el.style.display = 'none';
  });
  document.querySelectorAll('.auth-only').forEach(function(el) {
    el.style.display = 'none';
  });
}

// Set a status element's text and error styling.
// A write button answers the click at once and cannot fire twice.
async function withBusy(btn, fn, label = t('common.saving')) {
  if (!btn) return fn();
  if (btn.disabled) return;
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = text;
  }
}

function setStatus(elementId, msg, isError = false) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-msg' + (isError ? ' error' : '');
  if (msg) announce(msg, isError);
}

// Generic modal open/close by element ID.
var _modalCloseFns = {};

// Register a custom close function for a modal by overlay id.
// closeModal(id) dispatches through this registry automatically.
function registerModal(id, fn) { _modalCloseFns[id] = fn; }

function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) {
  if (_modalCloseFns[id]) { _modalCloseFns[id](); return; }
  document.getElementById(id)?.classList.remove('open');
}

// Wire Enter-to-save on a modal or panel container.
// Enter on any <input> triggers saveFn(); textarea and select are left alone.
function onEnterSave(containerEl, saveFn) {
  if (!containerEl) return;
  containerEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      saveFn();
    }
  });
}

// Scroll to and expand the list row whose id matches the `open` URL param.
// Call from initPage callbacks on pages that use createSortableList.
function openDeepLinkedRow(param) {
  var id = Number(new URLSearchParams(location.search).get(param || 'open'));
  if (!id) return;
  requestAnimationFrame(function() {
    var row = document.querySelector('.sl-row[data-id="' + id + '"]');
    if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.click(); }
  });
}

document.addEventListener('click', function(e) {
  if (e.target.classList.contains('modal-overlay') && e.target.classList.contains('open')) {
    closeModal(e.target.id);
  }
});

// ── Reusable sortable list ────────────────────────────────────────────────────
//
// Column shape: { field, label, width, sortable, filterable, muted, type, render, actions }
//   type: 'number' | 'date' — affects sort comparison and display formatting
//   render(row) → html string — custom cell content; skips field value
//   actions: true — marks the cell as an actions column (click does not trigger onRowClick)
//   muted: true — applies secondary text colour
//
// Returns { setData(rows), refresh() }

const _slFilterRegistry = {};

function createSortableList({ containerId, sortBarId, filterInputId, columns, defaultSort,
    defaultSortDir = 1, rowClass, onRowClick, onExpand, emptyHint, separateDeleted = false }) {

  let _data = [];
  let _sortField = defaultSort ?? null;
  let _sortDir = defaultSortDir;
  let _openId = null;

  const colWidths    = columns.map(c => c.width || '1fr').join(' ');
  const filterFields = columns.filter(c => c.filterable).map(c => c.field);
  const sortableCols = columns.filter(c => c.sortable);

  // Register this instance's _render with the filter input so multiple instances
  // sharing the same input (e.g. upcoming + past gig tables) all update together.
  if (filterInputId) {
    if (!_slFilterRegistry[filterInputId]) {
      const el = document.getElementById(filterInputId);
      _slFilterRegistry[filterInputId] = [];
      if (el) el.addEventListener('input', () => _slFilterRegistry[filterInputId].forEach(fn => fn()));
    }
    _slFilterRegistry[filterInputId].push(_render);
  }

  // Build sort bar (event-delegated, no per-button listeners).
  const barEl = sortBarId ? document.getElementById(sortBarId) : null;
  if (barEl && sortableCols.length) {
    barEl.innerHTML = sortableCols.map(c =>
      `<button class="sort-btn${c.field === _sortField ? ' active' : ''}" data-field="${c.field}" data-label="${c.label}">${_label(c)}</button>`
    ).join('');
    barEl.addEventListener('click', e => {
      const btn = e.target.closest('.sort-btn');
      if (!btn) return;
      const field = btn.dataset.field;
      _sortDir = _sortField === field ? -_sortDir : 1;
      _sortField = field;
      _refreshBar();
      _render();
    });
  }

  function _label(col) {
    const active = col.field === _sortField;
    return col.label + (active ? (_sortDir === 1 ? ' ↑' : ' ↓') : '');
  }

  function _refreshBar() {
    if (!barEl) return;
    barEl.querySelectorAll('.sort-btn').forEach(btn => {
      const col = sortableCols.find(c => c.field === btn.dataset.field);
      if (!col) return;
      btn.classList.toggle('active', col.field === _sortField);
      btn.textContent = _label(col);
    });
  }

  function _filter(rows) {
    if (!filterInputId || !filterFields.length) return rows;
    const el = document.getElementById(filterInputId);
    const q  = el ? el.value.trim().toLowerCase() : '';
    if (!q) return rows;
    return rows.filter(row => filterFields.some(f => (row[f] ?? '').toString().toLowerCase().includes(q)));
  }

  function _sort(rows) {
    if (!_sortField) return rows;
    const col = columns.find(c => c.field === _sortField);
    if (!col) return rows;
    const key = r => col.type === 'number' ? (r[_sortField] || 0) : (r[_sortField] ?? '').toString().toLowerCase();
    return [...rows].sort((a, b) => {
      const av = key(a), bv = key(b);
      return av < bv ? -_sortDir : av > bv ? _sortDir : 0;
    });
  }

  async function _loadExpansion(rowEl, row) {
    rowEl.classList.add('sl-row--expanded');
    rowEl.setAttribute('aria-expanded', 'true');
    const expEl = document.createElement('div');
    expEl.className = 'sl-expansion';
    expEl.setAttribute('data-for', String(row.id));
    expEl.innerHTML = '<div class="sl-expansion-inner">' + skeletonHtml(2) + '</div>';
    rowEl.after(expEl);
    const html = await onExpand(row);
    if (!rowEl.isConnected) { return; }
    const inner = expEl.querySelector('.sl-expansion-inner');
    if (inner) inner.innerHTML = html;
  }

  async function _toggleRow(rowEl, row) {
    const isOpen = _openId === row.id;
    if (_openId !== null) {
      const containerEl = document.getElementById(containerId);
      const prevRowEl = containerEl ? containerEl.querySelector('.sl-row[data-id="' + _openId + '"]') : null;
      if (prevRowEl) {
        prevRowEl.classList.remove('sl-row--expanded');
        prevRowEl.setAttribute('aria-expanded', 'false');
        const prevExp = prevRowEl.nextElementSibling;
        if (prevExp && prevExp.classList.contains('sl-expansion')) prevExp.remove();
      }
      _openId = null;
    }
    if (!isOpen) {
      _openId = row.id;
      await _loadExpansion(rowEl, row);
    }
  }

  function _cellHtml(col, row) {
    const fieldCls = col.field ? ' sl-cell--' + col.field : '';
    if (col.render) {
      const cls = col.actions ? 'sl-cell sl-cell--actions' : ('sl-cell' + fieldCls);
      return `<div class="${cls}">${col.render(row)}</div>`;
    }
    let val;
    if      (col.type === 'number') val = row[col.field] != null ? Number(row[col.field]).toLocaleString() : '';
    else if (col.type === 'date')   val = row[col.field] ? escHtml(formatDate(row[col.field])) : '—';
    else                            val = escHtml((row[col.field] ?? '').toString());
    const cls = (col.muted ? 'sl-cell sl-cell--muted' : 'sl-cell') + fieldCls;
    return `<div class="${cls}">${val}</div>`;
  }

  function _render() {
    const el = document.getElementById(containerId);
    if (!el) return;

    let visible = _filter(_data);
    if (separateDeleted) {
      const alive   = _sort(visible.filter(r => !r.deleted));
      const deleted = visible.filter(r => r.deleted);
      visible = [...alive, ...deleted];
    } else {
      visible = _sort(visible);
    }

    if (!visible.length) {
      el.innerHTML = `<p class="empty-hint">${emptyHint || 'No items.'}</p>`;
      return;
    }

    el.innerHTML = visible.map(row => {
      const cls = ['sl-row', rowClass ? rowClass(row) : ''].filter(Boolean).join(' ');
      const cells = columns.map(col => _cellHtml(col, row)).join('');
      const focusable = onRowClick || onExpand ? ' tabindex="0"' + (onExpand ? ' aria-expanded="false"' : '') : '';
      return `<div class="${cls}" style="grid-template-columns:${colWidths}" data-id="${row.id}"${focusable}>${cells}</div>`;
    }).join('');

    if (onRowClick) {
      el.querySelectorAll('.sl-row').forEach(rowEl => {
        rowEl.addEventListener('click', e => {
          if (e.target.closest('.sl-cell--actions')) return;
          const row = _data.find(r => r.id === Number(rowEl.dataset.id));
          if (row) onRowClick(row);
        });
      });
    }

    if (onExpand) {
      el.querySelectorAll('.sl-row').forEach(function(rowEl) {
        rowEl.addEventListener('click', function(e) {
          if (e.target.closest('.sl-cell--actions')) return;
          var row = _data.find(function(r) { return r.id === Number(rowEl.dataset.id); });
          if (row) _toggleRow(rowEl, row).catch(function(err) { console.error('accordion expand failed', err); });
        });
      });
      if (_openId !== null) {
        var openRowEl = el.querySelector('.sl-row[data-id="' + _openId + '"]');
        if (openRowEl) {
          var openRow = _data.find(function(r) { return Number(r.id) === Number(_openId); });
          if (openRow) _loadExpansion(openRowEl, openRow).catch(function(err) { console.error('accordion expand failed', err); });
        } else {
          _openId = null;
        }
      }
    }
  }

  return {
    setData(rows) { _data = rows; _render(); },
    refresh()     { _render(); },
  };
}

/**
 * Attaches a typeahead dropdown to `inputEl`.
 * opts.items      — array of objects already loaded (filtering is client-side)
 * opts.labelFn    — item → display string
 * opts.onSelect   — (item) → void — called when user picks an existing item
 * opts.onCreate   — (text) → void — shown as last option "Create…"; omit to hide
 * opts.minChars   — default 1
 */
function createTypeahead(inputEl, { items, labelFn, onSelect, onCreate, minChars = 1 }) {
  const wrap = inputEl.closest('.typeahead-wrap') || inputEl.parentElement;
  let ul = null;
  let activeIdx = -1;
  // Combobox semantics: screen readers hear the list open and each highlighted option.
  const listId = (inputEl.id || 'ta' + Math.random().toString(36).slice(2)) + '-listbox';
  inputEl.setAttribute('role', 'combobox');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.setAttribute('aria-expanded', 'false');
  inputEl.setAttribute('aria-controls', listId);

  function open(filtered) {
    close();
    if (!filtered.length && !onCreate) return;
    ul = document.createElement('ul');
    ul.className = 'typeahead-dropdown';
    ul.id = listId;
    ul.setAttribute('role', 'listbox');

    filtered.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'typeahead-item';
      li.id = listId + '-' + i;
      li.setAttribute('role', 'option');
      li.textContent = labelFn(item);
      li.addEventListener('mousedown', e => { e.preventDefault(); pick(item); });
      ul.appendChild(li);
    });

    if (onCreate) {
      const li = document.createElement('li');
      li.className = 'typeahead-item typeahead-create';
      li.id = listId + '-create';
      li.setAttribute('role', 'option');
      li.textContent = `+ Create "${inputEl.value.trim()}"…`;
      li.addEventListener('mousedown', e => { e.preventDefault(); close(); onCreate(inputEl.value.trim()); });
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    activeIdx = -1;
    inputEl.setAttribute('aria-expanded', 'true');
  }

  function close() {
    ul?.remove(); ul = null; activeIdx = -1;
    inputEl.setAttribute('aria-expanded', 'false');
    inputEl.removeAttribute('aria-activedescendant');
  }

  function pick(item) { close(); onSelect(item); }

  function highlight(idx) {
    if (!ul) return;
    const lis = ul.querySelectorAll('.typeahead-item');
    lis.forEach((li, i) => {
      li.classList.toggle('active', i === idx);
      li.setAttribute('aria-selected', i === idx ? 'true' : 'false');
    });
    activeIdx = idx;
    if (lis[idx]) inputEl.setAttribute('aria-activedescendant', lis[idx].id);
  }

  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim().toLowerCase();
    if (q.length < minChars) { close(); return; }
    const filtered = items.filter(it => labelFn(it).toLowerCase().includes(q));
    open(filtered);
  });

  inputEl.addEventListener('keydown', e => {
    if (!ul) return;
    const lis = ul.querySelectorAll('.typeahead-item');
    if (e.key === 'ArrowDown')  { e.preventDefault(); highlight(Math.min(activeIdx + 1, lis.length - 1)); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); highlight(Math.max(activeIdx - 1, 0)); }
    if (e.key === 'Escape')     { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      lis[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
    }
  });

  inputEl.addEventListener('blur', () => setTimeout(close, 150));

  return { close, updateItems(newItems) { items = newItems; } };
}

// ── Resizable side panel ──────────────────────────────────────────────────────
function initPanelResize() {
  var panel = document.getElementById('view-side-panel');
  if (!panel) return;
  var handle = panel.querySelector('.panel-resize-handle');
  if (!handle) return;

  var LS_KEY = 'smartist_panel_w';
  var MIN_W  = 260;
  var MAX_W  = 700;

  var saved = parseInt(localStorage.getItem(LS_KEY), 10);
  if (saved && saved >= MIN_W && saved <= MAX_W) {
    document.documentElement.style.setProperty('--panel-w', saved + 'px');
  }

  handle.addEventListener('mousedown', function(e) {
    if (window.innerWidth <= 1024) return;
    e.preventDefault();
    handle.classList.add('resizing');
    document.body.style.userSelect = 'none';

    function onMove(e) {
      var w = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--panel-w', w + 'px');
    }

    function onUp(e) {
      handle.classList.remove('resizing');
      document.body.style.userSelect = '';
      var w = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--panel-w', w + 'px');
      localStorage.setItem(LS_KEY, w);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
// ── Shared hard-delete modal ───────────────────────────────────────────────
var _hardDeleteOpts = null;

function _ensureHardDeleteModal() {
  if (document.getElementById('hard-delete-modal')) return;
  var el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'hard-delete-modal';
  el.innerHTML =
    '<div class="modal" style="max-width:380px;">' +
    '<h2 id="hd-title"></h2>' +
    '<p id="hd-refs-msg" style="font-size:0.85rem;color:var(--third-color);"></p>' +
    '<div id="hd-cascade-opts"></div>' +
    '<div class="status-msg error" id="hd-status"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn active" type="button" id="hd-confirm-btn" style="background:#e55;" data-onclick="confirmHardDelete()">' + t('common.deletePermanently') + '</button>' +
    '<button class="btn" type="button" data-onclick="closeModal(\'hard-delete-modal\')">' + t('common.cancel') + '</button>' +
    '</div></div>';
  document.body.appendChild(el);
}

async function openHardDeleteModal(opts) {
  _ensureHardDeleteModal();
  _hardDeleteOpts = opts;
  document.getElementById('hd-title').textContent = opts.title;
  document.getElementById('hd-refs-msg').textContent = t('common.loading');
  document.getElementById('hd-cascade-opts').innerHTML = '';
  setStatus('hd-status', '');
  var btn = document.getElementById('hd-confirm-btn');
  if (btn) { btn.disabled = false; btn.textContent = t('common.deletePermanently'); }
  openModal('hard-delete-modal');
  try {
    var r = await apiFetch(opts.refsUrl);
    var data = await r.json();
    document.getElementById('hd-refs-msg').innerHTML = opts.buildRefsMsg(data.refs);
    document.getElementById('hd-cascade-opts').innerHTML = opts.buildCascadeOpts ? opts.buildCascadeOpts(data.refs) : '';
  } catch {
    setStatus('hd-status', t('common.couldNotLoadRefs'), true);
  }
}

async function confirmHardDelete() {
  if (!_hardDeleteOpts) return;
  var btn = document.getElementById('hd-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('common.deleting'); }
  try {
    var cascade = _hardDeleteOpts.getCascade ? _hardDeleteOpts.getCascade() : [];
    var r = await apiFetch(_hardDeleteOpts.deleteUrl, 'DELETE', { hard: true, cascade });
    if (r.ok) {
      setStatus('hd-status', t('common.deleted'));
      var opts = _hardDeleteOpts;
      _hardDeleteOpts = null;
      setTimeout(async function() {
        closeModal('hard-delete-modal');
        if (opts.onSuccess) await opts.onSuccess();
      }, 700);
    } else {
      var j = await r.json();
      setStatus('hd-status', j.error || t('common.error'), true);
      if (btn) { btn.disabled = false; btn.textContent = t('common.deletePermanently'); }
    }
  } catch {
    setStatus('hd-status', t('common.networkError'), true);
    if (btn) { btn.disabled = false; btn.textContent = t('common.deletePermanently'); }
  }
}

document.addEventListener('DOMContentLoaded', initPanelResize);

// ── Keyboard access to clickable rows ─────────────────────────────────────────
// List rows open a panel or expand on click. Rows rendered with tabindex="0"
// (createSortableList, createListView) open with Enter or Space as well.
if (typeof document !== 'undefined' && !window._rowKeysInit) {
  window._rowKeysInit = true;
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target;
    // Rows, and non-button elements marked up as buttons (drop zones, cards).
    if (!row || !row.matches || !row.matches('[data-id][tabindex="0"], [role="button"][tabindex="0"]:not(button)')) return;
    e.preventDefault();
    row.click();
  });
}

// ── Popup menus (account, share) ──────────────────────────────────────────────
// A menu of <button>s opened from a toggle: the toggle reports aria-expanded,
// focus moves to the first item, ↑/↓ move between items, Escape or Tab away
// closes it, and Escape gives focus back to the toggle.
function wirePopupMenu(btn, menu) {
  var items = function() { return [].slice.call(menu.querySelectorAll('button:not([disabled])')); };
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'true');
  function close(refocus) {
    if (!menu.isConnected) return;
    menu.remove();
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
    if (refocus) btn.focus();
  }
  function onDocClick(e) { if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(false); }
  menu.addEventListener('keydown', function(e) {
    var list = items(), i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
  });
  menu.addEventListener('focusout', function(e) {
    if (e.relatedTarget && !menu.contains(e.relatedTarget) && e.relatedTarget !== btn) close(false);
  });
  // Choosing an item closes the menu (items may close it themselves first).
  menu.addEventListener('click', function(e) {
    var b = e.target.closest('button');
    if (b && !b.hasAttribute('data-keep-open')) setTimeout(function() { close(false); }, 0);
  });
  menu._close = close;
  setTimeout(function() { document.addEventListener('click', onDocClick); }, 0);
  var first = items()[0];
  if (first) first.focus();
  return close;
}

// ── Dialog behaviour for every .modal-overlay ─────────────────────────────────
// Pages open and close modals by toggling .open. Whatever the page does, an open
// modal is announced as a dialog named by its heading, takes focus, keeps Tab
// inside, closes on Escape (through closeModal, so page close hooks run) and
// gives focus back to the control that opened it.
var _modalOpeners = new Map();

function _modalFocusables(dialog) {
  return [].filter.call(dialog.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  function(el) { return el.offsetParent !== null || el.getClientRects().length > 0; });
}

function _dialogOf(overlay) {
  return overlay.querySelector('.modal, .arr-modal') || overlay;
}

function _onModalOpen(overlay) {
  var dialog = _dialogOf(overlay);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  if (!dialog.hasAttribute('aria-labelledby') && !dialog.hasAttribute('aria-label')) {
    var h = dialog.querySelector('h2, h3');
    if (h) {
      if (!h.id) h.id = (overlay.id || 'modal') + '-heading';
      dialog.setAttribute('aria-labelledby', h.id);
    }
  }
  var active = document.activeElement;
  if (active && !overlay.contains(active)) _modalOpeners.set(overlay, active);
  // Pages often focus a field themselves a moment after opening; only step in
  // when they did not.
  setTimeout(function() {
    if (!overlay.classList.contains('open') || overlay.contains(document.activeElement)) return;
    var items = _modalFocusables(dialog).filter(function(el) { return !el.classList.contains('modal-x-btn'); });
    var target = items[0] || dialog;
    if (target === dialog) dialog.setAttribute('tabindex', '-1');
    target.focus();
  }, 120);
}

function _onModalClose(overlay) {
  var opener = _modalOpeners.get(overlay);
  _modalOpeners.delete(overlay);
  var active = document.activeElement;
  if (opener && opener.isConnected && (!active || active === document.body || overlay.contains(active))) opener.focus();
}

// The arrangement editor has its own overlay class but behaves the same.
var _MODAL_CLASSES = ['modal-overlay', 'arr-modal-overlay'];

function _topModal() {
  var open = document.querySelectorAll('.modal-overlay.open, .arr-modal-overlay.open');
  return open.length ? open[open.length - 1] : null;
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined' && !window._modalDialogsInit) {
  window._modalDialogsInit = true;
  new MutationObserver(function(muts) {
    muts.forEach(function(m) {
      var el = m.target;
      if (!el.classList || !_MODAL_CLASSES.some(function(c) { return el.classList.contains(c); })) return;
      var isOpen = el.classList.contains('open');
      var wasOpen = (' ' + (m.oldValue || '') + ' ').indexOf(' open ') >= 0;
      if (isOpen && !wasOpen) _onModalOpen(el);
      else if (!isOpen && wasOpen) _onModalClose(el);
    });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });

  document.addEventListener('keydown', function(e) {
    var overlay = _topModal();
    if (!overlay) return;
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      if (overlay.id) closeModal(overlay.id);
      else overlay.classList.remove('open');
      return;
    }
    if (e.key !== 'Tab') return;
    var items = _modalFocusables(_dialogOf(overlay));
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
