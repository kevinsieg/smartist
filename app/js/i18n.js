// i18n core + browser runtime. UMD: pure functions exported for Node tests;
// browser glue runs only when a DOM is present.
(function () {
  var SUPPORTED_LOCALES = ['en', 'fr', 'de'];
  var DEFAULT_LOCALE = 'en';
  var I18N_VERSION = 1;

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

  // Browser glue added in Task 2 (guarded by `typeof document !== 'undefined'`).
})();
