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
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Instrument fields a band hid in Settings (config.hiddenSongFields, e.g. 'extra.lead').
function songFieldHidden(config, key) {
  var hidden = config && config.hiddenSongFields;
  return Array.isArray(hidden) && hidden.indexOf(key) !== -1;
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
