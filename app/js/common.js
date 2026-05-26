// Shared utilities for all app pages

function getInitials(name) {
  if (!name) return '?';
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Inject the shared header (nav) and footer into the page body.
// Runs immediately at script load. stage.html intentionally does not load
// common.js, so this only fires on the three navigable app pages.
(function injectShell() {
  // Start invisible — first paint will be at opacity 0, then we fade in.
  // This prevents the header/content flash on every page navigation.
  document.documentElement.style.opacity = '0';

  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML =
    '<nav class="app-nav">' +
      '<a href="/" class="app-logo" aria-label="">' +
        '<img src="" alt="" class="app-logo-img">' +
        '<span class="app-logo-initials" aria-hidden="true"></span>' +
        '<span class="band-name"></span>' +
      '</a>' +
      '<div class="nav-links">' +
        '<a href="/setlist">Setlists</a>' +
        '<a href="/gigs">Gigs</a>' +
        '<a href="/venues">Venues</a>' +
        '<a href="/organizers">Organizers</a>' +
        '<a href="/songs">Songs</a>' +
        '<a href="/gema-import">PRO</a>' +
        '<a href="/hub">Hub</a>' +
        '<a href="/profile">Profile</a>' +
      '</div>' +
    '</nav>';
  document.body.insertBefore(header, document.body.firstChild);

  const footer = document.createElement('footer');
  footer.innerHTML =
    '<p>&copy; <span id="currentYear"></span> <span class="band-name"></span></p>';
  document.body.insertBefore(footer, document.currentScript);

  document.getElementById('currentYear').textContent = new Date().getFullYear();

  // Apply cached config before first paint so header renders complete on load.
  try {
    const cached = JSON.parse(sessionStorage.getItem('artist_config_cache'));
    if (cached) {
      document.querySelectorAll('.band-name').forEach(el => { el.textContent = cached.name || ''; });
      const _initials = getInitials(cached.name);
      document.querySelectorAll('.app-logo-initials').forEach(el => { el.textContent = _initials; });
      if (cached.config?.logoUrl) {
        document.querySelectorAll('.app-logo-img').forEach(img => {
          img.src = cached.config.logoUrl; img.alt = cached.name || '';
          img.onerror = function() { this.style.display = 'none'; const s = this.nextElementSibling; if (s) s.classList.add('app-logo-initials--show'); };
        });
        document.querySelectorAll('.app-logo').forEach(el => { el.setAttribute('aria-label', cached.name || ''); });
      } else {
        document.querySelectorAll('.app-logo-initials').forEach(el => el.classList.add('app-logo-initials--show'));
      }
      const path = window.location.pathname.replace(/\/+$/, '');
      document.querySelectorAll('.nav-links a').forEach(a => {
        a.classList.toggle('current', a.getAttribute('href').replace(/\/+$/, '') === path);
      });
      if (cached.name && document.title && !document.title.includes(cached.name)) {
        document.title = document.title + ' — ' + cached.name;
      }
    }
  } catch {}

  // Fade in once the DOM is fully parsed.
  window.addEventListener('DOMContentLoaded', function() {
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        document.documentElement.style.opacity = '1';
      });
    });
  });

  // SPA navigation — swap page content without reloading the shell.
  document.addEventListener('click', function(e) {
    if (e.target.closest('.nav-auth-login, .go-login')) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      goToLogin();
      return;
    }
    var a = e.target.closest('.nav-links a');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.href === window.location.href) return;
    e.preventDefault();
    navigate(a.href);
  });

  // Warm (fetch HTML + prefetch scripts) on hover and pointerdown.
  document.addEventListener('pointerdown', function(e) {
    var a = e.target.closest('.nav-links a');
    if (a) warmPage(a.href);
  });
  document.querySelectorAll('.nav-links a').forEach(function(a) {
    a.addEventListener('mouseenter', function() { warmPage(a.href); }, { once: true });
  });
})();

