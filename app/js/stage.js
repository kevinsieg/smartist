// Stage view — full-screen setlist for on-stage use

// Screen readers hear status changes (copied, sent) through one polite live region.
function _stageAnnounce(msg) {
  var live = document.getElementById('stage-live');
  if (!live) return;
  live.textContent = '';
  setTimeout(function() { live.textContent = msg; }, 50);
}

// Keep the screen on while the stage view is visible: a phone that locks
// after 30 s would hide the lyrics mid-song. The lock is released by the
// browser whenever the tab is hidden, so it is taken again on return.
var _stageWakeLock = null;
function _stageKeepAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  if (_stageWakeLock && !_stageWakeLock.released) return;
  navigator.wakeLock.request('screen').then(function(lock) { _stageWakeLock = lock; }).catch(function() {});
}
document.addEventListener('visibilitychange', _stageKeepAwake);
// Some browsers refuse the lock before the first user interaction.
document.addEventListener('pointerdown', _stageKeepAwake);
_stageKeepAwake();

var _shareSlug      = null;
var _shareSetlistId = null;

// Members of private workspaces must authenticate to read config/setlists/songs.
// The session token, wherever "remember me" put it (stage has no session.js).
function _openActiveArrPopup() { openArrStagePopup(window._stageActiveArr, window._stageArrConfig); }

function _stageToken() {
  return sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token');
}

