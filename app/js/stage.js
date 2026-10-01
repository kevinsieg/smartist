// Stage view — full-screen setlist for on-stage use

function _setAudioSpeed(btn, rate) {
  var wrap = btn.closest('.song-stage-rec');
  var audio = wrap && wrap.querySelector('audio');
  if (audio) audio.playbackRate = rate;
  btn.parentNode.querySelectorAll('button').forEach(function(b) {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
}

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

function _speedBtns(label) {
  return '<div class="audio-speed-btns" role="group" aria-label="' + label + ' speed">' +
    [0.7, 0.8, 0.9].map(function(r) {
      return '<button aria-pressed="false" data-onclick="_setAudioSpeed(this,' + r + ')">' + r + '×</button>';
    }).join('') + '</div>';
}

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

// ── Lyrics font size ───────────────────────────────────────────────────────────
var _stageLyricsPx = parseInt(localStorage.getItem('stage_lyrics_px')) || 22;

function _applyLyricsSize() {
  var el = document.getElementById('_stage_lyrics');
  if (el) el.style.fontSize = _stageLyricsPx + 'px';
}

function stageFontUp() {
  _stageLyricsPx = Math.min(80, Math.round(_stageLyricsPx * 1.15));
  localStorage.setItem('stage_lyrics_px', _stageLyricsPx);
  _applyLyricsSize();
}

function stageFontDown() {
  _stageLyricsPx = Math.max(8, Math.round(_stageLyricsPx / 1.15));
  localStorage.setItem('stage_lyrics_px', _stageLyricsPx);
  _applyLyricsSize();
}

function stageFitLyrics() {
  var el = document.getElementById('_stage_lyrics');
  if (!el) return;
  var availH = window.innerHeight - el.getBoundingClientRect().top - 24;
  if (availH < 40) return;
  var lo = 7, hi = 96, best = lo;
  for (var i = 0; i < 16; i++) {
    var mid = (lo + hi) / 2;
    el.style.fontSize = mid + 'px';
    if (el.scrollHeight <= availH) { best = mid; lo = mid; } else hi = mid;
  }
  _stageLyricsPx = Math.floor(best);
  localStorage.setItem('stage_lyrics_px', _stageLyricsPx);
  el.style.fontSize = _stageLyricsPx + 'px';
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

function _shareHtml(navHtml) {
  var light = document.body.classList.contains('stage-light');
  return `<div class="stage-header-btns">
    ${navHtml || ''}
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

async function init() {
  const params = new URLSearchParams(window.location.search);
  const el     = document.getElementById('stage-content');

  try {
    // Start network fetch immediately, but use cached config if available so
    // the slug is known synchronously and data fetches don't have to wait.
    // Legacy single-tenant links use /stage without a slug — the empty slug
    // lets /api/config fall back to the deployment's ARTIST_SLUG.
    const _stageSeg  = window.location.pathname.split('/').filter(Boolean)[0] || '';
    const _stageSlug = _stageSeg === 'stage' ? '' : _stageSeg;
    var _stageCacheKey = 'artist_config_cache_' + (_stageSlug || 'default');
    const cfgFetch = fetch('/api/config' + (_stageSlug ? '?slug=' + encodeURIComponent(_stageSlug) : ''),
      { headers: _stageAuthHeaders() }
    ).then(r => { if (!r.ok) throw new Error(); return r.json(); });
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
  } catch {
    el.innerHTML = '<p class="stage-message">Not found.</p>';
  }
}

async function initSetlist(params, el, cfg) {
  const setlistId = Number(params.get('id'));
  if (!setlistId) {
    el.innerHTML = '<p class="stage-message">No setlist ID provided.</p>';
    return;
  }

  _shareSetlistId = setlistId;
  const data = await fetch(`/api/${cfg.slug}/setlists/${setlistId}`, { headers: _stageAuthHeaders() }).then(r => {
    if (!r.ok) throw new Error('not found');
    return r.json();
  });
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

  el.innerHTML = `
    <div class="stage-header">
      <div class="stage-band">${escHtml(cfg.name)}</div>
      <h1 class="stage-title">${mainTitle}</h1>
      ${gigLine && setTitle ? `<p class="stage-sub">${setTitle}</p>` : ''}
      ${data.comment ? `<p class="stage-sub" style="font-style:italic;">${escHtml(data.comment)}</p>` : ''}
      ${_shareHtml()}
    </div>
    <ul class="stage-list">${items}</ul>
    ${totalMin ? `<p class="stage-total">${songs.length} song${songs.length !== 1 ? 's' : ''} &middot; ${_stageLength(totalMin)}</p>` : ''}`;

  if (params.get('print') === '1') setTimeout(function() { window.print(); }, 400);
}

async function initSong(params, el, cfg) {
  const songId = Number(params.get('song'));
  const fromId = Number(params.get('from'));
  if (!songId) {
    el.innerHTML = '<p class="stage-message">No song ID provided.</p>';
    return;
  }

  var cachedSl = null;
  if (fromId) {
    try { cachedSl = JSON.parse(sessionStorage.getItem('stage_sl_' + fromId)); } catch {}
  }
  const [song, setlistData] = await Promise.all([
    fetch(`/api/${cfg.slug}/songs/${songId}`, { headers: _stageAuthHeaders() }).then(r => {
      if (!r.ok) throw new Error('not found');
      return r.json();
    }),
    cachedSl         ? Promise.resolve(cachedSl)
      : fromId       ? fetch(`/api/${cfg.slug}/setlists/${fromId}`, { headers: _stageAuthHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Fetch active arrangement if one exists
  var activeArr   = null;
  var arrConfig   = (cfg.config && cfg.config.arrangementConfig) || null;
  var activeArrMeta = (song.arrangements || []).find(function(a) { return a.is_active; });
  if (activeArrMeta) {
    try {
      var arrVersions = await fetch('/api/' + cfg.slug + '/songs/' + songId + '/arrangements', { headers: _stageAuthHeaders() }).then(function(r) { if (!r.ok) throw new Error(); return r.json(); });
      activeArr = Array.isArray(arrVersions) ? arrVersions.find(function(v) { return v.is_active; }) || null : null;
    } catch (_) {}
  }
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
    song.tempo       ? `<span class="stage-capo">${escHtml(song.tempo)}</span>`        : '',
    song.bpm         ? `<span class="stage-capo">${song.bpm} bpm</span>`               : '',
    song.length_min  ? `<span class="stage-capo">${_stageLength(song.length_min)}</span>` : '',
  ].filter(Boolean).join('');

  // Recordings
  let recItems = [];
  if (extra.listenUrl) {
    recItems.push(audioRe.test(extra.listenUrl)
      ? `<div class="song-stage-rec"><span class="song-stage-rec-label"><span aria-hidden="true">&#9654; </span>Listen</span><audio class="song-stage-audio" controls aria-label="Listen" src="${escHtml(safeUrl(extra.listenUrl))}"></audio>${_speedBtns('Listen')}</div>`
      : `<a class="song-stage-link" href="${escHtml(safeUrl(extra.listenUrl))}" target="_blank" rel="noopener">&#9654; Listen</a>`);
  }
  if (extra.playbackUrl) {
    recItems.push(audioRe.test(extra.playbackUrl)
      ? `<div class="song-stage-rec"><span class="song-stage-rec-label"><span aria-hidden="true">&#9655; </span>Playback</span><audio class="song-stage-audio" controls aria-label="Playback" src="${escHtml(safeUrl(extra.playbackUrl))}"></audio>${_speedBtns('Playback')}</div>`
      : `<a class="song-stage-link" href="${escHtml(safeUrl(extra.playbackUrl))}" target="_blank" rel="noopener">&#9655; Playback</a>`);
  }
  const recHtml = recItems.length ? `<div class="song-stage-section">${recItems.join('')}</div>` : '';

  // Links
  const linkItems = [
    extra.sheetUrl     ? `<a class="song-stage-link" href="${escHtml(safeUrl(extra.sheetUrl))}"      target="_blank" rel="noopener">&#8801; Sheet music</a>` : '',
    extra.referenceUrl ? `<a class="song-stage-link" href="${escHtml(safeUrl(extra.referenceUrl))}"  target="_blank" rel="noopener">&#9654; Reference</a>`   : '',
    extra.songinfoUrl  ? `<a class="song-stage-link" href="${escHtml(safeUrl(extra.songinfoUrl))}"   target="_blank" rel="noopener">&#8505; Song info</a>`    : '',
    activeArr
      ? `<button class="stage-chart-btn" data-onclick="_openActiveArrPopup()" aria-haspopup="dialog" title="Show arrangement chart">` +
        `<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>` +
        `<span style="font-size:11px">ARRANGEMENT</span></button>`
      : '',
  ].filter(Boolean);
  const linksHtml = linkItems.length ? `<div class="song-stage-section song-stage-links">${linkItems.join('')}</div>` : '';

  var _FIT_ICON = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';
  const lyricsHtml = lyrics
    ? `<div class="song-stage-lyrics" id="_stage_lyrics"></div>
       <div class="lyrics-size-bar" role="group" aria-label="Lyrics size">
         <button class="stage-share-btn" data-onclick="stageFontDown()" aria-label="Smaller text" title="Smaller text"><span aria-hidden="true" style="font-size:11px;letter-spacing:-0.03em">A−</span></button>
         <button class="stage-share-btn" data-onclick="stageFitLyrics()" aria-label="Fit lyrics to screen" title="Fit to screen">${_FIT_ICON}</button>
         <button class="stage-share-btn" data-onclick="stageFontUp()" aria-label="Larger text" title="Larger text"><span aria-hidden="true" style="font-size:11px;letter-spacing:-0.03em">A+</span></button>
       </div>`
    : `<p class="stage-message" style="padding:3rem 0">No lyrics saved.</p>`;

  el.innerHTML = `
    <div class="stage-header${navHtml ? ' stage-header--nav' : ''}">
      <div class="stage-band">${escHtml(cfg.name)}</div>
      <h1 class="stage-title">${escHtml(song.title)}</h1>
      ${subtitle}
      ${_shareHtml(navHtml)}
    </div>
    ${metaBadges ? `<div class="song-stage-meta">${metaBadges}</div>` : ''}
    ${recHtml}
    ${linksHtml}
    ${lyricsHtml}`;

  if (lyrics) {
    document.getElementById('_stage_lyrics').textContent = lyrics;
    _applyLyricsSize();
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
