// Saved copies of what the stage view reads (the band's light config, one
// setlist, one song), so it still opens with no connection. A copy belongs to
// the user who saved it; logout, a dead session and a 401 wipe them all
// (clearOfflineData in core.js). Only a network failure, a timeout or a
// 502/503/504 serve a saved copy: a 401/403/404 must stay what it is.
// Loaded by stage.html and setlist.html. Names carry the offline prefix: page
// scripts share one global scope across SPA navigation.

var OFFLINE_DB = 'smartist-offline';
var OFFLINE_TIMEOUT_MS = 8000;
// After one request failed or timed out the connection is probably down: the
// next ones (the stage view makes them one after another) wait only this long
// for 30 s, instead of the full timeout each.
var OFFLINE_FAST_TIMEOUT_MS = 1500;
var OFFLINE_FAIL_WINDOW_MS = 30000;
var _offlineFailAt = null;

// Whose copy is this? The user id inside the session token (the payload is
// base64url JSON, same decoding as getAuthRole in session.js); no token means
// the public stage.
function offlineOwner(token) {
  if (!token) return 'anonymous';
  try {
    var b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var id = JSON.parse(JSON.parse(atob(b64)).payload).userId;
    return id ? 'user:' + id : 'anonymous';
  } catch (e) { return 'anonymous'; }
}

function offlineIdbStore() {
  var dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise(function (resolve, reject) {
        var rq = indexedDB.open(OFFLINE_DB, 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onsuccess = function () {
          var db = rq.result;
          db.onversionchange = function () { db.close(); dbp = null; };
          resolve(db);
        };
        rq.onerror = function () { reject(rq.error); };
      });
    }
    return dbp;
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('kv', mode);
        var rq = fn(t.objectStore('kv'));
        t.oncomplete = function () { resolve(rq && rq.result); };
        t.onerror = t.onabort = function () { reject(t.error); };
      });
    });
  }
  return {
    get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }); },
  };
}

function offlineDeps(over) {
  var d = {
    fetch: function (u, o) { return fetch(u, o); },
    store: offlineIdbStore(),
    now: function () { return Date.now(); },
    token: function () { return sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token'); },
    clear: function () { return clearOfflineData(); },
    timeoutMs: OFFLINE_TIMEOUT_MS,
    fastTimeoutMs: OFFLINE_FAST_TIMEOUT_MS,
    markDown: function () { if (typeof offlineMarkDown === 'function') offlineMarkDown(); },
  };
  return Object.assign(d, over || {});
}

function offlineHeaders(d) {
  var t = d.token();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

function offlineHttpError(status) {
  var e = new Error('HTTP ' + status);
  e.status = status;
  return e;
}

function offlineWithTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new TypeError('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
  });
}

async function offlineSaved(d, url, owner, cause, fresh) {
  var network = cause.status === undefined;
  if (network) d.markDown();
  if (!fresh) {
    var hit = null;
    try { hit = await offlineWithTimeout(Promise.resolve(d.store.get(url)), d.timeoutMs); } catch (e) { hit = null; }
    if (hit && hit.owner === owner) return { data: hit.body, savedAt: hit.savedAt, fromCache: true };
  }
  if (!network) throw cause;
  var err = new Error('offline');
  err.offline = true;
  throw err;
}

// fresh: never answer from a saved copy (used by "Keep offline", which must
// not report an old copy as just saved).
async function offlineFetch(url, headers, over, fresh) {
  var d = offlineDeps(over);
  var owner = offlineOwner(d.token());
  var res;
  var recent = _offlineFailAt !== null && d.now() - _offlineFailAt < OFFLINE_FAIL_WINDOW_MS;
  try { res = await offlineWithTimeout(d.fetch(url, { headers: headers }), recent ? Math.min(d.timeoutMs, d.fastTimeoutMs) : d.timeoutMs); }
  catch (e) { _offlineFailAt = d.now(); return offlineSaved(d, url, owner, e, fresh); }
  _offlineFailAt = null;
  if (res.status === 401) { await d.clear(); throw offlineHttpError(401); }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return offlineSaved(d, url, owner, offlineHttpError(res.status), fresh);
  }
  if (!res.ok) throw offlineHttpError(res.status);
  var body = await res.json();
  // Saved in the background: a storage that never answers (a known Safari
  // failure) must not hold up the page. "Keep offline" waits, to report truly.
  var saved = Promise.resolve().then(function () { return d.store.set(url, { owner: owner, savedAt: d.now(), body: body }); });
  if (fresh) { try { await offlineWithTimeout(saved, d.timeoutMs); } catch (e) { /* storage unavailable */ } }
  else saved.catch(function () { /* storage unavailable: online use is unaffected */ });
  return { data: body, savedAt: null, fromCache: false };
}

// Fetch and save a setlist with the config and every song the stage view needs.
async function offlineKeep(slug, setlistId, onProgress, over) {
  var d = offlineDeps(over);
  var h = offlineHeaders(d);
  var base = '/api/' + slug;
  var sl = await offlineFetch(base + '/setlists/' + Number(setlistId), h, d, true);
  var ids = (sl.data.songs || []).map(function (s) { return Number(s.id); }).filter(Boolean);
  var urls = ['/api/config?light=1&slug=' + encodeURIComponent(slug)]
    .concat(ids.map(function (id) { return base + '/songs/' + id; }));
  var failed = [], done = 0;
  for (var i = 0; i < urls.length; i++) {
    try { await offlineFetch(urls[i], h, d, true); } catch (e) { failed.push(urls[i]); }
    done++;
    if (onProgress) onProgress(done, urls.length);
  }
  return { saved: urls.length - failed.length, failed: failed };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { offlineOwner: offlineOwner, offlineFetch: offlineFetch, offlineKeep: offlineKeep };
}
