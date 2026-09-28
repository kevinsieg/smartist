// The app shell: header and nav, the auth indicator and menu, initPage and SPA
// navigation. Last of the four shared scripts — the injectShell and
// injectDemoBanner IIFEs at the bottom run at load and use everything the
// others define. SUPPORT_LINKS, renderSupportLinks and renderAppFooter live in
// footer.js, which every page loads before these.

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

// ── SPA navigation ─────────────────────────────────────────────────────────────
// warmPage() pre-fetches HTML and page scripts on hover/pointerdown so that
// by the time the user clicks, navigate() can swap content from cache instantly.

// The four shared scripts stay loaded across SPA navigation: running them
// again would redeclare their top-level consts and re-inject the shell.
var _SHELL_SCRIPT = /\/app\/js\/(core|session|ui|shell)\.js(\?|$)/;
function _isShellScript(el) {
  return el.tagName === 'SCRIPT' && _SHELL_SCRIPT.test(el.getAttribute('src') || '');
}

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
      if (!src || _SHELL_SCRIPT.test(src)) return;
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
      ['.app-header', 'footer', '#demo-banner']
        .map(function(s) { return document.querySelector(s); }).filter(Boolean)
        .concat(Array.from(document.body.querySelectorAll('script[src]')).filter(_isShellScript))
    );
    Array.from(document.body.children).forEach(function(el) { if (!keep.has(el)) el.remove(); });

    const footer = document.querySelector('footer');
    const newNodes = Array.from(newDoc.body.children).filter(function(el) {
      return !_isShellScript(el);
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

// Inject the shared header (nav) and footer into the page body.
// Runs immediately at script load. stage.html intentionally does not load
// shell.js, so this only fires on the app pages.
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