(function injectDemoBanner() {
  var demoName = sessionStorage.getItem('demo_name');
  if (!demoName) return;
  var genres = [];
  try { genres = JSON.parse(sessionStorage.getItem('demo_genres') || '[]'); } catch {}
  var sub = genres.length ? genres.slice(0, 3).join(', ') : 'live demo workspace';
  var initials = demoName.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  var bar = document.createElement('div');
  bar.id = 'demo-banner';
  bar.style.cssText = 'background:#2e2e2e;color:#aaa;font-family:"Courier New",monospace;font-size:0.68rem;letter-spacing:0.06em;padding:8px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #444;';
  bar.innerHTML =
    '<span style="display:flex;align-items:center;gap:10px;">' +
    '<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;background:#b06a2a;color:#f5f0ea;font-weight:700;font-size:0.7rem;letter-spacing:0.05em;border-radius:2px;flex-shrink:0;">' + escHtml(initials) + '</span>' +
    '<span><strong style="color:#f9bf8f">' + escHtml(demoName) + '</strong>' +
    ' &mdash; live demo workspace' +
    (genres.length ? ' · <span style="color:#666">' + escHtml(sub) + '</span>' : '') +
    '</span></span>' +
    '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:#555;font-size:1.1rem;cursor:pointer;line-height:1;padding:0 2px;flex-shrink:0;" aria-label="Dismiss">&times;</button>';
  var header = document.querySelector('.app-header');
  if (header) header.insertAdjacentElement('afterend', bar);
})();

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A4 at 14mm/16mm margins ≈ 757pt usable height.
// Subtract: header ~52pt, h2 ~14pt, gaps ~10pt → ~681pt for songs.
// Each row: title line (f*1.35) + meta line (f*0.65*1.1) + border/padding (~4pt)
//   ≈ f*2.065 + 4  →  f = (available/n - 4) / 2.065
function calcPrintFontSize(songCount) {
  const n = Math.max(1, songCount);
  return Math.min(18, Math.max(7, Math.floor((681 / n - 4) / 2.065)));
}

function formatKey(key) {
  if (!key) return key;
  return key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
}

