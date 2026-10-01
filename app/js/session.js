// Session and workspace: which band the URL names, the token (getToken,
// clearToken, apiFetch), the band config cache (loadConfig) and view mode.

const AUTH_TOKEN_KEY = 'smartist_token';

var _GLOBAL_PAGES = new Set(['login','signup','onboarding','workspaces','demo','contact','profile']);
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
  localStorage.removeItem(AUTH_TOKEN_KEY);
  var url = loginPageUrl();
  window.location.assign(url);
}
window.goToLogin = goToLogin;

// No session in this browser. An expired or revoked one is found out by the
// first request that answers 401 (apiFetch sends the person to log in).
function isViewMode() {
  return !getToken();
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
}

// The users row id this session belongs to, or null: no session, or the demo
// gate's token, which has no personal account (no password, email or deletion).
function sessionUserId() {
  var tok = getToken();
  if (!tok) return null;
  try {
    var b64 = tok.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var outer = JSON.parse(atob(b64));
    return outer.payload ? (JSON.parse(outer.payload).userId || null) : null;
  } catch { return null; }
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

// Lyrics are not part of any song list (a band's lyrics run to megabytes); they
// come with one song's details. Caches the text on the song object — undefined
// means not loaded yet, null means the song has none.
async function loadSongLyrics(slug, song) {
  if (!song || !song.id) return '';
  if (song.lyrics !== undefined) return song.lyrics || '';
  if (song.has_lyrics === false) { song.lyrics = null; return ''; }
  const r = await apiFetch('/api/' + slug + '/songs/' + Number(song.id));
  if (!r.ok) throw new Error('lyrics fetch failed');
  const detail = await r.json();
  song.lyrics = detail.lyrics || null;
  song.has_lyrics = !!song.lyrics;
  return song.lyrics || '';
}

// Force the next loadConfig() call to fetch fresh data from the network.
function invalidateConfigCache() {
  var base = 'artist_config_cache_' + (_artistSlug || 'default');
  sessionStorage.removeItem(base);
  sessionStorage.removeItem(base + '_light');
}
