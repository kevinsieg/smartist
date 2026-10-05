// i18n core + browser runtime. UMD: pure functions exported for Node tests;
// browser glue runs only when a DOM is present.
(function () {
  var SUPPORTED_LOCALES = ['en', 'fr', 'de'];
  var DEFAULT_LOCALE = 'en';
  var I18N_VERSION = 61;

  function resolveLocale(stored, navLangs, supported, def) {
    supported = supported || SUPPORTED_LOCALES;
    def = def || DEFAULT_LOCALE;
    if (stored && supported.indexOf(stored) !== -1) return stored;
    var langs = navLangs || [];
    for (var i = 0; i < langs.length; i++) {
      var primary = String(langs[i] || '').split('-')[0].toLowerCase();
      if (supported.indexOf(primary) !== -1) return primary;
    }
    return def;
  }

  function translate(dict, key, vars) {
    var raw = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
    if (raw == null) return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m;
    });
  }

  function readCachedDict(raw, version) {
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.v === version && parsed.dict) return parsed.dict;
      return null;
    } catch (e) {
      return null;
    }
  }

  var api = {
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    I18N_VERSION: I18N_VERSION,
    resolveLocale: resolveLocale,
    translate: translate,
    readCachedDict: readCachedDict,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (typeof document === 'undefined') return;

  var STORE_KEY = 'smartist_lang';
  var locale = resolveLocale(
    (function () { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } })(),
    navigator.languages || (navigator.language ? [navigator.language] : [])
  );
  document.documentElement.lang = locale;
  if (locale !== 'en') document.documentElement.style.opacity = '0';

  var DICT_KEY = 'smartist_i18n_' + locale;
  function readLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  // Prime synchronously from the localStorage cache (all locales incl. en) so
  // t() returns correct strings before page scripts run on repeat visits.
  var dict = readCachedDict(readLS(DICT_KEY), I18N_VERSION) || null;

  function getLocale() { return locale; }
  function t(key, vars) { return translate(dict, key, vars); }

  function applyTranslations(root) {
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var bits = pair.split(':');
        if (bits.length === 2) el.setAttribute(bits[0].trim(), t(bits[1].trim()));
      });
    });
    root.querySelectorAll('[data-lang-switcher]').forEach(function (el) {
      if (!el.getAttribute('data-lang-mounted')) {
        el.setAttribute('data-lang-mounted', '1');
        mountLangSwitcher(el);
      }
    });
  }

  function setLocale(next) {
    try { localStorage.setItem(STORE_KEY, next); } catch (e) {}
    location.reload();
  }

  function loadDict() {
    // en is the source of truth but its strings still live in en.json — JS
    // t() calls have no inline fallback, so every locale (incl. en) loads a dict.
    if (dict) return Promise.resolve(dict);
    return fetch('/app/i18n/' + locale + '.json?v=' + I18N_VERSION)
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) {
        try { localStorage.setItem(DICT_KEY, JSON.stringify({ v: I18N_VERSION, dict: d })); } catch (e) {}
        return d;
      })
      .catch(function () { return {}; });
  }

  function whenDomReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  var ready = loadDict().then(function (d) {
    dict = d;
    return new Promise(function (resolve) {
      whenDomReady(function () {
        applyTranslations(document);
        document.documentElement.style.opacity = '1';
        resolve();
      });
    });
  });

  // Flag SVGs (compact, dependency-free). Endonym labels are not translated.
  var FLAGS = {
    en: '<svg viewBox="0 0 60 30" width="20" height="12" aria-hidden="true"><clipPath id="f-en"><path d="M0 0h60v30H0z"/></clipPath><g clip-path="url(#f-en)"><path d="M0 0h60v30H0z" fill="#012169"/><path d="M0 0l60 30m0-30L0 30" stroke="#fff" stroke-width="6"/><path d="M0 0l60 30m0-30L0 30" stroke="#C8102E" stroke-width="4"/><path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/><path d="M30 0v30M0 15h60" stroke="#C8102E" stroke-width="6"/></g></svg>',
    fr: '<svg viewBox="0 0 3 2" width="20" height="12" aria-hidden="true"><path fill="#0055A4" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#EF4135" d="M2 0h1v2H2z"/></svg>',
    de: '<svg viewBox="0 0 5 3" width="20" height="12" aria-hidden="true"><path d="M0 0h5v3H0z"/><path fill="#D00" d="M0 1h5v2H0z"/><path fill="#FFCE00" d="M0 2h5v1H0z"/></svg>'
  };
  var ENDONYMS = { en: 'English', fr: 'Français', de: 'Deutsch' };

  document.addEventListener('click', function (e) {
    document.querySelectorAll('.lang-switcher.open').forEach(function (w) {
      if (!w.contains(e.target)) {
        w.classList.remove('open');
        var tgl = w.querySelector('.lang-switcher-toggle');
        if (tgl) tgl.setAttribute('aria-expanded', 'false');
      }
    });
  });

  function mountLangSwitcher(target) {
    var wrap = document.createElement('div');
    wrap.className = 'lang-switcher';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-switcher-toggle';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    // The name contains the visible code (2.5.3), in the page's language.
    var langLabel = t('profile.languageLabel');
    if (langLabel === 'profile.languageLabel') langLabel = 'Language';
    btn.setAttribute('aria-label', langLabel + ': ' + locale.toUpperCase());
    btn.innerHTML = FLAGS[locale] + '<span>' + locale.toUpperCase() + '</span>';
    var menu = document.createElement('div');
    menu.className = 'lang-switcher-menu';
    SUPPORTED_LOCALES.forEach(function (loc) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'lang-switcher-item' + (loc === locale ? ' current' : '');
      if (loc === locale) item.setAttribute('aria-current', 'true');
      item.innerHTML = FLAGS[loc] + '<span>' + ENDONYMS[loc] + '</span>';
      item.addEventListener('click', function () { if (loc !== locale) setLocale(loc); });
      menu.appendChild(item);
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var open = wrap.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var cur = menu.querySelector('.current') || menu.firstChild; if (cur) cur.focus(); }
    });
    function close() {
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
    wrap.addEventListener('keydown', function (e) {
      if (!wrap.classList.contains('open')) return;
      var items = [].slice.call(menu.querySelectorAll('button'));
      var i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    });
    // Tab out of the menu closes it; a press inside does not (Safari blurs
    // the focused item without focusing the one pressed).
    var pressing = false;
    wrap.addEventListener('pointerdown', function () { pressing = true; });
    wrap.addEventListener('click', function () { pressing = false; });
    wrap.addEventListener('focusout', function (e) {
      if (pressing || wrap.contains(e.relatedTarget)) return;
      close();
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    target.appendChild(wrap);
  }

  window.t = t;
  window.i18n = {
    getLocale: getLocale,
    t: t,
    applyTranslations: applyTranslations,
    setLocale: setLocale,
    mountLangSwitcher: mountLangSwitcher,
    ready: ready
  };
})();