// columns: Array<{ label: string, getValue: (row) => string }>
function exportTableCsv(rows, columns, filename) {
  function cell(val) {
    var s = (val === null || val === undefined) ? '' : String(val);
    if (s.indexOf('"') >= 0 || s.indexOf(',') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  var header = columns.map(function(c) { return cell(c.label); }).join(',');
  var body = rows.map(function(row) {
    return columns.map(function(c) { return cell(c.getValue(row)); }).join(',');
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

function printSetlistSongs(songs, title, cfg) {
  var area = document.getElementById('print-area');
  if (!area) return;

  var logoEl = document.querySelector('#print-header .app-logo-img');
  if (logoEl) {
    var logoUrl = cfg && cfg.config && cfg.config.logoUrl;
    if (logoUrl) {
      logoEl.src = logoUrl;
      logoEl.alt = (cfg && cfg.name) || '';
      logoEl.style.display = '';
    } else {
      logoEl.style.display = 'none';
    }
  }

  var now = new Date();
  var date = now.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  var time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  var tsEl = document.getElementById('print-timestamp');
  if (tsEl) tsEl.textContent = date + ' — ' + time;

  var items = songs.map(function(song, i) {
    var span = function(v, field, ttl) {
      return v ? '<span data-field="' + escHtml(field) + '" title="' + escHtml(ttl) + '">' + escHtml(v) + '</span>' : '';
    };
    var banjo = song.extra && song.extra.banjoCapo != null ? String(song.extra.banjoCapo) : null;
    var git   = song.extra && song.extra.gitCapo   != null ? String(song.extra.gitCapo)   : null;
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
      song.extra && song.extra.git2 ? span('guitar 2',  'extra.git2', 'Second guitar') : ''
    ].filter(Boolean).join('');
    var printLabels = song.genre ? '<span>' + escHtml(song.genre) + '</span>' : '';

    return '<li class="song-item">' +
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

  var size = calcPrintFontSize(songs.length);
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

function formatLength(mins) {
  const val = mins || 4;
  const m = Math.floor(val);
  const s = Math.round((val - m) * 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Fetch /api/config with stale-while-revalidate via sessionStorage.
// First call waits for the network; subsequent calls within the same tab
// return the cached response immediately and refresh the cache in the background.
const _CONFIG_KEY    = 'artist_config_cache';
const AUTH_TOKEN_KEY = 'smartist_token';

function isViewMode() {
  return !sessionStorage.getItem(AUTH_TOKEN_KEY);
}

// Disable all write-action buttons currently in the DOM.
// Pages that render buttons dynamically should also check isViewMode()
// in their render functions and add the disabled attribute there.
function applyViewMode() {
  document.querySelectorAll('button.auth-action, input.auth-action').forEach(function(el) {
    el.disabled = true;
    el.title = 'Login required';
  });
  document.querySelectorAll('.auth-only').forEach(function(el) {
    el.style.display = 'none';
  });
}

async function loadConfig() {
  let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(_CONFIG_KEY)); } catch {}

  const fetchFresh = fetch('/api/config')
    .then(r => { if (!r.ok) throw new Error('config unavailable'); return r.json(); })
    .then(cfg => {
      try { sessionStorage.setItem(_CONFIG_KEY, JSON.stringify(cfg)); } catch {}
      return cfg;
    });

  if (cached) {
    fetchFresh.catch(() => {}); // refresh in background, suppress errors
    return cached;
  }
  return fetchFresh;
}

// Populate band name in header + footer, highlight current nav link.
// Called by each page's init() after loading config.
function applyNav(bandName, bandConfig) {
  const els = document.querySelectorAll('.band-name');
  els.forEach(el => { el.textContent = bandName || ''; });

  const logoUrl = bandConfig?.logoUrl;
  const initials = getInitials(bandName);
  document.querySelectorAll('.app-logo-initials').forEach(el => { el.textContent = initials; });
  document.querySelectorAll('.app-logo-img').forEach(img => {
    img.alt = bandName || '';
    const initialsEl = img.nextElementSibling;
    if (logoUrl) {
      img.src = logoUrl;
      img.style.display = '';
      img.onerror = function() {
        this.style.display = 'none';
        const s = this.nextElementSibling;
        if (s) s.classList.add('app-logo-initials--show');
      };
      if (initialsEl) initialsEl.classList.remove('app-logo-initials--show');
    } else {
      img.src = '';
      if (initialsEl) initialsEl.classList.add('app-logo-initials--show');
    }
  });
  document.querySelectorAll('.app-logo').forEach(el => {
    el.setAttribute('aria-label', bandName || '');
  });

  if (bandName && document.title && !document.title.includes(bandName)) {
    document.title = `${document.title} — ${bandName}`;
  }

  const path = window.location.pathname.replace(/\/+$/, '');
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href').replace(/\/+$/, '');
    a.classList.toggle('current', href === path);
  });

  // Auth indicator — inject once into nav if not already present
  const nav = document.querySelector('.app-nav');
  if (nav && !document.getElementById('nav-auth')) {
    const el = document.createElement('div');
    el.id = 'nav-auth';
    el.className = 'nav-auth';
    nav.appendChild(el);
  }
  updateAuthIndicator();
}

function loginPageUrl() {
  var next = window.location.pathname + window.location.search;
  return '/?next=' + encodeURIComponent(next);
}

function goToLogin() {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  window.location.assign(loginPageUrl());
}

function updateAuthIndicator() {
  var el = document.getElementById('nav-auth');
  if (!el) return;
  var authed = !!sessionStorage.getItem(AUTH_TOKEN_KEY);
  var header = document.querySelector('.app-header');
  if (header) header.classList.toggle('app-header--authed', authed);
  if (authed) {
    el.innerHTML = '<span class="nav-auth-badge">&#10004; logged in</span>' +
      '<button class="nav-auth-logout" onclick="doLogout()">logout</button>';
  } else {
    var onLanding = window.location.pathname === '/' || window.location.pathname === '';
    if (onLanding) {
      el.innerHTML = '';
    } else {
      el.innerHTML = '<a class="nav-auth-login nav-auth-login--vm go-login" href="' +
        loginPageUrl() + '">Login &#8594;</a>';
    }
    if (typeof window.onNavAuthEmpty === 'function') window.onNavAuthEmpty(el);
  }
}

function doLogout() {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  updateAuthIndicator();
  if (typeof refreshAllActionBtns === 'function') refreshAllActionBtns();
}

// Redirect to the login page if there is no session token. Returns true when a
// redirect was triggered so callers can bail out early (e.g. initPage).
function requireLogin() {
  if (!sessionStorage.getItem(AUTH_TOKEN_KEY)) {
    goToLogin();
    return true;
  }
  return false;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function getToken() { return sessionStorage.getItem(AUTH_TOKEN_KEY); }

// Authenticated fetch. Adds the auth header when a token exists. On 401 clears
// the token and redirects to login (then throws so callers abort cleanly).
async function apiFetch(url, method = 'GET', body) {
  const opts = { method, headers: {} };
  const token = getToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (r.status === 401) {
    if (!isViewMode()) {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      requireLogin();
    }
    throw new Error('Session expired');
  }
  return r;
}

// Standard page bootstrap: config → nav → page-specific callback.
// Does NOT require login — pages render in view mode when no token is present.
async function initPage(onReady) {
  try {
    var cfg = await loadConfig();
    applyNav(cfg.name, cfg.config);
    var viewMode = isViewMode();
    if (viewMode) document.body.classList.add('view-mode');
    await onReady(cfg, viewMode);
  } catch (e) { console.error(e); }
}

// Set a status element's text and error styling.
function setStatus(elementId, msg, isError = false) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-msg' + (isError ? ' error' : '');
}

// Generic modal open/close by element ID.
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

// Force the next loadConfig() call to fetch fresh data from the network.
function invalidateConfigCache() {
  try { sessionStorage.removeItem(_CONFIG_KEY); } catch {}
}

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
    defaultSortDir = 1, rowClass, onRowClick, emptyHint, separateDeleted = false }) {

  let _data = [];
  let _sortField = defaultSort ?? null;
  let _sortDir = defaultSortDir;

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

  function _cellHtml(col, row) {
    if (col.render) {
      const cls = col.actions ? 'sl-cell sl-cell--actions' : 'sl-cell';
      return `<div class="${cls}">${col.render(row)}</div>`;
    }
    let val;
    if      (col.type === 'number') val = row[col.field] != null ? Number(row[col.field]).toLocaleString() : '';
    else if (col.type === 'date')   val = row[col.field] ? String(row[col.field]).slice(0, 10) : '—';
    else                            val = escHtml((row[col.field] ?? '').toString());
    const cls = col.muted ? 'sl-cell sl-cell--muted' : 'sl-cell';
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
      return `<div class="${cls}" style="grid-template-columns:${colWidths}" data-id="${row.id}">${cells}</div>`;
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

  function open(filtered) {
    close();
    if (!filtered.length && !onCreate) return;
    ul = document.createElement('ul');
    ul.className = 'typeahead-dropdown';

    filtered.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'typeahead-item';
      li.textContent = labelFn(item);
      li.addEventListener('mousedown', e => { e.preventDefault(); pick(item); });
      ul.appendChild(li);
    });

    if (onCreate) {
      const li = document.createElement('li');
      li.className = 'typeahead-item typeahead-create';
      li.textContent = `+ Create "${inputEl.value.trim()}"…`;
      li.addEventListener('mousedown', e => { e.preventDefault(); close(); onCreate(inputEl.value.trim()); });
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    activeIdx = -1;
  }

  function close() { ul?.remove(); ul = null; activeIdx = -1; }

  function pick(item) { close(); onSelect(item); }

  function highlight(idx) {
    if (!ul) return;
    const lis = ul.querySelectorAll('.typeahead-item');
    lis.forEach((li, i) => li.classList.toggle('active', i === idx));
    activeIdx = idx;
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
    if (e.key === 'Escape')     { close(); }
    if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      lis[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
    }
  });

  inputEl.addEventListener('blur', () => setTimeout(close, 150));

  return { close, updateItems(newItems) { items = newItems; } };
}

// ── SPA navigation ─────────────────────────────────────────────────────────────
// warmPage() pre-fetches HTML and page scripts on hover/pointerdown so that
// by the time the user clicks, navigate() can swap content from cache instantly.

var _navVersion = 0;
var _htmlCache  = new Map(); // href → HTML string, populated by warmPage

async function warmPage(href) {
  if (_htmlCache.has(href)) return;
  _htmlCache.set(href, null); // mark in-flight so concurrent calls skip
  try {
    const r = await fetch(href);
    if (!r.ok) { _htmlCache.delete(href); return; }
    const html = await r.text();
    _htmlCache.set(href, html);
    // Prefetch the page scripts discovered inside the HTML
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script[src]').forEach(function(s) {
      const src = s.getAttribute('src');
      if (!src || src.includes('common.js')) return;
      const abs = new URL(src, location.origin).href;
      if (document.querySelector('script[src="' + abs + '"],link[rel=prefetch][href="' + abs + '"]')) return;
      const lnk = document.createElement('link');
      lnk.rel = 'prefetch'; lnk.as = 'script'; lnk.href = abs;
      document.head.appendChild(lnk);
    });
  } catch { _htmlCache.delete(href); }
}

