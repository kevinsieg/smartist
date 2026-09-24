// Shared utilities for all app pages

const AUTH_TOKEN_KEY = 'smartist_token';

// SUPPORT_LINKS, renderSupportLinks and renderAppFooter live in footer.js,
// which every page loads before this file.
var _GLOBAL_PAGES = new Set(['login','signup','onboarding','home','workspaces','demo','impressum','contact','profile']);
// Global pages are single-segment paths; deeper paths under the same name are
// workspace routes (e.g. /demo is the demo gate, /demo/dashboard is the demo
// artist's dashboard).
var _pathParts    = window.location.pathname.split('/').filter(Boolean);
var _rawSegment   = _pathParts[0] || '';
var _artistSlug   = (_GLOBAL_PAGES.has(_rawSegment) && _pathParts.length === 1) ? '' : _rawSegment;
var _CONFIG_KEY       = 'artist_config_cache_' + (_artistSlug || 'default');
var _CONFIG_KEY_LIGHT = _CONFIG_KEY + '_light';

// Cached config for early paint / auth indicator — light or full, whichever exists.
function _readCachedConfig() {
  try {
    return JSON.parse(sessionStorage.getItem(_CONFIG_KEY_LIGHT)) ||
           JSON.parse(sessionStorage.getItem(_CONFIG_KEY));
  } catch { return null; }
}

function isLoginPage() {
  return !_artistSlug;
}

function loginPageUrl() {
  if (isLoginPage()) return '/login';
  var next = window.location.pathname + window.location.search;
  return '/login?next=' + encodeURIComponent(next);
}

function goToLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem('setlist_token');
  localStorage.removeItem(AUTH_TOKEN_KEY);
  var url = loginPageUrl();
  window.location.assign(url);
}
window.goToLogin = goToLogin;

// Share icon (same glyph as the stage view's share button, which keeps its own
// copy because stage.html deliberately does not load common.js).
var SHARE_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">' +
    '<path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>' +
    '<polyline points="16 6 12 2 8 6"/>' +
    '<line x1="12" y1="2" x2="12" y2="15"/>' +
  '</svg>';

