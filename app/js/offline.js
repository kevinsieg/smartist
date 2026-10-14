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
var OFFLINE_MEDIA_TIMEOUT_MS = 180000;
// A kept setlist is refreshed when it was last synced longer ago than this.
var OFFLINE_SYNC_MS = 60 * 60 * 1000;
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
    del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }); },
    keys: function () { return tx('readonly', function (s) { return s.getAllKeys(); }); },
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

// Every melody image and recording of one song's details, once each.
function offlineMediaUrls(song) {
  var out = [];
  ((song && song.melodies) || []).forEach(function (m) {
    (m.sheet_urls || []).concat(m.audio_url ? [m.audio_url] : []).forEach(function (u) {
      if (u && out.indexOf(u) < 0) out.push(u);
    });
  });
  return out;
}

// A melody file is kept as a Blob in the same store, under 'media:<url>'. A
// cors request: an opaque no-cors answer cannot be read back or played. 'reload'
// skips a copy an earlier plain <img>/<audio> load left in the HTTP cache,
// which carries no CORS headers.
async function offlineMediaSave(url, over) {
  var d = offlineDeps(over);
  var blob = await offlineWithTimeout(
    d.fetch(url, { mode: 'cors', cache: 'reload' }).then(function (res) {
      if (!res.ok) throw offlineHttpError(res.status);
      return res.blob();
    }), OFFLINE_MEDIA_TIMEOUT_MS);
  await offlineWithTimeout(Promise.resolve(d.store.set('media:' + url, { owner: offlineOwner(d.token()), savedAt: d.now(), blob: blob })), d.timeoutMs);
}

async function offlineMediaHas(url, d) {
  try {
    var hit = await offlineWithTimeout(Promise.resolve(d.store.get('media:' + url)), d.timeoutMs);
    return !!hit && hit.owner === offlineOwner(d.token());
  } catch (e) { return false; }
}

// An object URL for the saved file, or null (the caller uses the file's own
// address then). A copy belongs to the user who saved it.
async function offlineMediaGet(url, over) {
  var d = offlineDeps(over);
  try {
    var hit = await offlineWithTimeout(Promise.resolve(d.store.get('media:' + url)), d.timeoutMs);
    if (hit && hit.owner === offlineOwner(d.token())) return URL.createObjectURL(hit.blob);
  } catch (e) { /* no saved copy */ }
  return null;
}

// A setlist the user chose to keep: its record lists every saved entry it uses
// (api answers by url, melody files as 'media:<url>'), so a refresh can prune
// what the setlist no longer needs and a removal can spare what another kept
// setlist still uses. Records belong to the user who kept them.
function offlineKeptKey(slug, setlistId) { return 'kept:' + slug + ':' + Number(setlistId); }

async function offlineKept(slug, setlistId, over) {
  var d = offlineDeps(over);
  try {
    var rec = await offlineWithTimeout(Promise.resolve(d.store.get(offlineKeptKey(slug, setlistId))), d.timeoutMs);
    return rec && rec.owner === offlineOwner(d.token()) ? rec : null;
  } catch (e) { return null; }
}

async function offlineKeptAll(d) {
  var owner = offlineOwner(d.token());
  var out = [];
  try {
    var keys = await offlineWithTimeout(Promise.resolve(d.store.keys()), d.timeoutMs);
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i]).indexOf('kept:') !== 0) continue;
      var rec = await offlineWithTimeout(Promise.resolve(d.store.get(keys[i])), d.timeoutMs);
      if (rec && rec.owner === owner) out.push(rec);
    }
  } catch (e) { /* storage unavailable: nothing is known to be kept */ }
  return out;
}

function offlineEntries(rec) {
  return rec.urls.concat(rec.media.map(function (u) { return 'media:' + u; }));
}

// Deletes the entries of `rec` that no record in `stillKept` uses.
async function offlinePrune(d, rec, stillKept) {
  var used = {};
  stillKept.forEach(function (r) { offlineEntries(r).forEach(function (e) { used[e] = true; }); });
  var gone = offlineEntries(rec).filter(function (e) { return !used[e]; });
  for (var i = 0; i < gone.length; i++) {
    try { await offlineWithTimeout(Promise.resolve(d.store.del(gone[i])), d.timeoutMs); } catch (e) { /* left behind */ }
  }
}