async function navigate(href) {
  var path = new URL(href, location.origin).pathname.replace(/\/+$/, '') || '/';
  if (path === '/') {
    goToLogin();
    return;
  }

  const version = ++_navVersion;
  document.documentElement.style.opacity = '0';

  try {
    // Use cached HTML if available (populated by warmPage on hover/pointerdown),
    // otherwise fall back to a live fetch.
    let html = _htmlCache.get(href);
    if (!html) {
      const r = await fetch(href);
      if (!r.ok || _navVersion !== version) throw new Error('fail');
      html = await r.text();
      _htmlCache.set(href, html);
    }
    if (_navVersion !== version) return;

    const newDoc = new DOMParser().parseFromString(html, 'text/html');

    // Swap page-specific <style> blocks in <head>
    document.querySelectorAll('head style').forEach(function(el) { el.remove(); });
    newDoc.querySelectorAll('head style').forEach(function(el) { document.head.appendChild(el.cloneNode(true)); });

    document.title = newDoc.title;

    // Remove page content, keep shell elements
    const keep = new Set(
      ['.app-header', 'footer', 'script[src*="common.js"]', '#demo-banner']
        .map(function(s) { return document.querySelector(s); }).filter(Boolean)
    );
    Array.from(document.body.children).forEach(function(el) { if (!keep.has(el)) el.remove(); });

    const footer = document.querySelector('footer');
    const newNodes = Array.from(newDoc.body.children).filter(function(el) {
      return !(el.tagName === 'SCRIPT' && (el.getAttribute('src') || '').includes('common.js'));
    });

    // Insert content nodes
    newNodes.forEach(function(el) {
      if (el.tagName !== 'SCRIPT') document.body.insertBefore(el.cloneNode(true), footer);
    });

    // Execute scripts sequentially (geo.js must run before page.js)
    for (const oldEl of newNodes.filter(function(el) { return el.tagName === 'SCRIPT'; })) {
      if (_navVersion !== version) return;
      await new Promise(function(resolve, reject) {
        const script = document.createElement('script');
        const src = oldEl.getAttribute('src');
        if (src) {
          script.src = new URL(src, location.origin).href;
          script.onload = resolve;
          script.onerror = reject;
        } else {
          script.textContent = oldEl.textContent;
          resolve();
        }
        document.body.insertBefore(script, footer);
      });
    }

    history.pushState(null, document.title, href);
    document.querySelectorAll('.nav-links a').forEach(function(a) {
      a.classList.toggle('current', a.getAttribute('href').replace(/\/+$/, '') === path);
    });

  } catch {
    if (_navVersion === version) window.location.href = href;
    return;
  }

  if (_navVersion !== version) return;
  requestAnimationFrame(function() { requestAnimationFrame(function() {
    document.documentElement.style.opacity = '1';
  }); });
}

window.addEventListener('popstate', function() { navigate(window.location.href); });

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
document.addEventListener('DOMContentLoaded', initPanelResize);