function _stageAuthHeaders() {
  var t = _stageToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

// A saved copy is shown with its age, so a musician knows how old the setlist is.
function _stageOfflineNote(res) {
  if (!res || !res.fromCache) return '';
  return '<p class="stage-sub" role="status">Offline. Showing the version saved ' +
    escHtml(formatDate(res.savedAt) + ' ' + formatTime(res.savedAt)) + '.</p>';
}

// ── Lyrics font size ───────────────────────────────────────────────────────────
var _stageLyricsPx = parseInt(localStorage.getItem('stage_lyrics_px')) || 22;

// "Fit to screen" is a toggle like Columns: while on, the size follows the
// screen; off, it goes back to the size set with A− and A+.
var _stageFitOn = (function() {
  try { return localStorage.getItem('stage_fit') === '1'; } catch (e) { return false; }
})();

function _stageFitSync() {
  var b = document.getElementById('_stage_fit_btn');
  if (b) b.setAttribute('aria-pressed', String(_stageFitOn));
}

function _stageFitStop() {
  if (!_stageFitOn) return;
  _stageFitOn = false;
  try { localStorage.setItem('stage_fit', '0'); } catch (e) { /* storage unavailable */ }
  _stageFitSync();
}

function _applyLyricsSize() {
  var el = document.getElementById('_stage_lyrics');
  if (el) el.style.fontSize = _stageLyricsPx + 'px';
}

function stageFontUp() {
  _stageFitStop();
  _stageLyricsPx = Math.min(80, Math.round(_stageLyricsPx * 1.15));
  localStorage.setItem('stage_lyrics_px', _stageLyricsPx);
  _applyLyricsSize();
}

function stageFontDown() {
  _stageFitStop();
  _stageLyricsPx = Math.max(8, Math.round(_stageLyricsPx / 1.15));
  localStorage.setItem('stage_lyrics_px', _stageLyricsPx);
  _applyLyricsSize();
}

// Largest whole size in [lo, hi] for which fits(size) holds; lo when none does.
// fits() applies the size it tests, so callers set the result afterwards.
function _stageFitSearch(fits, lo, hi) {
  var best = lo;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (fits(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// The largest size at which the lyrics fit the screen below the header.
function _stageFitNow() {
  var el = document.getElementById('_stage_lyrics');
  if (!el) return;
  var availH = window.innerHeight - el.getBoundingClientRect().top - 24;
  if (availH < 40) return;
  var px = _stageFitSearch(function (size) {
    el.style.fontSize = size + 'px';
    return el.scrollHeight <= availH;
  }, 7, 96);
  el.style.fontSize = px + 'px';
}

// Fits again after anything that changes the room: the window, the sheet, the chords.
function _stageRefit() {
  if (_stageColsOn) _stageFitColumns();
  else if (_stageFitOn) _stageFitNow();
}

function stageFitLyrics() {
  _stageFitOn = !_stageFitOn;
  try { localStorage.setItem('stage_fit', _stageFitOn ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  _stageFitSync();
  if (_stageColsOn) { _stageFitColumns(); return; }
  if (_stageFitOn) _stageFitNow(); else _applyLyricsSize();
}

// ── Columns: the lyrics fill the screen below the header, in as many columns
// as the width allows, at the largest size that needs no scrolling ───────────
var _stageColsOn = (function() {
  try { return localStorage.getItem('stage_cols') === '1'; } catch (e) { return false; }
})();

// True while the page is laid out for print. Safari lays out again and fires
// resize repeatedly in its print preview; the lyrics and waveform refits then
// feed each other until the tab dies.
function _stageIsPrint() {
  return !!(window.matchMedia && window.matchMedia('print').matches);
}

function _stageFitColumns() {
  var el = document.getElementById('_stage_lyrics');
  if (!el || _stageIsPrint()) return;
  document.body.classList.toggle('stage-cols', _stageColsOn);
  var b = document.getElementById('_stage_cols_btn');
  if (b) b.setAttribute('aria-pressed', String(_stageColsOn));
  if (!_stageColsOn) { el.style.height = ''; if (_stageFitOn) _stageFitNow(); else _applyLyricsSize(); return; }
  // Room down to the floating size bar at the bottom (it wraps on phones).
  var bar = document.querySelector('.lyrics-size-bar');
  var reserve = bar ? Math.ceil(bar.getBoundingClientRect().height) + 28 : 72;
  el.style.height = Math.max(120, window.innerHeight - el.getBoundingClientRect().top - reserve) + 'px';
  var px = _stageFitSearch(function (size) {
    el.style.fontSize = size + 'px';
    return el.scrollWidth <= el.clientWidth + 1;
  }, 8, 96);
  el.style.fontSize = px + 'px';
}

function stageToggleColumns() {
  _stageColsOn = !_stageColsOn;
  try { localStorage.setItem('stage_cols', _stageColsOn ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  _stageFitColumns();
}

var _stageColsTimer = null;
window.addEventListener('resize', function () {
  if (!(_stageColsOn || _stageFitOn) || _stageIsPrint()) return;
  clearTimeout(_stageColsTimer);
  _stageColsTimer = setTimeout(_stageRefit, 150);
});

// ── Chords: on/off and transpose ─────────────────────────────────────────────
function _stageStoreChords(on) {
  try { localStorage.setItem('stage_chords', on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
}
var _stageChordsOn = (function() {
  try { return localStorage.getItem('stage_chords') !== '0'; } catch (e) { return true; }
})();
var _stageSteps = 0;
// Show the shapes for one instrument's capo ('git' or 'bj'), or '' for sounding chords.
var _stageCapoInst = (function() {
  try { return localStorage.getItem('stage_capo') || ''; } catch (e) { return ''; }
})();
var _stageCapos = { git: 0, bj: 0 };
var _stageLyricsText = '';
var _stageKey = '';
function _stageFlag(name) {
  try { return localStorage.getItem(name) === '1'; } catch (e) { return false; }
}
var _stageStructOn = _stageFlag('stage_structure');
var _stageNumbersOn = _stageFlag('stage_numbers');

function _stageRenderLyrics() {
  var el = document.getElementById('_stage_lyrics');
  if (!el) return;
  el.innerHTML = chordsRender(_stageLyricsText, { chords: _stageChordsOn, steps: _stageSteps, capo: _stageCapos[_stageCapoInst] || 0 });
  ['git', 'bj'].forEach(function (k) {
    var c = document.getElementById('_stage_capo_' + k);
    if (c) c.setAttribute('aria-pressed', String(_stageCapoInst === k));
  });
  var v = document.getElementById('_stage_transpose_val');
  if (v) v.textContent = (_stageSteps > 0 ? '+' : '') + _stageSteps;
  var b = document.getElementById('_stage_chords_btn');
  if (b) b.setAttribute('aria-pressed', String(_stageChordsOn));
  var st = document.getElementById('_stage_structure');
  if (st) st.innerHTML = _stageStructOn ? chordsStructure(_stageLyricsText, { numbers: _stageNumbersOn, key: _stageKey, steps: _stageSteps, capo: _stageCapos[_stageCapoInst] || 0 }) : '';
  var sb = document.getElementById('_stage_struct_btn');
  if (sb) sb.setAttribute('aria-pressed', String(_stageStructOn));
  var nb = document.getElementById('_stage_num_btn');
  if (nb) { nb.setAttribute('aria-pressed', String(_stageNumbersOn)); nb.style.display = _stageStructOn ? '' : 'none'; }
  _stageRefit();
}

function stageToggleChords() {
  _stageChordsOn = !_stageChordsOn;
  _stageStoreChords(_stageChordsOn);
  _stageRenderLyrics();
}

function stageToggleStructure() {
  _stageStructOn = !_stageStructOn;
  try { localStorage.setItem('stage_structure', _stageStructOn ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  _stageRenderLyrics();
}

function stageToggleNumbers() {
  _stageNumbersOn = !_stageNumbersOn;
  try { localStorage.setItem('stage_numbers', _stageNumbersOn ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  _stageRenderLyrics();
}

function stageCapo(inst) {
  _stageCapoInst = _stageCapoInst === inst ? '' : inst;
  try { localStorage.setItem('stage_capo', _stageCapoInst); } catch (e) { /* storage unavailable */ }
  _stageRenderLyrics();
}

function stageTranspose(d) {
  _stageSteps = Math.max(-11, Math.min(11, _stageSteps + d));
  _stageRenderLyrics();
}

var _SUN_ICON  = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
var _MOON_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

// Stage totals: blank for none and no zero-padded minutes ("7:30"), unlike
// formatLength in core.js, which the song lists use.
function _stageLength(min) {
  if (!min) return '';
  const m = Math.floor(min);
  const s = Math.round((min - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// The setlist this page belongs to (the setlist itself, or a song opened from
// it): the offline icon keeps and removes that one.
var _stageSetlistId = 0;
var _OFFLINE_ICON = '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>';
var _OFFLINE_KEPT_ICON = '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>';

function _stageOfflineBtnHtml() {
  if (!_stageSetlistId || typeof offlineKept !== 'function') return '';
  return '<button class="stage-share-btn stage-offline-btn" id="stage-offline-btn" data-onclick="stageToggleOffline()" aria-pressed="false" aria-label="Keep this setlist offline" title="Not saved offline. Click to download.">' + _OFFLINE_ICON + '</button>';
}

function _stageOfflineShow(btn, rec) {
  btn.classList.toggle('kept', !!rec);
  btn.setAttribute('aria-pressed', String(!!rec));
  btn.innerHTML = rec ? _OFFLINE_KEPT_ICON : _OFFLINE_ICON;
  btn.setAttribute('aria-label', rec ? 'Saved offline. Remove the offline copy' : 'Keep this setlist offline');
  btn.title = rec
    ? 'Saved offline, synced ' + formatDate(rec.syncedAt) + ' ' + formatTime(rec.syncedAt) + '. Click to remove.'
    : 'Not saved offline. Click to download.';
}

async function _stageOfflineRefresh() {
  var btn = document.getElementById('stage-offline-btn');
  if (!btn) return;
  _stageOfflineShow(btn, await offlineKept(_shareSlug, _stageSetlistId));
}

// Grey: download. Green: remove (asks first, the copy may be the only one at a
// gig without connection).
async function stageToggleOffline() {
  var btn = document.getElementById('stage-offline-btn');
  if (!btn || btn.disabled) return;
  if (await offlineKept(_shareSlug, _stageSetlistId)) {
    if (!confirm('Remove the offline copy of this setlist from this device?')) return;
    await offlineRelease(_shareSlug, _stageSetlistId);
    _stageOfflineShow(btn, null);
    _stageAnnounce('Offline copy removed');
    return;
  }
  btn.disabled = true;
  try {
    var out = await offlineKeep(_shareSlug, _stageSetlistId, function(done, total) { btn.textContent = done + '/' + total; });
    await offlineWarm(location.origin + '/' + _shareSlug + '/stage?id=' + _stageSetlistId);
    _stageAnnounce(out.failed.length ? 'Saved offline, ' + out.failed.length + ' files failed' : 'Saved offline');
  } catch (e) {
    _stageAnnounce('Could not save offline. A connection is needed.');
  }
  btn.disabled = false;
  _stageOfflineRefresh();
}

function _shareHtml(navHtml) {
  var light = document.body.classList.contains('stage-light');
  return `<div class="stage-header-btns">
    ${navHtml || ''}
    ${_stageOfflineBtnHtml()}
    <button class="stage-invert-btn" id="stage-invert-btn" data-onclick="toggleStageInvert()" aria-label="Light mode" aria-pressed="${light}" title="${light ? 'Switch to dark mode' : 'Switch to light mode'}">${light ? _MOON_ICON : _SUN_ICON}</button>
    <button class="stage-share-btn" id="stage-share-btn" data-onclick="toggleStageShareMenu(event)" aria-label="Share" aria-expanded="false" aria-controls="stage-share-menu" title="Share"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>
    <div class="stage-share-menu" id="stage-share-menu" style="display:none">
      <button class="stage-share-item" data-onclick="stageSharePrint()"><span class="stage-share-icon" aria-hidden="true">⎙</span>Print / Export PDF</button>
      <button class="stage-share-item" data-onclick="stageShareCopyLink()"><span class="stage-share-icon" aria-hidden="true">⧉</span><span id="stage-copy-label">Copy link</span></button>
      <button class="stage-share-item" data-onclick="stageShareEmail()"><span class="stage-share-icon" aria-hidden="true">✉</span>Share via email</button>
    </div>
  </div>`;
}

function _navHtml(setlistId, songs, idx) {
  var prevSong = idx > 0 ? songs[idx - 1] : null;
  var nextSong = idx < songs.length - 1 ? songs[idx + 1] : null;
  var listIcon = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
  var prevIcon = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="15 18 9 12 15 6"/></svg>';
  var nextIcon = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="9 18 15 12 9 6"/></svg>';
  var base    = '/' + _shareSlug + '/stage';
  var backBtn = `<a class="stage-share-btn" href="${base}?id=${setlistId}" aria-label="Back to setlist" title="Back to setlist">${listIcon}</a>`;
  // id="stage-prev"/"stage-next": the arrow keys (and page-turner pedals) follow them.
  var prevBtn = prevSong
    ? `<a class="stage-share-btn" id="stage-prev" href="${base}?song=${prevSong.id}&from=${setlistId}" aria-label="Previous song: ${escHtml(prevSong.title)}" title="${escHtml(prevSong.title)}">${prevIcon}</a>`
    : `<button class="stage-share-btn" disabled aria-label="No previous song" title="No previous song">${prevIcon}</button>`;
  var nextBtn = nextSong
    ? `<a class="stage-share-btn" id="stage-next" href="${base}?song=${nextSong.id}&from=${setlistId}" aria-label="Next song: ${escHtml(nextSong.title)}" title="${escHtml(nextSong.title)}">${nextIcon}</a>`
    : `<button class="stage-share-btn" disabled aria-label="No next song" title="No next song">${nextIcon}</button>`;
  return `${backBtn}${prevBtn}${nextBtn}<span class="stage-nav-sep" aria-hidden="true"></span>`;
}

function applyStageTheme(light) {
  if (light) {
    document.body.classList.add('stage-light');
    localStorage.setItem('stage_light_mode', '1');
  } else {
    document.body.classList.remove('stage-light');
    localStorage.removeItem('stage_light_mode');
  }
}

function toggleStageInvert() {
  var light = !document.body.classList.contains('stage-light');
  applyStageTheme(light);
  var btn = document.getElementById('stage-invert-btn');
  if (btn) {
    btn.title = light ? 'Switch to dark mode' : 'Switch to light mode';
    btn.setAttribute('aria-pressed', String(light));
    btn.innerHTML = light ? _MOON_ICON : _SUN_ICON;
  }
}

// --- Melody: the views (Listen, Playback, my voice), their recording and sheets ---

var _stageMelodies = [];
var _stageInstruments = [];
var _stageExtra = {};
var _stageView = null;
var _stageSheet = null;
var _stageRun = 0;
var _stageRate = 1;

function _stageVoiceSaved() {
  try { return localStorage.getItem(MELODY_VOICE_KEY); } catch (e) { return null; }
}

function _stageState() {
  return melodyStage(_stageExtra, _stageMelodies, _stageInstruments, _stageVoiceSaved(), _stageView, _stageSheet);
}

// The user's last choice; the saved voice stays chosen while another view is open.
// Listen and Playback share one button, which keeps the one used last.
var _stageTrack = 'listen';

function stageSetView(view) {
  if (view === 'voice' && !_stageState().voice.key) {
    var btn = document.querySelector('.stage-menu-wrap[data-menu="voice"] .stage-menu-btn');
    if (btn) stageMenu(btn);
    return;
  }
  // A selected button is deselected by clicking it again, and the sheet that
  // followed it goes with it; choosing one again brings that sheet back too.
  if (_stageState().view === view) view = 'none';
  if (view === 'listen' || view === 'playback') _stageTrack = view;
  _stageView = view;
  if (_stageSheet === 'none') _stageSheet = null;
  _stageRender();
}

// The export can carry every sheet instead of the one on screen.
var STAGE_ALL_SHEETS = '_all';
var _stagePrintAll = false;

// The sheet is chosen apart from the track; once chosen it stays.
function stageSetSheet(key) {
  if (key === STAGE_ALL_SHEETS) { _stagePrintAll = !_stagePrintAll; _stageRender(); return; }
  _stageSheet = key === _stageState().sheet ? 'none' : key;
  _stageRender();
}

// The sheet button itself shows or hides the sheet, like Track and Voice; the
// caret picks which one.
var _stageSheetLast = null;
function stageToggleSheet() {
  var st = _stageState();
  if (st.sheet) _stageSheet = 'none';
  else {
    var back = st.sheets.some(function(x) { return x.key === _stageSheetLast; }) ? _stageSheetLast : st.sheets[0].key;
    _stageSheet = back;
  }
  _stageRender();
}

// A new voice brings its own sheets: the sheet follows it again.
function stageSetVoice(key) {
  try {
    if (key) localStorage.setItem(MELODY_VOICE_KEY, key); else localStorage.removeItem(MELODY_VOICE_KEY);
  } catch (e) { /* storage unavailable: the choice lasts until the page closes */ }
  _stageView = 'voice';
  _stageSheet = null;
  _stageRender();
}

// One menu open at a time; an outside click or Escape closes it.
function stageMenu(btn) {
  var menu = btn.closest('.stage-menu-wrap').querySelector('.stage-menu');
  var open = menu.hidden;
  _stageMenusClose();
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

function _stageMenusClose() {
  document.querySelectorAll('.stage-menu').forEach(function(menu) {
    if (menu.hidden) return;
    menu.hidden = true;
    var btn = menu.closest('.stage-menu-wrap').querySelector('.stage-menu-btn');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (menu.contains(document.activeElement)) btn.focus(); }
  });
}

document.addEventListener('click', function(e) {
  if (!e.target.closest || !e.target.closest('.stage-menu-wrap')) _stageMenusClose();
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') _stageMenusClose(); });

function stageSetRate(value) {
  _stageRate = Number(value) || 1;
  var audio = document.querySelector('#_stage_audio audio');
  if (audio) audio.playbackRate = _stageRate;
  _stageRenderControls(_stageState());
}

// A recording's loudness profile, stored with it: drawn here, never decoded
// here. The played part follows the audio element next to it.
function _stageWaveHtml(wave) {
  return waveformValid(wave)
    ? '<canvas class="stage-wave" aria-hidden="true" data-wave="' + wave + '" data-onclick="stageWaveSeek(event, this)"></canvas>'
    : '';
}

function _stageWaveDraw(canvas) {
  if (_stageIsPrint()) return;
  var audio = canvas._stageAudio;
  var peaks = waveformDecode(canvas.dataset.wave);
  if (!audio || !peaks) return;
  var dpr = window.devicePixelRatio || 1;
  var w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  var cs = getComputedStyle(document.body);
  waveformDraw(canvas, peaks, audio.duration ? audio.currentTime / audio.duration : 0,
    { played: cs.getPropertyValue('--s-accent').trim(), rest: cs.getPropertyValue('--s-muted').trim() });
}

function _stageWaveWire(root) {
  root.querySelectorAll('canvas.stage-wave').forEach(function(c) {
    var audio = c.parentNode.querySelector('audio');
    if (!audio) return;
    c._stageAudio = audio;
    ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked'].forEach(function(ev) {
      audio.addEventListener(ev, function() { _stageWaveDraw(c); });
    });
    _stageWaveDraw(c);
  });
}

function stageWaveSeek(ev, canvas) {
  var audio = canvas._stageAudio;
  if (!audio || !audio.duration) return;
  var box = canvas.getBoundingClientRect();
  audio.currentTime = Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)) * audio.duration;
}

window.addEventListener('resize', function() {
  if (_stageIsPrint()) return;
  document.querySelectorAll('canvas.stage-wave').forEach(_stageWaveDraw);
});

function stageZoomMelody(btn) {
  var gallery = btn.closest('.stage-gallery');
  var track = gallery.querySelector('.stage-gallery-track');
  var page = Math.round(track.scrollLeft / (track.clientWidth || 1));
  gallery.classList.toggle('zoom');
  track.scrollLeft = page * track.clientWidth;
}

// A copy saved by "Keep offline" when there is one, else the file's own address.
async function _stageMediaUrl(url) {
  if (typeof offlineMediaGet !== 'function') return url;
  return (await offlineMediaGet(url)) || url;
}

function _stageMediaSrc(url) { return url.indexOf('blob:') === 0 ? url : safeUrl(url); }

var _STAGE_VIEW_LABEL = { listen: 'Listen', playback: 'Playback' };

// onclick is the item's whole attribute, written out at the call (the handler
// check reads each one from the source).
function _stageMenuHtml(items, onclick) {
  return '<ul class="stage-menu" role="menu" hidden>' + items.map(function(it) {
    return '<li role="none"><button type="button" role="menuitemradio" aria-checked="' + it.checked + '" data-key="' + escHtml(it.key) +
      '" ' + onclick + '>' + escHtml(it.label) + '</button></li>';
  }).join('') + '</ul>';
}

var _STAGE_CARET = ' <span aria-hidden="true">&#9662;</span>';

// A button with a menu: the main part acts, the caret opens the menu.
function _stageSplitHtml(menu, mainFk, label, view, pressed, items, onclick) {
  return '<span class="stage-menu-wrap" data-menu="' + menu + '">' +
    '<button class="stage-share-btn" data-fk="' + mainFk + '" data-onclick="stageSetView(\'' + view + '\')" aria-pressed="' + pressed + '">' + escHtml(label) + '</button>' +
    (items.length > (menu === 'voice' ? 0 : 1)
      ? '<button type="button" class="stage-share-btn stage-menu-btn" data-fk="' + mainFk + 'Menu" data-onclick="stageMenu(this)" aria-haspopup="menu" aria-expanded="false" aria-label="' + (menu === 'voice' ? 'Choose your voice' : 'Choose the recording') + '">&#9662;</button>' + _stageMenuHtml(items, onclick)
      : '') + '</span>';
}

// A button that is only a menu.
function _stageDropHtml(menu, fk, label, aria, items, onclick) {
  return '<span class="stage-menu-wrap" data-menu="' + menu + '"><button type="button" class="stage-share-btn stage-menu-btn stage-drop" data-fk="' + fk +
    '" data-onclick="stageMenu(this)" aria-haspopup="menu" aria-expanded="false" aria-label="' + aria + '">' + escHtml(label) + _STAGE_CARET + '</button>' +
    _stageMenuHtml(items, onclick) + '</span>';
}

function _stageCtl(caption, tip, inner) {
  return '<div class="stage-ctl" title="' + escHtml(tip) + '"><span class="stage-ctl-label">' + caption + '</span>' + inner + '</div>';
}

// One row, each control with a small caption (and a hover text): the track
// (Listen or Playback), my voice, the sheet to show, the speed.
function _stageControlsHtml(st) {
  var out = '';
  var tracks = st.views.filter(function(v) { return v !== 'voice'; });
  var showViews = st.views.length > 1 || st.views[0] === 'voice';
  if (showViews && tracks.length) {
    var held = tracks.indexOf(st.view) >= 0 ? st.view : (tracks.indexOf(_stageTrack) >= 0 ? _stageTrack : tracks[0]);
    out += _stageCtl('Track', 'The recording to play: Listen (the reference) or Playback (the backing track)',
      _stageSplitHtml('track', 'track', _STAGE_VIEW_LABEL[held], held, st.view === held,
        tracks.map(function(v) { return { key: v, label: _STAGE_VIEW_LABEL[v], checked: v === held }; }), 'data-onclick="stageSetView(this.dataset.key)"'));
  }
  if (showViews && st.views.indexOf('voice') >= 0) {
    out += _stageCtl('Voice', 'Your voice: plays its recording, and its sheets show with it',
      _stageSplitHtml('voice', 'voice', st.voice.label || 'My voice', 'voice', st.view === 'voice',
        st.voices.map(function(i) { return { key: i.key, label: i.label || i.key, checked: i.key === st.voice.key }; }), 'data-onclick="stageSetVoice(this.dataset.key)"'));
  }
  var chosen = st.sheets.find(function(x) { return x.key === st.sheet; });
  if (st.sheets.length) {
    if (chosen) _stageSheetLast = chosen.key;
    var last = st.sheets.find(function(x) { return x.key === _stageSheetLast; }) || st.sheets[0];
    out += _stageCtl('Sheet', 'The sheet to show, whatever is playing: any voice, or the whole song. Click to hide or show it',
      '<span class="stage-menu-wrap" data-menu="sheet">' +
      '<button class="stage-share-btn" data-fk="sheet" data-onclick="stageToggleSheet()" aria-pressed="' + !!chosen + '">' + escHtml((chosen || last).label) + '</button>' +
      (st.sheets.length > 1
        ? '<button type="button" class="stage-share-btn stage-menu-btn" data-fk="sheetMenu" data-onclick="stageMenu(this)" aria-haspopup="menu" aria-expanded="false" aria-label="Which sheet to show">&#9662;</button>' +
          _stageMenuHtml(st.sheets.map(function(x) { return { key: x.key, label: x.label, checked: x.key === st.sheet }; })
            .concat([{ key: STAGE_ALL_SHEETS, label: 'All sheets in the export', checked: _stagePrintAll }]), 'data-onclick="stageSetSheet(this.dataset.key)"')
        : '') + '</span>');
  }
  if (st.source) {
    out += _stageCtl('Speed', 'Playback speed',
      _stageDropHtml('rate', 'rate', _stageRate + '×', 'Playback speed',
        [1, 0.9, 0.8, 0.7].map(function(r) { return { key: String(r), label: r + '×', checked: r === _stageRate }; }), 'data-onclick="stageSetRate(this.dataset.key)"'));
  }
  return out;
}

// Shows the state: controls, the recording with its waveform, the sheets. A
// recording that is already loaded keeps playing.
function _stageRenderControls(st) {
  var box = document.getElementById('_stage_controls');
  if (!box) return;
  var focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
  box.innerHTML = _stageControlsHtml(st);
  if (focused) { var again = box.querySelector('[data-fk="' + focused + '"]'); if (again) again.focus(); }
}

async function _stageRender() {
  var run = ++_stageRun;
  var st = _stageState();
  _stageRenderControls(st);
  await Promise.all([_stageRenderAudio(st, run), _stageRenderGallery(st, run)]);
}

async function _stageRenderAudio(st, run) {
  var box = document.getElementById('_stage_audio');
  if (!box) return;
  var src = st.source;
  if (!src) {
    box.dataset.shown = '';
    box.innerHTML = '';
    return;
  }
  var url = await _stageMediaUrl(src.url);
  if (run !== _stageRun || box.dataset.shown === src.url) return;
  box.dataset.shown = src.url;
  var label = st.view === 'voice' ? (st.voice.label || 'My voice') : _STAGE_VIEW_LABEL[st.view];
  box.innerHTML =
    '<div class="song-stage-rec"><span class="song-stage-rec-label"><span aria-hidden="true">&#9654; </span>' + escHtml(label) + '</span>' +
    _stageWaveHtml(src.waveform) +
    '<audio class="song-stage-audio" controls aria-label="' + escHtml(label) + '" src="' + escHtml(_stageMediaSrc(url)) + '"></audio></div>';
  box.querySelector('audio').playbackRate = _stageRate;
  _stageWaveWire(box);
}

// Sheet images as a gallery: swipe, or the arrows, one page at a time.
function stageGalleryStep(btn, dir) {
  var track = btn.parentNode.querySelector('.stage-gallery-track');
  track.scrollBy({ left: dir * track.clientWidth, behavior: 'smooth' });
}

function _stageGalleryWire(gallery) {
  var track = gallery.querySelector('.stage-gallery-track');
  var pages = track.children.length;
  var count = gallery.querySelector('.stage-gallery-count');
  var prev = gallery.querySelector('.stage-gallery-nav.prev');
  var next = gallery.querySelector('.stage-gallery-nav.next');
  if (!count) return;
  function update() {
    var i = Math.max(0, Math.min(pages - 1, Math.round(track.scrollLeft / (track.clientWidth || 1))));
    count.textContent = (i + 1) + ' / ' + pages;
    prev.disabled = i === 0;
    next.disabled = i === pages - 1;
  }
  track.addEventListener('scroll', update);
  update();
}

// Print only: the sheets for the export as plain blocks and images (the gallery
// itself, with its scrolling track and buttons, stays out of the print).
function _stagePrintHtml(sheets) {
  return '<div class="stage-print">' + sheets.map(function(x) {
    return '<div class="stage-print-sheet"><p class="stage-print-sheet-label">' + escHtml(x.label) + '</p>' + x.srcs.map(function(u) {
      return '<img class="stage-print-img" src="' + escHtml(_stageMediaSrc(u)) + '" alt="' + escHtml(x.label) + ' melody">';
    }).join('') + '</div>';
  }).join('') + '</div>';
}

async function _stagePrintSheets(st, imgUrls, label) {
  if (!_stagePrintAll) return imgUrls.length ? [{ label: label, srcs: imgUrls }] : [];
  return Promise.all(st.sheets.map(async function(x) {
    var urls = x.key === MELODY_SONG_KEY ? melodySongImages(_stageMelodies)
      : ((_stageMelodies.find(function(m) { return m.instrument === x.key; }) || {}).sheet_urls || []);
    return { label: x.label, srcs: await Promise.all(urls.map(_stageMediaUrl)) };
  }));
}

// The chosen voice's sheet images, centred at half the screen.
async function _stageRenderGallery(st, run) {
  var box = document.getElementById('_stage_melody');
  if (!box) return;
  var imgUrls = await Promise.all(st.images.map(_stageMediaUrl));
  if (run !== _stageRun) return;
  var picked = st.sheets.find(function(x) { return x.key === st.sheet; });
  var label = picked ? picked.label : st.voice.label;
  var note = { choose: 'Choose your voice to see its melody.', gone: 'Your saved voice is not set up any more. Choose again.' }[st.note] || '';
  var many = imgUrls.length > 1;
  box.innerHTML =
    (note ? '<p class="stage-message stage-melody-note">' + escHtml(note) + '</p>' : '') +
    (imgUrls.length
      ? '<div class="stage-gallery"><div class="stage-gallery-track">' + imgUrls.map(function(u, n) {
          return '<button type="button" class="stage-melody-zoom" data-onclick="stageZoomMelody(this)" aria-label="Zoom the melody sheet">' +
            '<img class="stage-melody-img" src="' + escHtml(_stageMediaSrc(u)) + '" alt="' + escHtml(label) + ' melody, page ' + (n + 1) + '"></button>';
        }).join('') + '</div>' +
        (many ? '<button type="button" class="stage-gallery-nav prev" data-onclick="stageGalleryStep(this, -1)" aria-label="Previous page">&#8249;</button>' +
          '<button type="button" class="stage-gallery-nav next" data-onclick="stageGalleryStep(this, 1)" aria-label="Next page">&#8250;</button>' +
          '<div class="stage-gallery-count" aria-live="polite"></div>' : '') + '</div>'
      : '');
  var forPrint = await _stagePrintSheets(st, imgUrls, label);
  if (run !== _stageRun) return;
  if (forPrint.length) box.insertAdjacentHTML('beforeend', _stagePrintHtml(forPrint));
  var gallery = box.querySelector('.stage-gallery');
  if (gallery) _stageGalleryWire(gallery);
  // The sheet pushes the lyrics down: fit the columns again once it is in, and
  // again as each image gets its height.
  if (_stageColsOn || _stageFitOn) {
    _stageRefit();
    box.querySelectorAll('img').forEach(function(img) { img.addEventListener('load', _stageRefit); });
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const el     = document.getElementById('stage-content');

  try {
    // Start network fetch immediately, but use cached config if available so
    // the slug is known synchronously and data fetches don't have to wait.
    // A single-band deployment's link is /stage without a slug: the empty slug
    // lets /api/config fall back to the deployment's ARTIST_SLUG.
    const _stageSeg  = window.location.pathname.split('/').filter(Boolean)[0] || '';
    const _stageSlug = _stageSeg === 'stage' ? '' : _stageSeg;
    // Light config: stage needs the band's name and settings, never its song
    // list (the setlist and song requests bring their own songs). Same cache
    // key as loadConfig(…, { light: true }), signed-out answers apart (_anon).
    var _stageCacheKey = 'artist_config_cache_' + (_stageSlug || 'default') + '_light' +
      (_stageToken() ? '' : '_anon');
    const cfgFetch = offlineFetch('/api/config?light=1' + (_stageSlug ? '&slug=' + encodeURIComponent(_stageSlug) : ''),
      _stageAuthHeaders()
    ).then(function(r) { return r.data; });
    var cfg;
    try { cfg = JSON.parse(sessionStorage.getItem(_stageCacheKey)) || await cfgFetch; }
    catch { cfg = await cfgFetch; }
    cfgFetch.then(function(fresh) {
      try { sessionStorage.setItem(_stageCacheKey, JSON.stringify(fresh)); } catch {}
    }).catch(function() {});

    _shareSlug = cfg.slug;

    if (params.get('song')) {
      await initSong(params, el, cfg);
    } else {
      await initSetlist(params, el, cfg);
    }
  } catch (err) {
    el.innerHTML = err && err.offline
      ? '<p class="stage-message">Not available offline. Open this setlist once while online.</p>'
      : '<p class="stage-message">Not found.</p>';
  }
}

async function initSetlist(params, el, cfg) {
  const setlistId = Number(params.get('id'));
  if (!setlistId) {
    el.innerHTML = '<p class="stage-message">No setlist ID provided.</p>';
    return;
  }

  _shareSetlistId = setlistId;
  _stageSetlistId = setlistId;
  const slRes = await offlineFetch(`/api/${cfg.slug}/setlists/${setlistId}`, _stageAuthHeaders());
  const data = slRes.data;
  try { sessionStorage.setItem('stage_sl_' + setlistId, JSON.stringify(data)); } catch {}

  const songs = data.songs ?? [];
  const gigParts = [data.gig_name, formatDate(data.gig_date), data.gig_venue]
    .filter(Boolean);
  const gigLine   = gigParts.join(' — ');
  const setTitle  = data.title ? `"${escHtml(data.title)}"` : '';
  const mainTitle = gigLine ? escHtml(gigLine) : (setTitle || `Setlist #${setlistId}`);

  document.title = `smartist · ${data.title || data.gig_name || 'Stage'} · ${cfg.name}`;

  let totalMin = 0;
  const items = songs.map((song, i) => {
    totalMin += song.length_min || 0;
    const gitCapo = song.extra && song.extra.gitCapo != null && !songFieldHidden(cfg.config, 'extra.gitCapo') ? song.extra.gitCapo : null;
    const bjCapo  = song.extra && song.extra.banjoCapo != null && !songFieldHidden(cfg.config, 'extra.banjoCapo') ? song.extra.banjoCapo : null;
    const badges = [
      song.key ? `<span class="stage-key"><span class="sr-only">Key </span>${escHtml(song.key)}</span>` : '',
      gitCapo !== null ? `<span class="stage-capo">Git: ${escHtml(String(gitCapo))}</span>` : '',
      bjCapo  !== null ? `<span class="stage-capo">Bj: ${escHtml(String(bjCapo))}</span>`  : '',
      song.extra && song.extra.aCapella && !songFieldHidden(cfg.config, 'extra.aCapella') ? `<span class="stage-capo">A cappella</span>` : '',
    ].join('');
    return `<li class="stage-song">
      <span class="stage-num">${i + 1}.</span>
      <a class="stage-song-title stage-song-link" href="/${cfg.slug}/stage?song=${song.id}&from=${setlistId}">${escHtml(song.title)}</a>
      ${badges ? `<span class="stage-badges">${badges}</span>` : ''}
    </li>`;
  }).join('');

  el.innerHTML = `${_stageOfflineNote(slRes)}
    <div class="stage-header">
      <div class="stage-band">${escHtml(cfg.name)}</div>
      <h1 class="stage-title">${mainTitle}</h1>
      ${gigLine && setTitle ? `<p class="stage-sub">${setTitle}</p>` : ''}
      ${data.comment ? `<p class="stage-sub" style="font-style:italic;">${escHtml(data.comment)}</p>` : ''}
      ${_shareHtml()}
    </div>
    <ul class="stage-list">${items}</ul>
    ${totalMin ? `<p class="stage-total">${songs.length} song${songs.length !== 1 ? 's' : ''} &middot; ${_stageLength(totalMin)}</p>` : ''}`;

  _stageOfflineRefresh();
  if (params.get('print') === '1') setTimeout(function() { window.print(); }, 400);
}

async function initSong(params, el, cfg) {
  const songId = Number(params.get('song'));
  const fromId = Number(params.get('from'));
  if (!songId) {
    el.innerHTML = '<p class="stage-message">No song ID provided.</p>';
    return;
  }

  _stageSetlistId = fromId;
  var cachedSl = null;
  if (fromId) {
    try { cachedSl = JSON.parse(sessionStorage.getItem('stage_sl_' + fromId)); } catch {}
  }
  const [songRes, slRes] = await Promise.all([
    offlineFetch(`/api/${cfg.slug}/songs/${songId}`, _stageAuthHeaders()),
    cachedSl         ? Promise.resolve({ data: cachedSl })
      : fromId       ? offlineFetch(`/api/${cfg.slug}/setlists/${fromId}`, _stageAuthHeaders()).catch(() => null)
      : Promise.resolve(null),
  ]);
  const song = songRes.data;
  const setlistData = slRes ? slRes.data : null;

  // The active arrangement comes with the song's details.
  var activeArr   = song.active_arrangement || null;
  var arrConfig   = (cfg.config && cfg.config.arrangementConfig) || null;
  window._stageActiveArr = activeArr;
  window._stageArrConfig = arrConfig;

  var navHtml = '';
  if (setlistData) {
    const navSongs = setlistData.songs ?? [];
    const navIdx   = navSongs.findIndex(s => s.id === songId);
    if (navIdx >= 0) navHtml = _navHtml(fromId, navSongs, navIdx);
  }

  document.title = `smartist · ${song.title} · ${cfg.name}`;

  const extra   = song.extra || {};
  // Lyrics come with the song's details (GET /songs/:id), not inside extra.
  const lyrics  = song.lyrics || '';
  const gitCapo = extra.gitCapo   != null && !songFieldHidden(cfg.config, 'extra.gitCapo')   ? extra.gitCapo   : null;
  const bjCapo  = extra.banjoCapo != null && !songFieldHidden(cfg.config, 'extra.banjoCapo') ? extra.banjoCapo : null;
  const audioRe = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i;

  // Subtitle: interpret · genre
  const subParts = [song.interpret, song.genre].filter(Boolean);
  const subtitle = subParts.length ? `<p class="stage-sub">${escHtml(subParts.join(' · '))}</p>` : '';

  // Meta badges — reuse .stage-key / .stage-capo from the setlist view
  const metaBadges = [
    song.key         ? `<span class="stage-key"><span class="sr-only">Key </span>${escHtml(song.key)}</span>`          : '',
    gitCapo !== null ? `<span class="stage-capo">Git: ${escHtml(String(gitCapo))}</span>` : '',
    bjCapo  !== null ? `<span class="stage-capo">Bj: ${escHtml(String(bjCapo))}</span>`  : '',
    extra.lead && !songFieldHidden(cfg.config, 'extra.lead') ? `<span class="stage-capo">${escHtml(extra.lead)}</span>`        : '',
    extra.aCapella && !songFieldHidden(cfg.config, 'extra.aCapella') ? `<span class="stage-capo">A cappella</span>` : '',
    song.bpm         ? `<span class="stage-capo">${song.bpm} bpm</span>`               : '',
    song.length_min  ? `<span class="stage-capo">${_stageLength(song.length_min)}</span>` : '',
  ].filter(Boolean).join('');

  _stageMelodies = Array.isArray(song.melodies) ? song.melodies : [];
  _stageInstruments = (arrConfig && arrConfig.instruments) || [];
  _stageExtra = extra;
  _stageView = null;
  _stageSheet = null;
  const hasMelodies = melodyVoices(_stageMelodies, _stageInstruments).length > 0;
  // One player for every recording the song has (Listen, Playback, a voice's
  // own); a link that is not an audio file stays a link.
  const anyAudio = melodySources(extra, null).length > 0 || _stageMelodies.some(m => m.audio_url);
  const hasSheets = hasMelodies || melodySongImages(_stageMelodies).length > 0;

  // Links
  const linkItems = [
    extra.listenUrl && !audioRe.test(extra.listenUrl)     ? `<a class="song-stage-link" href="${escHtml(safeUrl(extra.listenUrl))}" target="_blank" rel="noopener">&#9654; Listen</a>` : '',
    extra.playbackUrl && !audioRe.test(extra.playbackUrl) ? `<a class="song-stage-link" href="${escHtml(safeUrl(extra.playbackUrl))}" target="_blank" rel="noopener">&#9655; Playback</a>` : '',
    extra.sheetUrl     ? `<a class="song-stage-link" href="${escHtml(safeUrl(extra.sheetUrl))}"      target="_blank" rel="noopener">&#8801; Sheet music</a>` : '',
    extra.referenceUrl ? `<a class="song-stage-link" href="${escHtml(safeUrl(extra.referenceUrl))}"  target="_blank" rel="noopener">&#9654; Reference</a>`   : '',
    extra.songinfoUrl  ? `<a class="song-stage-link" href="${escHtml(safeUrl(extra.songinfoUrl))}"   target="_blank" rel="noopener">&#8505; Song info</a>`    : '',
    activeArr
      ? `<button class="stage-chart-btn" data-onclick="_openActiveArrPopup()" aria-haspopup="dialog" title="Show arrangement chart">` +
        `<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>` +
        `<span style="font-size:11px">ARRANGEMENT</span></button>`
      : '',
  ].filter(Boolean);
  const linksHtml = linkItems.length ? `<div class="song-stage-section song-stage-links stage-narrow">${linkItems.join('')}</div>` : '';

  var _FIT_ICON = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';
  const lyricsHtml = lyrics
    ? `<div id="_stage_structure" class="stage-structure"></div>
       <div class="song-stage-lyrics" id="_stage_lyrics"></div>
       <div class="lyrics-size-bar" role="group" aria-label="Lyrics size">
         <button class="stage-share-btn" data-onclick="stageFontDown()" aria-label="Smaller text" title="Smaller text"><span aria-hidden="true" style="font-size:11px;letter-spacing:-0.03em">A−</span></button>
         <button class="stage-share-btn" id="_stage_fit_btn" data-onclick="stageFitLyrics()" aria-pressed="${_stageFitOn}" aria-label="Fit lyrics to screen" title="Fit to screen">${_FIT_ICON}</button>
         <button class="stage-share-btn" data-onclick="stageFontUp()" aria-label="Larger text" title="Larger text"><span aria-hidden="true" style="font-size:11px;letter-spacing:-0.03em">A+</span></button>
         <button class="stage-share-btn" id="_stage_cols_btn" data-onclick="stageToggleColumns()" aria-pressed="${_stageColsOn}" aria-label="Lyrics in columns, fitted to the screen" title="Columns"><span aria-hidden="true" style="font-size:11px">▥</span></button>
         ${chordsHas(lyrics) ? `
         <button class="stage-share-btn" id="_stage_chords_btn" data-onclick="stageToggleChords()" aria-pressed="${_stageChordsOn}" aria-label="Show chords" title="Chords"><span aria-hidden="true" style="font-size:11px">Am</span></button>
         <button class="stage-share-btn" id="_stage_struct_btn" data-onclick="stageToggleStructure()" aria-pressed="${_stageStructOn}" aria-label="Show song structure" title="Structure"><span aria-hidden="true" style="font-size:11px">A·B</span></button>
         <button class="stage-share-btn" id="_stage_num_btn" data-onclick="stageToggleNumbers()" aria-pressed="${_stageNumbersOn}" aria-label="Nashville numbers" title="Numbers"${_stageStructOn ? '' : ' style="display:none"'}><span aria-hidden="true" style="font-size:11px">1·4</span></button>
         <button class="stage-share-btn" data-onclick="stageTranspose(-1)" aria-label="Transpose down" title="Transpose down"><span aria-hidden="true" style="font-size:11px">♭</span></button>
         <span id="_stage_transpose_val" class="stage-transpose-val">0</span>
         <button class="stage-share-btn" data-onclick="stageTranspose(1)" aria-label="Transpose up" title="Transpose up"><span aria-hidden="true" style="font-size:11px">♯</span></button>${
           [['git', 'Guitar', gitCapo], ['bj', 'Banjo', bjCapo]].filter(c => Number(c[2]) > 0).map(c =>
             `<button class="stage-share-btn" id="_stage_capo_${c[0]}" data-onclick="stageCapo('${c[0]}')" aria-pressed="${_stageCapoInst === c[0]}" aria-label="${c[1]} capo ${Number(c[2])}: show shapes" title="${c[1]} capo ${Number(c[2])}"><span aria-hidden="true" style="font-size:11px">${c[0] === 'git' ? 'Git' : 'Bj'} ${Number(c[2])}</span></button>`).join('')}` : ''}
       </div>`
    : `<p class="stage-message" style="padding:3rem 0">No lyrics saved.</p>`;

  el.innerHTML = `${_stageOfflineNote(songRes)}
    <div class="stage-header stage-narrow${navHtml ? ' stage-header--nav' : ''}">
      <div class="stage-band">${escHtml(cfg.name)}</div>
      <h1 class="stage-title">${escHtml(song.title)}</h1>
      ${subtitle}
      ${_shareHtml(navHtml)}
    </div>
    ${metaBadges ? `<div class="song-stage-meta stage-narrow">${metaBadges}</div>` : ''}
    ${anyAudio || hasMelodies ? '<div id="_stage_player" class="song-stage-section stage-narrow"><div id="_stage_controls" class="stage-controls"></div><div id="_stage_audio"></div></div>' : ''}
    ${linksHtml}
    ${hasSheets ? '<section id="_stage_melody" class="stage-melody" aria-label="Melody"></section>' : ''}
    ${lyricsHtml}`;
  if (anyAudio || hasSheets) _stageRender();
  _stageOfflineRefresh();

  if (lyrics) {
    _stageLyricsText = lyrics;
    _stageKey = song.key || '';
    _stageSteps = 0;
    _stageCapos = { git: Number(gitCapo) || 0, bj: Number(bjCapo) || 0 };
    _applyLyricsSize();
    _stageRenderLyrics();
  }

  if (params.get('print') === '1') setTimeout(function() { window.print(); }, 400);
}

applyStageTheme(localStorage.getItem('stage_light_mode') === '1');
init();

// Scale root font-size before printing so all songs fit on one page.
// All print sizes are in rem, so this scales the whole layout proportionally.
// Target 900px usable height (A4 with 1.5cm margins); estimate ~30px/song at 16px base.
window.addEventListener('beforeprint', function() {
  var count = document.querySelectorAll('.stage-song').length;
  if (!count) return;
  var needed = 142 + count * 30;
  if (needed > 900) {
    document.documentElement.style.fontSize = Math.max(9, Math.round(16 * 900 / needed)) + 'px';
  }
  // Inject arrangement table inline for print (stage popup is a modal, won't print)
  if (window._stageActiveArr && typeof _arrReadOnlyHtml === 'function') {
    var existing = document.getElementById('_stage_arr_print');
    if (!existing) {
      var div = document.createElement('div');
      div.id        = '_stage_arr_print';
      div.className = 'stage-arr-print';
      div.innerHTML = _arrReadOnlyHtml(window._stageActiveArr, window._stageArrConfig);
      var main = document.querySelector('main') || document.body;
      main.appendChild(div);
    }
  }
});
window.addEventListener('afterprint', function() {
  document.documentElement.style.fontSize = '';
  var div = document.getElementById('_stage_arr_print');
  if (div) div.remove();
});

// --- Share menu ---

function _stageMenuOpen() {
  var menu = document.getElementById('stage-share-menu');
  return !!menu && menu.style.display !== 'none';
}

function _setStageMenu(open, focusButton) {
  var menu = document.getElementById('stage-share-menu');
  var btn  = document.getElementById('stage-share-btn');
  if (!menu) return;
  menu.style.display = open ? 'block' : 'none';
  if (btn) btn.setAttribute('aria-expanded', String(open));
  if (open) {
    document.addEventListener('click', _closeStageMenu);
    var first = menu.querySelector('button');
    if (first) first.focus();
  } else {
    document.removeEventListener('click', _closeStageMenu);
    if (focusButton && btn) btn.focus();
  }
}

function _closeStageMenu(e) {
  var menu = document.getElementById('stage-share-menu');
  if (menu && !menu.contains(e.target)) _setStageMenu(false);
}

function toggleStageShareMenu(e) {
  e.stopPropagation();
  _setStageMenu(!_stageMenuOpen());
}

function stageSharePrint() {
  _setStageMenu(false);
  window.print();
}

function stageShareCopyLink() {
  navigator.clipboard.writeText(window.location.href).then(function() {
    var label = document.getElementById('stage-copy-label');
    if (label) {
      label.textContent = 'Copied!';
      setTimeout(function() { label.textContent = 'Copy link'; }, 1500);
    }
    _stageAnnounce('Link copied');
  });
}

// --- Email dialog ---

function _stageEmailOpen() {
  var modal = document.getElementById('stage-share-modal');
  return !!modal && modal.style.display !== 'none';
}

function stageShareEmail() {
  _setStageMenu(false);
  var hasToken = !!_stageToken();
  var pwField = document.getElementById('stage-modal-pw-field');
  if (pwField) pwField.style.display = hasToken ? 'none' : '';
  var signin = document.getElementById('stage-share-signin');
  if (signin) signin.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  document.getElementById('stage-share-status').textContent = '';
  document.getElementById('stage-share-email').value = '';
  var sendBtn = document.getElementById('stage-share-send');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send PDF'; }
  document.getElementById('stage-share-modal').style.display = 'flex';
  var focusId = hasToken ? 'stage-share-email' : 'stage-share-signin';
  setTimeout(function() {
    var el = document.getElementById(focusId);
    if (el) el.focus();
  }, 50);
}

// Focus goes back to the share button the dialog was opened from.
function stageCloseEmail() {
  document.getElementById('stage-share-modal').style.display = 'none';
  var btn = document.getElementById('stage-share-btn');
  if (btn) btn.focus();
}

function stageEmailBackdrop(e, overlay) {
  if (e.target === overlay) stageCloseEmail();
}

// Tab stays inside the dialog while it is open.
function _trapStageDialog(e) {
  var modal = document.querySelector('#stage-share-modal .stage-modal');
  var items = [].filter.call(modal.querySelectorAll('a[href], button, input'), function(el) {
    return !el.disabled && el.offsetParent !== null;
  });
  if (!items.length) return;
  var first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

async function stageSendEmail() {
  var email  = (document.getElementById('stage-share-email').value || '').trim();
  var status = document.getElementById('stage-share-status');
  var btn    = document.getElementById('stage-share-send');

  if (!email) {
    status.textContent = 'Please enter an email address.';
    document.getElementById('stage-share-email').focus();
    return;
  }

  var token = _stageToken();
  if (!token) {
    status.textContent = 'Sign in to send the setlist.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  status.textContent = '';

  var result = await sendSetlistEmail(_shareSlug, _shareSetlistId, email, token);

  if (result.ok) {
    status.textContent = 'Sent to ' + email;
    btn.disabled = true;
    setTimeout(function() {
      if (_stageEmailOpen()) stageCloseEmail();
    }, 1800);
  } else {
    status.textContent = result.error;
    btn.disabled = false;
    btn.textContent = 'Send PDF';
  }
}

// --- Keyboard and page-turner pedals ---
// Escape closes the open layer. ← / → go to the previous / next song of the
// setlist (Bluetooth pedals send arrow keys); Page Up / Down keep scrolling.
document.addEventListener('keydown', function(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Escape') {
    if (_stageEmailOpen()) { e.preventDefault(); stageCloseEmail(); return; }
    if (_stageMenuOpen())  { e.preventDefault(); _setStageMenu(false, true); return; }
    return;
  }
  if (e.key === 'Tab' && _stageEmailOpen()) { _trapStageDialog(e); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (_stageEmailOpen() || _stageMenuOpen()) return;
  if (document.querySelector('.arr-stage-modal-overlay.open')) return;
  var t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|AUDIO|VIDEO)$/.test(t.tagName))) return;
  var link = document.getElementById(e.key === 'ArrowLeft' ? 'stage-prev' : 'stage-next');
  if (!link) return;
  e.preventDefault();
  window.location.href = link.href;
});