// Fetch and save a setlist with the config and every song the stage view needs,
// then the melody files of those songs (files are never replaced: their address
// carries a unique id, so one already saved is skipped). Keeping a setlist again
// refreshes it and drops the copies it no longer uses.
async function offlineKeep(slug, setlistId, onProgress, over) {
  var d = offlineDeps(over);
  var h = offlineHeaders(d);
  var base = '/api/' + slug;
  var sl = await offlineFetch(base + '/setlists/' + Number(setlistId), h, d, true);
  var ids = (sl.data.songs || []).map(function (s) { return Number(s.id); }).filter(Boolean);
  var urls = ['/api/config?light=1&slug=' + encodeURIComponent(slug)]
    .concat(ids.map(function (id) { return base + '/songs/' + id; }));
  var failed = [], done = 0, media = [];
  for (var i = 0; i < urls.length; i++) {
    try {
      var res = await offlineFetch(urls[i], h, d, true);
      offlineMediaUrls(res.data).forEach(function (u) { if (media.indexOf(u) < 0) media.push(u); });
    } catch (e) { failed.push(urls[i]); }
    done++;
    if (onProgress) onProgress(done, urls.length);
  }
  var total = urls.length + media.length;
  for (var j = 0; j < media.length; j++) {
    try { if (!(await offlineMediaHas(media[j], d))) await offlineMediaSave(media[j], d); } catch (e) { failed.push(media[j]); }
    done++;
    if (onProgress) onProgress(done, total);
  }
  try {
    var prev = await offlineKept(slug, setlistId, d);
    var rec = {
      owner: offlineOwner(d.token()), slug: slug, id: Number(setlistId),
      savedAt: prev ? prev.savedAt : d.now(), syncedAt: d.now(),
      urls: [base + '/setlists/' + Number(setlistId)].concat(urls), media: media,
    };
    await offlineWithTimeout(Promise.resolve(d.store.set(offlineKeptKey(slug, setlistId), rec)), d.timeoutMs);
    if (prev) {
      var others = (await offlineKeptAll(d)).filter(function (r) { return !(r.slug === slug && r.id === rec.id); });
      await offlinePrune(d, prev, others.concat([rec]));
    }
  } catch (e) { /* storage unavailable: the copies exist, the setlist is just not marked */ }
  return { saved: total - failed.length, failed: failed };
}

// Stop keeping a setlist: its copies go, except what another kept setlist uses.
async function offlineRelease(slug, setlistId, over) {
  var d = offlineDeps(over);
  var rec = await offlineKept(slug, setlistId, d);
  if (!rec) return;
  await offlineWithTimeout(Promise.resolve(d.store.del(offlineKeptKey(slug, setlistId))), d.timeoutMs);
  await offlinePrune(d, rec, await offlineKeptAll(d));
}

// Refresh the kept setlists that were last synced more than OFFLINE_SYNC_MS ago.
// No connection: nothing changes. A setlist deleted on the server is released.
// Returns how many were refreshed.
async function offlineSyncKept(over) {
  var d = offlineDeps(over);
  var recs = await offlineKeptAll(d);
  var n = 0;
  for (var i = 0; i < recs.length; i++) {
    if (d.now() - recs[i].syncedAt < OFFLINE_SYNC_MS) continue;
    try { await offlineKeep(recs[i].slug, recs[i].id, null, d); n++; }
    catch (e) { if (e && e.status === 404) await offlineRelease(recs[i].slug, recs[i].id, d); }
  }
  return n;
}

// Refresh when the connection returns and when a page opens online.
if (typeof window !== 'undefined' && window.addEventListener && !window._offlineSyncWired) {
  window._offlineSyncWired = true;
  var _offlineSyncRun = function () {
    if (navigator.onLine !== false) offlineSyncKept().catch(function () { /* tried again next time */ });
  };
  window.addEventListener('online', _offlineSyncRun);
  setTimeout(_offlineSyncRun, 4000);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { offlineOwner: offlineOwner, offlineFetch: offlineFetch, offlineKeep: offlineKeep, offlineMediaUrls: offlineMediaUrls, offlineMediaSave: offlineMediaSave, offlineMediaGet: offlineMediaGet, offlineKept: offlineKept, offlineRelease: offlineRelease, offlineSyncKept: offlineSyncKept };
}
