// Pure helpers with no session or shell dependency: escaping, safe links, the
// one date/number formatting. First of the four shared scripts on every app
// page (core, session, ui, shell), and the only one stage.html loads.

// Share icon (same glyph as the stage view's share button, which keeps its own
// copy of the glyph).
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

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Instrument fields a band hid in Settings (config.hiddenSongFields, e.g. 'extra.lead').
function songFieldHidden(config, key) {
  var hidden = config && config.hiddenSongFields;
  return Array.isArray(hidden) && hidden.indexOf(key) !== -1;
}

function songTags(song) {
  return (song && Array.isArray(song.tags)) ? song.tags : [];
}

function bandTags(songs) {
  var seen = {};
  (songs || []).forEach(function(s) { songTags(s).forEach(function(t) { seen[t] = true; }); });
  return Object.keys(seen).sort(function(a, b) { return a.localeCompare(b); });
}

// Stable: songs keep their generated order inside a tag. Untagged songs last.
function orderByFirstTag(songs) {
  var order = bandTags(songs);
  var rank = function(s) { var t = songTags(s)[0]; return t === undefined ? order.length : order.indexOf(t); };
  return songs.map(function(s, i) { return { s: s, i: i }; })
    .sort(function(a, b) { return rank(a.s) - rank(b.s) || a.i - b.i; })
    .map(function(x) { return x.s; });
}

// Indexes where a new first tag starts — a heading goes before each.
function tagGroupStarts(songs) {
  var starts = new Set();
  songs.forEach(function(s, i) {
    if (i === 0 || songTags(s)[0] !== songTags(songs[i - 1])[0]) starts.add(i);
  });
  return starts;
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

function formatLength(mins) {
  const val = mins || 4;
  const m = Math.floor(val);
  const s = Math.round((val - m) * 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Circle-of-fifths keys: 15 majors then their 15 relative minors.
var MUSICAL_KEYS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭',
  'Am', 'Em', 'Bm', 'F♯m', 'C♯m', 'G♯m', 'D♯m', 'A♯m', 'Dm', 'Gm', 'Cm', 'Fm', 'B♭m', 'E♭m', 'A♭m',
];

// Option HTML for a key <select>. Preserves a legacy/free-text value that
// predates this list so editing a song never silently drops its key.
function _keyOptions(cur) {
  cur = cur || '';
  var list = (cur && MUSICAL_KEYS.indexOf(cur) === -1) ? [cur].concat(MUSICAL_KEYS) : MUSICAL_KEYS;
  return '<option value="">—</option>' + list.map(function(k) {
    return '<option value="' + escHtml(k) + '"' + (k === cur ? ' selected' : '') + '>' + escHtml(k) + '</option>';
  }).join('');
}

// 'MM:SS' → minutes, or null when empty or malformed.
function timeToMins(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(':');
  if (parts.length !== 2) return null;
  const m = parseInt(parts[0], 10);
  const s = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(s) || s >= 60) return null;
  return m + s / 60;
}

// Full locale tag for Intl. English uses en-GB so dates stay day-first like the rest.
// Without i18n.js (stage.html) the page's own lang attribute decides.
function localeTag() {
  var locale = (window.i18n && window.i18n.getLocale) ? window.i18n.getLocale()
    : (document.documentElement.lang || 'en').slice(0, 2);
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

// Energy is 0–10, shown as three bands. Display only — setlist.js scores on the
// exact number.
function energyLabel(value) {
  if (value == null || value === '') return '';
  var n = Number(value);
  if (n <= 3) return t('songs.energyLow');
  if (n <= 7) return t('songs.energyMiddle');
  return t('songs.energyHigh');
}

// Narrow viewport: table-style editing is desktop-only (songs bulk edit, venues bulk edit).
function isMobile() { return window.innerWidth <= 1024; }

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

// ── Event handlers in markup, without inline script ──────────────────────
// The CSP has no 'unsafe-inline', so inline onclick attributes never run.
// Markup carries data-onclick="fn(args)" instead (data-onchange, data-oninput,
// …). The attribute is parsed, never evaluated: a sequence of calls to the
// app's own global functions, with literals, `this`, `event` and their
// properties as arguments. That keeps an injected attribute from calling
// fetch, location or anything else built in.
//
//   fn(1, 'a', this, this.value, this.files[0], this.dataset.id, event, null)
//   window.fn(x)                      same as fn(x)
//   event.stopPropagation(); fn(x)    ancestors' handlers do not run
//   event.preventDefault()  /  return false
var _ON_EVENTS = ['click', 'dblclick', 'change', 'input', 'keydown', 'dragover', 'drop'];
var _onCache = {};

function _onTokens(src) {
  var re = /\s*(?:([A-Za-z_$][\w$]*)|(-?\d+(?:\.\d+)?)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([(),.;[\]]))/y;
  var out = [], m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    var at = re.lastIndex;
    m = re.exec(src);
    if (!m || re.lastIndex === at) throw new Error('unexpected "' + src.slice(at, at + 12) + '"');
    if (m[1] !== undefined) out.push({ id: m[1] });
    else if (m[2] !== undefined) out.push({ lit: Number(m[2]) });
    else if (m[3] !== undefined || m[4] !== undefined)
      out.push({ lit: (m[3] !== undefined ? m[3] : m[4]).replace(/\\(.)/g, '$1') });
    else out.push({ p: m[5] });
  }
  return out;
}

var _ON_WORDS = { 'null': null, 'true': true, 'false': false, 'undefined': undefined };

// Parses a handler into steps: { call: [names], args: [...] } or { ret: false }.
function _onParse(src) {
  var tk = _onTokens(src), i = 0, steps = [];
  function peek(p) { return tk[i] && tk[i].p === p; }
  function expect(p) { if (!peek(p)) throw new Error('expected "' + p + '"'); i++; }
  function path() {
    if (!tk[i] || !tk[i].id) throw new Error('expected a name');
    var names = [tk[i++].id];
    for (;;) {
      if (peek('.')) { i++; if (!tk[i] || !tk[i].id) throw new Error('expected a name'); names.push(tk[i++].id); }
      else if (peek('[') && tk[i + 1] && typeof tk[i + 1].lit === 'number') { names.push(tk[i + 1].lit); i += 2; expect(']'); }
      else return names;
    }
  }
  function arg() {
    var tok = tk[i];
    if (!tok) throw new Error('missing argument');
    if ('lit' in tok) { i++; return { lit: tok.lit }; }
    if (tok.id && tok.id in _ON_WORDS) { i++; return { lit: _ON_WORDS[tok.id] }; }
    var names = path();
    if (names[0] !== 'this' && names[0] !== 'event') throw new Error('argument "' + names.join('.') + '"');
    return { ref: names };
  }
  while (i < tk.length) {
    if (peek(';')) { i++; continue; }
    if (tk[i].id === 'return' && tk[i + 1] && tk[i + 1].id === 'false') { i += 2; steps.push({ ret: false }); continue; }
    var names = path();
    if (names[0] === 'window') names = names.slice(1);
    var ev = names[0] === 'event' && names.length === 2 && (names[1] === 'stopPropagation' || names[1] === 'preventDefault');
    if (!ev && names.length !== 1) throw new Error('call "' + names.join('.') + '"');
    expect('(');
    var args = [];
    if (!peek(')')) { args.push(arg()); while (peek(',')) { i++; args.push(arg()); } }
    expect(')');
    steps.push({ call: names, args: args });
  }
  return steps;
}

function _onRef(names, el, e) {
  var v = names[0] === 'this' ? el : e;
  for (var k = 1; k < names.length && v != null; k++) v = v[names[k]];
  return v;
}

function _onRun(src, el, e) {
  var steps = _onCache[src] || (_onCache[src] = _onParse(src));
  for (var s = 0; s < steps.length; s++) {
    var step = steps[s];
    if (step.ret === false) { e.preventDefault(); continue; }
    if (step.call[0] === 'event') { e[step.call[1]](); continue; }
    var fn = window[step.call[0]];
    // Only the app's own functions: a built-in (fetch, open, alert…) is never
    // reachable from markup.
    if (typeof fn !== 'function' || /\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn)))
      throw new Error('no handler "' + step.call[0] + '"');
    fn.apply(el, step.args.map(function (a) { return 'ref' in a ? _onRef(a.ref, el, e) : a.lit; }));
  }
}

