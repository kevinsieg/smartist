// Service worker: keeps the app's own files so pages open with no connection.
// Handles only static files (cache first; their ?v= makes a new version a new
// URL) and page navigations (network first, saved copy on failure). It never
// touches /api/, non-GET requests or other origins: the data the stage view
// reads is saved by app/js/offline.js, tied to the signed-in user.

var STATIC_PATH = /^\/app\/(js|css|vendor|i18n)\//;

// 'static', 'page' or null (not ours). req = { url, method, mode }.
function strategyFor(req, origin) {
  if (req.method !== 'GET') return null;
  var u;
  try { u = new URL(req.url); } catch (e) { return null; }
  if (u.origin !== origin) return null;
  var p = u.pathname;
  if (p === '/sw.js' || p.indexOf('/api/') === 0 || p.indexOf('/auth/') === 0) return null;
  if (STATIC_PATH.test(p)) return u.searchParams.has('v') ? 'static' : null;
  return req.mode === 'navigate' ? 'page' : null;
}

// Pages are the same HTML whatever the query string says, so one saved copy
// per path serves every stage?id= / stage?song= link.
function pageKey(url) {
  var u = new URL(url);
  return u.origin + u.pathname;
}

// The versioned app files a page's HTML loads.
function assetsIn(html) {
  var out = [], re = /(?:src|href)="(\/app\/[^"]+)"/g, m;
  while ((m = re.exec(html))) {
    if (STATIC_PATH.test(m[1].split('?')[0]) && /[?&]v=/.test(m[1]) && out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { strategyFor: strategyFor, pageKey: pageKey, assetsIn: assetsIn };
} else if (typeof self !== 'undefined') {
  var SW_VERSION = 1;
  var STATIC_CACHE = 'smartist-static-v' + SW_VERSION;
  var PAGE_CACHE = 'smartist-pages-v' + SW_VERSION;
  var PAGE_TIMEOUT_MS = 3000;

  var cacheFirst = function (req) {
    return caches.open(STATIC_CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
      });
    });
  };

  // Saved copy when the network fails or takes longer than PAGE_TIMEOUT_MS; a
  // slow answer still refreshes the saved copy for next time.
  var networkFirst = function (req) {
    var key = new Request(pageKey(req.url));
    return caches.open(PAGE_CACHE).then(function (cache) {
      var net = fetch(req).then(function (res) {
        if (res.ok) cache.put(key, res.clone());
        return res;
      });
      var timer = new Promise(function (resolve, reject) { setTimeout(reject, PAGE_TIMEOUT_MS); });
      return Promise.race([net, timer]).catch(function () {
        return cache.match(key).then(function (hit) { return hit || net; });
      });
    });
  };

  // Save a page and the files it loads (used by "Keep offline" and on the very
  // first visit, when this worker is not yet controlling the page).
  var warm = function (url) {
    var key = new Request(pageKey(url));
    return caches.open(PAGE_CACHE).then(function (pages) {
      return fetch(url).then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        pages.put(key, res.clone());
        return res.text();
      });
    }).then(function (html) {
      return Promise.all(assetsIn(html).map(function (a) { return cacheFirst(new Request(a)); }));
    });
  };

  self.addEventListener('install', function () { self.skipWaiting(); });

  self.addEventListener('activate', function (e) {
    e.waitUntil(caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('smartist-') === 0 && k !== STATIC_CACHE && k !== PAGE_CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); }));
  });

  self.addEventListener('fetch', function (e) {
    var s = strategyFor({ url: e.request.url, method: e.request.method, mode: e.request.mode }, self.location.origin);
    if (s) e.respondWith(s === 'static' ? cacheFirst(e.request) : networkFirst(e.request));
  });

  self.addEventListener('message', function (e) {
    var d = e.data, port = e.ports && e.ports[0];
    if (!d || d.type !== 'warm' || !port) return;
    var same = false;
    try { same = new URL(d.url).origin === self.location.origin; } catch (err) { /* not a URL */ }
    if (!same) { port.postMessage({ ok: false }); return; }
    e.waitUntil(warm(d.url).then(
      function () { port.postMessage({ ok: true }); },
      function () { port.postMessage({ ok: false }); }
    ));
  });
}