function getInitials(name) {
  if (!name) return '?';
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Nav href → plan feature key. Used to lock items the band's plan doesn't include.
var NAV_FEATURE = { '/venues': 'venues', '/organizers': 'organizers', '/pro-import': 'pro-import' };

// Toggle .plan-locked on nav items to match the plan's feature list. Called at
// page load and again after an in-place plan change (upgrade with no reload).
function applyPlanNavLocks(planFeatures) {
  var feats = planFeatures || [];
  if (!feats.length) return;
  document.querySelectorAll('.nav-links a').forEach(function(_navA) {
    var _navHref = _navA.getAttribute('href') || '';
    var _navKey = Object.keys(NAV_FEATURE).find(function(_p) { return _navHref.endsWith(_p); });
    if (!_navKey) return;
    _navA.classList.toggle('plan-locked', feats.indexOf(NAV_FEATURE[_navKey]) === -1);
  });
}

// Inject the shared header (nav) and footer into the page body.
// Runs immediately at script load. stage.html intentionally does not load
// common.js, so this only fires on the three navigable app pages.
(function injectShell() {
  // Start invisible — first paint will be at opacity 0, then we fade in.
  // This prevents the header/content flash on every page navigation.
  document.documentElement.style.opacity = '0';

  var _base = _artistSlug ? '/' + _artistSlug : '';

  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML =
    '<nav class="app-nav">' +
      // No workspace in the URL means we are outside the app (login, root
      // contact page): the way back is the marketing site, not a band.
      (_artistSlug
        ? '<a href="/" class="app-logo" aria-label="">' +
            '<img src="" alt="" class="app-logo-img">' +
            '<span class="app-logo-initials" aria-hidden="true"></span>' +
            '<span class="band-name"></span>' +
          '</a>'
        : '<a href="https://smartist.studio" class="app-studio-wordmark">smartist studio</a>') +
      '<div class="nav-links">' +
        (_artistSlug ? (
          '<a href="' + _base + '/songs" data-i18n="nav.songs">Songs</a>' +
          '<a href="' + _base + '/setlist" data-i18n="nav.setlists">Setlists</a>' +
          '<a href="' + _base + '/gigs" data-i18n="nav.gigs">Gigs</a>' +
          '<div class="nav-more">' +
            '<a href="#" class="nav-more-toggle" id="nav-more-toggle" aria-expanded="false"><span data-i18n="nav.more">More</span> &#9662;</a>' +
            '<div class="nav-more-menu" id="nav-more-menu">' +
              '<a href="' + _base + '/venues" data-i18n="nav.venues">Venues</a>' +
              '<a href="' + _base + '/organizers" class="auth-only" data-i18n="nav.organizers">Organizers</a>' +
              '<a href="' + _base + '/hub" data-i18n="nav.hub">Hub</a>' +
              '<a href="' + _base + '/pro-import" class="auth-only" data-i18n="nav.pro">PRO</a>' +
              '<a href="' + _base + '/settings" class="admin-only" data-i18n="nav.settings">Settings</a>' +
            '</div>' +
          '</div>'
        ) : '') +
        '<a href="/signup" class="nav-links-signup"><span data-i18n="nav.signup">Sign up</span> &#8594;</a>' +
        '<a href="#" class="nav-links-login go-login" id="nav-links-login" data-i18n="nav.login">Login</a>' +
        (_artistSlug ? '<a href="' + _base + '/profile" class="nav-links-profile" id="nav-links-profile" data-i18n="nav.profile">Profile</a>' : '') +
        '<a href="#" class="nav-links-logout" id="nav-links-logout" data-i18n="nav.logout">Logout</a>' +
      '</div>' +
      '<button class="nav-burger" id="nav-burger" aria-label="Open menu" aria-expanded="false" data-i18n-attr="aria-label:nav.openMenu">' +
        '<svg class="nav-burger-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
        '<svg class="nav-close-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>' +
    '</nav>';
  document.body.insertBefore(header, document.body.firstChild);

  const footer = document.createElement('footer');
  document.body.insertBefore(footer, document.currentScript);
  renderAppFooter(footer);

  // Set auth class early so CSS hides/shows auth-gated nav items before applyNav() runs.
  try {
    const _earlyTok = sessionStorage.getItem(AUTH_TOKEN_KEY);
    if (_earlyTok && !_isTokenExpired(_earlyTok)) header.classList.add('app-header--authed');
  } catch {}

  // Apply cached config before first paint so header renders complete on load.
  try {
    const cached = _readCachedConfig();
    if (cached) {
      document.querySelectorAll('.band-name').forEach(el => { el.textContent = cached.name || ''; });
      const _initials = getInitials(cached.name);
      document.querySelectorAll('.app-logo-initials').forEach(el => { el.textContent = _initials; });
      if (cached.config?.logoUrl) {
        document.querySelectorAll('.app-logo-img').forEach(img => {
          img.src = cached.config.logoUrl.replace(/^http:/i, 'https:'); img.alt = cached.name || '';
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
        document.title = document.title + ' · ' + cached.name;
      }
    }
  } catch {}

  // Fade in once the DOM is fully parsed (and translations are applied, if i18n loaded).
  window.addEventListener('DOMContentLoaded', function() {
    (window.i18n && window.i18n.ready ? window.i18n.ready : Promise.resolve()).then(function() {
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          document.documentElement.style.opacity = '1';
        });
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
    if (e.target.closest('#nav-links-logout')) {
      e.preventDefault();
      doLogout();
      return;
    }
    // "More" dropdown toggle
    if (e.target.closest('#nav-more-toggle')) {
      e.preventDefault();
      var moreEl = document.querySelector('.nav-more');
      var moreOpen = moreEl.classList.toggle('nav-more-open');
      document.getElementById('nav-more-toggle').setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
      // Top edge sits on the nav bar's bottom border (same line as the auth menu).
      var moreMenuEl = document.getElementById('nav-more-menu');
      var hdrEl = document.querySelector('.app-header');
      if (moreOpen && moreMenuEl && hdrEl) {
        moreMenuEl.style.top = (hdrEl.getBoundingClientRect().bottom - moreEl.getBoundingClientRect().top) + 'px';
      }
      return;
    }
    if (!e.target.closest('.nav-more')) {
      var openMore = document.querySelector('.nav-more.nav-more-open');
      if (openMore) {
        openMore.classList.remove('nav-more-open');
        document.getElementById('nav-more-toggle').setAttribute('aria-expanded', 'false');
      }
    }
    // Burger toggle
    if (e.target.closest('#nav-burger')) {
      var appHdr = document.querySelector('.app-header');
      var isOpen = appHdr.classList.toggle('nav-open');
      var bgr = document.getElementById('nav-burger');
      if (bgr) bgr.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      return;
    }
    // Close menu on outside click
    if (!e.target.closest('.app-header')) {
      var openHdr = document.querySelector('.app-header.nav-open');
      if (openHdr) {
        openHdr.classList.remove('nav-open');
        var bgr2 = document.getElementById('nav-burger');
        if (bgr2) bgr2.setAttribute('aria-expanded', 'false');
      }
    }
    // Plan-locked nav item → redirect to settings#plan
    var _lockedEl = e.target.closest('.plan-locked');
    if (_lockedEl) {
      e.preventDefault();
      var _lockedHref = _lockedEl.getAttribute('href') || '';
      var _lockedBase = _lockedHref.replace(/\/(venues|organizers|pro-import).*$/, '');
      window.location.href = _lockedBase + '/settings#plan';
      return;
    }
    // SPA nav link
    var a = e.target.closest('.nav-links a');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.href === window.location.href) return;
    e.preventDefault();
    // Close burger menu and More dropdown before navigating
    var navHdr = document.querySelector('.app-header');
    if (navHdr) navHdr.classList.remove('nav-open');
    var bgr3 = document.getElementById('nav-burger');
    if (bgr3) bgr3.setAttribute('aria-expanded', 'false');
    var moreHdr = document.querySelector('.nav-more.nav-more-open');
    if (moreHdr) {
      moreHdr.classList.remove('nav-more-open');
      var moreToggle = document.getElementById('nav-more-toggle');
      if (moreToggle) moreToggle.setAttribute('aria-expanded', 'false');
    }
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
  var ready = (window.i18n && window.i18n.ready) ? window.i18n.ready : Promise.resolve();
  ready.then(function() {
    var genres = [];
    try { genres = JSON.parse(sessionStorage.getItem('demo_genres') || '[]'); } catch {}
    var sub = genres.length ? genres.slice(0, 3).join(', ') : t('demo.bannerLiveWorkspace');
    var initials = demoName.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
    var bar = document.createElement('div');
    bar.id = 'demo-banner';
    bar.style.cssText = 'background:#2e2e2e;color:#aaa;font-family:"Courier New",monospace;font-size:0.68rem;letter-spacing:0.06em;padding:8px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #444;';
    bar.innerHTML =
      '<span style="display:flex;align-items:center;gap:10px;">' +
      '<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;background:#b06a2a;color:#f5f0ea;font-weight:700;font-size:0.7rem;letter-spacing:0.05em;border-radius:2px;flex-shrink:0;">' + escHtml(initials) + '</span>' +
      '<span><strong style="color:#f9bf8f">' + escHtml(demoName) + '</strong>' +
      ' &mdash; ' + t('demo.bannerLiveWorkspace') +
      (genres.length ? ' · <span style="color:#666">' + escHtml(sub) + '</span>' : '') +
      '</span></span>' +
      '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:#555;font-size:1.1rem;cursor:pointer;line-height:1;padding:0 2px;flex-shrink:0;" aria-label="' + t('demo.bannerDismiss') + '">&times;</button>';
    var header = document.querySelector('.app-header');
    if (header) header.insertAdjacentElement('afterend', bar);
  });
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

// Token format: base64url({"exp":unixsecs}.hexsig) — readable without the HMAC secret.
// Passwords are also stored here (plain text, non-expiring client-side).
// Only return true when we can positively identify an expired magic token.
function _isTokenExpired(token) {
  try {
    var b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    var pad = b64.length % 4;
    if (pad) b64 += '===='.slice(pad);
    var decoded = atob(b64);
    var dotIdx = decoded.indexOf('.');
    if (dotIdx < 1) return false;                           // not magic-token format
    var parsed = JSON.parse(decoded.slice(0, dotIdx));
    if (!parsed.exp) return false;                          // no exp → not a magic token
    return Math.floor(Date.now() / 1000) >= parsed.exp;
  } catch (_) { return false; }                            // unparseable → plain password
}

// Full locale tag for Intl. English uses en-GB so dates stay day-first like the rest.
function localeTag() {
  var locale = (window.i18n && window.i18n.getLocale) ? window.i18n.getLocale() : 'en';
  return { de: 'de-DE', fr: 'fr-FR', en: 'en-GB' }[locale] || 'en-GB';
}

// Every date in the interface goes through here — no page formats its own.
//   default  22.01.2026 (de)   22/01/26 (en, fr)
//   'short'  22.01.     (de)   22/01    (en, fr)
//   'long'   22. Januar 2026 / 22 January 2026 / 22 janvier 2026
// Accepts a date string or a full timestamp; anything unparseable renders as empty
// rather than "Invalid Date".
function formatDate(value, style) {
  if (!value) return '';
  var d = new Date(value);
  if (isNaN(d.getTime())) return '';
  var tag = localeTag();
  if (style === 'long') {
    return d.toLocaleDateString(tag, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  // UTC accessors: the API sends date columns as UTC midnight, and local getters would
  // move them to the previous day for anyone behind UTC.
  var day   = String(d.getUTCDate()).padStart(2, '0');
  var month = String(d.getUTCMonth() + 1).padStart(2, '0');
  var year  = String(d.getUTCFullYear());
  var german = tag === 'de-DE';
  if (style === 'short') return german ? day + '.' + month + '.' : day + '/' + month;
  return german ? day + '.' + month + '.' + year : day + '/' + month + '/' + year.slice(2);
}

// 24-hour clock in every language — the app shows set times, not wall-clock chat.
function formatTime(value) {
  if (!value) return '';
  var d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Energy is stored as free text: 1–10 from the imported database, or a word like "Fast".
// Numbers read better as three bands; words are shown as they are. Display only — the
// stored value is untouched, and setlist.js still scores on the exact number.
function energyLabel(value) {
  var raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  var n = Number(raw);
  if (!isFinite(n) || raw === '') return raw;
  if (n <= 3) return t('songs.energyLow');
  if (n <= 7) return t('songs.energyMiddle');
  return t('songs.energyHigh');
}

// Narrow viewport: table-style editing is desktop-only (songs bulk edit, venues bulk edit).
function isMobile() { return window.innerWidth <= 1024; }

function isViewMode() {
  var token = getToken();
  if (!token) return true;
  if (_isTokenExpired(token)) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    return true;
  }
  return false;
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

// Only http(s) URLs are safe to interpolate into href — anything else
// (javascript:, data:, …) is replaced so stored values can't run script.
function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : '#';
}

function skeletonHtml(lines) {
  var widths = [75, 55, 65, 45, 80];
  var html = '<div class="skeleton-block">';
  for (var i = 0; i < (lines || 3); i++) {
    html += '<div class="skeleton-line" style="width:' + widths[i % widths.length] + '%"></div>';
  }
  return html + '</div>';
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

// opts.light skips the songs payload — use it on pages that only need
// name/config/counts. Light and full responses are cached under separate keys.
async function loadConfig(slugOverride, opts) {
  var slug  = (slugOverride !== undefined) ? slugOverride : _artistSlug;
  var light = !!(opts && opts.light);
  var key   = 'artist_config_cache_' + (slug || 'default') + (light ? '_light' : '');
  let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(key)); } catch {}

  var params = [];
  if (slug)  params.push('slug=' + encodeURIComponent(slug));
  if (light) params.push('light=1');
  var url = '/api/config' + (params.length ? '?' + params.join('&') : '');
  // Send the token when present — private workspaces only serve full config
  // (songs, counts) to authenticated members.
  var _cfgToken = getToken();
  const fetchFresh = fetch(url, _cfgToken ? { headers: { Authorization: 'Bearer ' + _cfgToken } } : undefined)
    .then(r => { if (!r.ok) throw new Error('config unavailable'); return r.json(); })
    .then(cfg => {
      try { sessionStorage.setItem(key, JSON.stringify(cfg)); } catch {}
      return cfg;
    });

  if (cached) {
    fetchFresh.catch(() => {});
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
      img.src = logoUrl.replace(/^http:/i, 'https:');
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

  const faviconUrl = bandConfig?.faviconUrl;
  if (faviconUrl) {
    document.querySelectorAll('link[rel="icon"]').forEach(function(el) {
      el.href = faviconUrl;
    });
  }

  if (bandName && document.title && !document.title.includes(bandName)) {
    document.title = `${document.title} · ${bandName}`;
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

function updateAuthIndicator() {
  var el = document.getElementById('nav-auth');
  if (!el) return;
  var _tok = getToken();
  if (_tok && _isTokenExpired(_tok)) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    _tok = null;
  }
  var authed = !!_tok;
  var _role  = authed ? getAuthRole() : null;
  var header = document.querySelector('.app-header');
  if (header) {
    header.classList.toggle('app-header--authed', authed);
    header.classList.toggle('app-header--admin',  authed && (_role === 'admin' || _role === null));
  }
  var _logoBase = _artistSlug ? '/' + _artistSlug : '';
  document.querySelectorAll('.app-logo').forEach(function(a) {
    a.href = authed ? (_logoBase + '/dashboard') : loginPageUrl();
  });
  if (authed) {
    var _email = sessionStorage.getItem('smartist_admin_email') || '';
    var _photoUrl = '', _initials = '';
    try {
      var _cachedCfg = _readCachedConfig() || {};
      _photoUrl = ((_cachedCfg.config && _cachedCfg.config.logoUrl) || '').replace(/^http:/i, 'https:');
      _initials = getInitials(_cachedCfg.name || '');
    } catch {}
    var _avatarHtml = _photoUrl
      ? '<img class="nav-auth-avatar-img" src="' + escHtml(_photoUrl) + '" alt="">'
      : '<span class="nav-auth-avatar-mono">' + escHtml(_initials || '&#10004;') + '</span>';
    var _emailHtml = _email ? '<span class="nav-auth-email">' + escHtml(_email) + '</span>' : '';
    el.innerHTML = '<button class="nav-auth-btn" id="nav-auth-btn" onclick="_openAuthMenu(this)" aria-haspopup="true" aria-label="' + t('nav.accountMenu') + '">' +
      _avatarHtml + _emailHtml +
    '</button>';
  } else {
    if (isLoginPage()) {
      el.innerHTML = '';
    } else {
      el.innerHTML =
        '<div class="nav-auth-vm">' +
          '<a class="nav-auth-signup" href="/signup">' + t('nav.signup') + '</a>' +
          '<a class="nav-auth-login nav-auth-login--vm go-login" href="' + loginPageUrl() + '">' + t('nav.login') + '</a>' +
        '</div>';
      var _nlLogin = document.getElementById('nav-links-login');
      if (_nlLogin) _nlLogin.href = loginPageUrl();
    }
    if (typeof window.onNavAuthEmpty === 'function') window.onNavAuthEmpty(el);
  }
}

// Logging out has to leave the page, not just restyle it. Hiding the authed
// controls left the dashboard on screen with all its data still rendered, which
// reads as "still signed in" — and on a private workspace keeps data visible
// that the session no longer entitles anyone to. The cached config goes too, so
// the next person does not inherit the previous band's name and logo.
function doLogout() {
  var _menu = document.getElementById('nav-auth-menu');
  if (_menu) _menu.remove();
  var _navH = document.querySelector('.app-header');
  if (_navH) _navH.classList.remove('nav-open');
  clearToken();
  try {
    sessionStorage.removeItem('smartist_admin_email');
    invalidateConfigCache();
  } catch (e) {}
  // No next= on the way out: a logout should not remember where it was.
  window.location.assign('/login');
}

// Go to the workspace picker. The skip-autoredirect flag stops workspaces.js
// from bouncing single-workspace users straight back into their dashboard, so
// the list (and the "New workspace" action) is always reachable.
function switchWorkspace() {
  try { sessionStorage.setItem('ws_skip_autoredirect', '1'); } catch {}
  var _menu = document.getElementById('nav-auth-menu');
  if (_menu) _menu.remove();
  window.location.assign('/workspaces');
}
window.switchWorkspace = switchWorkspace;

function _openAuthMenu(btn) {
  var existing = document.getElementById('nav-auth-menu');
  if (existing) { existing.remove(); return; }
  var _profilePath = _artistSlug ? '/' + _artistSlug + '/profile' : '/profile';
  // Switch-workspace only makes sense for real (token) logins: bootstrap
  // password sessions (role null) are bound to one fixed workspace. We don't
  // gate on singleTenant — local dev sets ARTIST_SLUG (→ singleTenant) purely
  // as a default-slug convenience while still serving multiple workspaces.
  var _showSwitch = getAuthRole() !== null;
  var menu = document.createElement('div');
  menu.id = 'nav-auth-menu';
  menu.className = 'nav-auth-menu';
  menu.innerHTML =
    '<div class="nav-auth-menu-item" onclick="navigate(\'' + _profilePath + '\');document.getElementById(\'nav-auth-menu\')&&document.getElementById(\'nav-auth-menu\').remove()">' +
      t('nav.profile') +
    '</div>' +
    (_showSwitch
      ? '<div class="nav-auth-menu-item" onclick="switchWorkspace()">' + t('nav.switchWorkspace') + '</div>'
      : '') +
    '<div class="nav-auth-menu-item" onclick="doLogout()">' +
      t('nav.logout') +
    '</div>';
  var rect = btn.getBoundingClientRect();
  // Top edge sits on the nav bar's bottom border (same line as the More dropdown).
  var _hdrEl = document.querySelector('.app-header');
  var _menuTop = _hdrEl ? _hdrEl.getBoundingClientRect().bottom : rect.bottom + 6;
  menu.style.cssText = 'position:fixed;top:' + _menuTop + 'px;right:' + (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(menu);
  var overflow = menu.getBoundingClientRect().right - (window.innerWidth - 8);
  if (overflow > 0) menu.style.right = '8px';
  function _closeAuthMenu(e) {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.remove();
      document.removeEventListener('click', _closeAuthMenu);
    }
  }
  setTimeout(function() { document.addEventListener('click', _closeAuthMenu); }, 0);
}

// Redirect to the login page if there is no session token. Returns true when a
// redirect was triggered so callers can bail out early (e.g. initPage).
function requireLogin() {
  if (!getToken()) {
    goToLogin();
    return true;
  }
  return false;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function getToken() {
  return sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || null;
}

// Remember-me keeps the token in localStorage, a normal login in sessionStorage —
// clearing one store alone leaves a half-logged-in state where actions fail silently.
function clearToken() {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem('setlist_token');
}

function getAuthRole() {
  var tok = getToken();
  if (!tok) return null;
  // The session token's role claim is only valid for the workspace it was
  // issued for. Once this workspace's config is loaded it carries the caller's
  // per-workspace role — prefer it so a user who is admin of workspace A but a
  // member of workspace B sees member UI on B. Falls back to the token claim
  // only before config has loaded (the value self-corrects on the next render).
  var cfg = _readCachedConfig();
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'role')) return cfg.role;
  try {
    var b64 = tok.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var outer = JSON.parse(atob(b64));
    if (!outer.payload) return null;
    return JSON.parse(outer.payload).role || null;
  } catch { return null; }
}

// Authenticated fetch. Adds the auth header when a token exists. On 401 clears
// the token and redirects to login (then throws so callers abort cleanly).
// my-artists answers 401 once the token's user is gone. Anything else,
// network failures included, counts as alive: never log out on a guess.
async function _sessionAlive(token) {
  try {
    const r = await fetch('/api/config?action=my-artists', { headers: { Authorization: `Bearer ${token}` } });
    return r.status !== 401;
  } catch { return true; }
}

function _endDeadSession() {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem('setlist_token');
  localStorage.removeItem(AUTH_TOKEN_KEY);
  invalidateConfigCache();
  window.location.replace('/login');
}

async function apiFetch(url, method = 'GET', body) {
  const opts = { method, headers: {} };
  const token = getToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  // A 404 while logged in is either a real miss or a workspace that no longer
  // exists (account deleted in another tab or device). Only the second one is
  // worth leaving the page for, so ask once whether the session still stands.
  if (r.status === 404 && token && !(await _sessionAlive(token))) {
    _endDeadSession();
    throw new Error('Session expired');
  }
  if (r.status === 401) {
    if (!isViewMode()) {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
      requireLogin();
    }
    throw new Error('Session expired');
  }
  return r;
}

// Standard page bootstrap: config → nav → page-specific callback.
// Requires login — unauthenticated visits redirect to login immediately.
// Config fetch failure (unknown slug, network) redirects to /workspaces.
// Loads the light config (no songs payload) unless opts.fullConfig is set.
async function initPage(onReady, opts) {
  if (isViewMode()) { goToLogin(); return; }
  // Ensure the i18n dictionary is loaded before any page renders via t().
  if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }
  var cfg;
  try {
    cfg = await loadConfig(undefined, { light: !(opts && opts.fullConfig) });
  } catch (e) {
    console.error(e);
    var tok = getToken();
    if (tok && !(await _sessionAlive(tok))) { _endDeadSession(); return; }
    // Flag stops workspaces.js from auto-redirecting straight back here.
    try { sessionStorage.setItem('ws_skip_autoredirect', '1'); } catch {}
    window.location.assign('/workspaces');
    return;
  }
  applyNav(cfg.name, cfg.config);
  // Lock nav items the band's plan doesn't include.
  applyPlanNavLocks((cfg && cfg.plan && cfg.plan.features) || []);
  document.querySelectorAll('button.auth-action, input.auth-action').forEach(function(el) {
    el.disabled = false;
  });
  try {
    await onReady(cfg);
  } catch (e) { console.error(e); }
  injectModalCloseButtons();
}

// Set a status element's text and error styling.
function setStatus(elementId, msg, isError = false) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-msg' + (isError ? ' error' : '');
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

// Force the next loadConfig() call to fetch fresh data from the network.
function invalidateConfigCache() {
  var base = 'artist_config_cache_' + (_artistSlug || 'default');
  sessionStorage.removeItem(base);
  sessionStorage.removeItem(base + '_light');
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
  // Remap bare artist-page paths to slugged paths when on a slugged page
  if (_artistSlug) {
    var _navUrl  = new URL(href, location.origin);
    var _navSeg  = _navUrl.pathname.split('/').filter(Boolean)[0] || '';
    if (!_GLOBAL_PAGES.has(_navSeg) && !_navUrl.pathname.startsWith('/' + _artistSlug + '/')) {
      _navUrl.pathname = '/' + _artistSlug + _navUrl.pathname;
      href = _navUrl.pathname + _navUrl.search + _navUrl.hash;
    }
  }

  var path = new URL(href, location.origin).pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/login') {
    goToLogin();
    return;
  }

  // Clear any opacity left stuck by a previously interrupted navigation.
  document.documentElement.style.opacity = '';

  const version = ++_navVersion;
  // Fade out only the page content — nav and footer stay visible.
  // Never fade documentElement: if interrupted, opacity stays 0 causing a white screen.
  var _navFadeEl = document.querySelector('main');
  if (_navFadeEl) _navFadeEl.style.opacity = '0';

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

    // Insert content nodes (new <main> starts invisible so we can fade it in)
    newNodes.forEach(function(el) {
      if (el.tagName !== 'SCRIPT') {
        var clone = el.cloneNode(true);
        if (clone.tagName === 'MAIN') clone.style.opacity = '0';
        document.body.insertBefore(clone, footer);
      }
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

    // i18n.ready resolved on the first load; swapped-in markup needs its own pass.
    if (window.i18n && window.i18n.applyTranslations) window.i18n.applyTranslations(document);

    history.pushState(null, document.title, href);
    document.querySelectorAll('.nav-links a').forEach(function(a) {
      a.classList.toggle('current', a.getAttribute('href').replace(/\/+$/, '') === path);
    });
    if (typeof updateAuthIndicator === 'function') updateAuthIndicator();

  } catch {
    if (_navVersion === version) window.location.href = href;
    return;
  }

  if (_navVersion !== version) return;
  requestAnimationFrame(function() { requestAnimationFrame(function() {
    var fadeIn = document.querySelector('main');
    if (fadeIn) fadeIn.style.opacity = '1';
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
    '<button class="btn active" type="button" id="hd-confirm-btn" style="background:#e55;" onclick="confirmHardDelete()">' + t('common.deletePermanently') + '</button>' +
    '<button class="btn" type="button" onclick="closeModal(\'hard-delete-modal\')">' + t('common.cancel') + '</button>' +
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
