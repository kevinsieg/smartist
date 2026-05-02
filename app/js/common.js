// Shared utilities for all app pages

// Inject the shared header (nav) and footer into the page body.
// Runs immediately at script load. stage.html intentionally does not load
// common.js, so this only fires on the three navigable app pages.
(function injectShell() {
  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML =
    '<nav class="app-nav">' +
      '<a href="/" class="app-logo" aria-label="">' +
        '<img src="" alt="" class="app-logo-img">' +
      '</a>' +
      '<div class="nav-links">' +
        '<a href="/setlist">Setlist</a>' +
        '<a href="/setlist-history">History</a>' +
        '<a href="/songs">Songs</a>' +
        '<a href="/gema-import">GEMA</a>' +
      '</div>' +
    '</nav>';
  document.body.insertBefore(header, document.body.firstChild);

  const footer = document.createElement('footer');
  footer.innerHTML =
    '<p>&copy; <span id="currentYear"></span> <span class="band-name"></span></p>';
  document.body.insertBefore(footer, document.currentScript);

  document.getElementById('currentYear').textContent = new Date().getFullYear();
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

function formatLength(mins) {
  const val = mins || 4;
  const m = Math.floor(val);
  const s = Math.round((val - m) * 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Fetch /api/config with stale-while-revalidate via sessionStorage.
// First call waits for the network; subsequent calls within the same tab
// return the cached response immediately and refresh the cache in the background.
const _CONFIG_KEY = 'band_config_cache';

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
  document.querySelectorAll('.app-logo-img').forEach(img => {
    if (logoUrl) img.src = logoUrl;
    img.alt = bandName || '';
  });
  document.querySelectorAll('.app-logo').forEach(el => {
    el.setAttribute('aria-label', bandName || '');
  });

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
  const el = document.getElementById('nav-auth');
  if (!el) return;
  const authed = !!sessionStorage.getItem('setlist_token');
  if (authed) {
    el.innerHTML = `<span class="nav-auth-badge">&#10004; logged in</span>
       <button class="nav-auth-logout" onclick="doLogout()">logout</button>`;
  } else {
    el.innerHTML = '';
    if (typeof window.onNavAuthEmpty === 'function') window.onNavAuthEmpty(el);
  }
}

function doLogout() {
  sessionStorage.removeItem('setlist_token');
  updateAuthIndicator();
  if (typeof refreshAllActionBtns === 'function') refreshAllActionBtns();
}