// Each handler runs on its own element, as an inline one did: on the way down
// (capture, on document) every element in the path that carries the attribute
// gets a one-shot listener, which the event then reaches on the way back up.
// So event.stopPropagation() in a button still keeps its row's listeners from
// firing, and a child's listener still runs before its parent's handler.
// Registering the same function twice is a no-op, so a listener left behind by
// an event that stopped short is simply reused.
var _onRunners = {};
_ON_EVENTS.forEach(function (type) {
  var attr = 'data-on' + type;
  _onRunners[type] = function (e) {
    var el = e.currentTarget, src = el.getAttribute(attr);
    if (src === null) return;
    try { _onRun(src, el, e); } catch (err) { console.error(attr + '="' + src + '": ' + err.message); }
  };
});

if (typeof document !== 'undefined' && !window._onDispatch) {
  window._onDispatch = true;
  _ON_EVENTS.forEach(function (type) {
    var attr = 'data-on' + type;
    document.addEventListener(type, function (e) {
      var el = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
      for (; el && el !== document.documentElement; el = el.parentElement)
        if (el.hasAttribute(attr)) el.addEventListener(type, _onRunners[type], { once: true });
    }, true);
  });
}

// Small actions markup needs that are not a call to one app function.
function clickById(id) { var el = document.getElementById(id); if (el) el.click(); }
function hideById(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; }
function removeParent(el) { if (el && el.parentElement) el.parentElement.remove(); }
// A click on the backdrop itself, not on the dialog inside it.
function hideOnBackdrop(e, el) { if (e.target === el) el.style.display = 'none'; }
function closeShareMenu() { var m = document.getElementById('share-menu-popup'); if (m) m.remove(); }
