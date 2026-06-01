// Stage view — full-screen setlist for on-stage use

var _shareSlug      = null;
var _shareSetlistId = null;

var _SUN_ICON  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
var _MOON_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatLength(min) {
  if (!min) return '';
  const m = Math.floor(min);
  const s = Math.round((min - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function _shareHtml(navHtml) {
  var light = document.body.classList.contains('stage-light');
  return `<div class="stage-header-btns">
    ${navHtml || ''}
    <button class="stage-invert-btn" id="stage-invert-btn" onclick="toggleStageInvert()" title="${light ? 'Switch to dark mode' : 'Switch to light mode'}">${light ? _MOON_ICON : _SUN_ICON}</button>
    <button class="stage-share-btn" id="stage-share-btn" onclick="toggleStageShareMenu(event)" title="Share"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>
    <div class="stage-share-menu" id="stage-share-menu" style="display:none">
      <button class="stage-share-item" onclick="stageSharePrint()"><span class="stage-share-icon">⎙</span>Print / Export PDF</button>
      <button class="stage-share-item" onclick="stageShareCopyLink()"><span class="stage-share-icon">⧉</span><span id="stage-copy-label">Copy link</span></button>
      <button class="stage-share-item" onclick="stageShareEmail()"><span class="stage-share-icon">✉</span>Share via email</button>
    </div>
  </div>`;
}

function _navHtml(setlistId, songs, idx) {
  var prevSong = idx > 0 ? songs[idx - 1] : null;
  var nextSong = idx < songs.length - 1 ? songs[idx + 1] : null;
  var listIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
  var prevIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="15 18 9 12 15 6"/></svg>';
  var nextIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="9 18 15 12 9 6"/></svg>';
  var backBtn = `<a class="stage-share-btn" href="/stage?id=${setlistId}" title="Back to setlist">${listIcon}</a>`;
  var prevBtn = prevSong
    ? `<a class="stage-share-btn" href="/stage?song=${prevSong.id}&from=${setlistId}" title="${escHtml(prevSong.title)}">${prevIcon}</a>`
    : `<button class="stage-share-btn" disabled title="No previous song">${prevIcon}</button>`;
  var nextBtn = nextSong
    ? `<a class="stage-share-btn" href="/stage?song=${nextSong.id}&from=${setlistId}" title="${escHtml(nextSong.title)}">${nextIcon}</a>`
    : `<button class="stage-share-btn" disabled title="No next song">${nextIcon}</button>`;
  return `${backBtn}${prevBtn}${nextBtn}<span class="stage-nav-sep"></span>`;
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
    btn.innerHTML = light ? _MOON_ICON : _SUN_ICON;
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const el     = document.getElementById('stage-content');

  try {
    // Start network fetch immediately, but use cached config if available so
    // the slug is known synchronously and data fetches don't have to wait.
    const cfgFetch = fetch('/api/config').then(r => { if (!r.ok) throw new Error(); return r.json(); });
    var cfg;
    try { cfg = JSON.parse(sessionStorage.getItem('artist_config_cache')) || await cfgFetch; }
    catch { cfg = await cfgFetch; }
    cfgFetch.then(function(fresh) {
      try { sessionStorage.setItem('artist_config_cache', JSON.stringify(fresh)); } catch {}
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
  const data = await fetch(`/api/${cfg.slug}/setlists/${setlistId}`).then(r => {
    if (!r.ok) throw new Error('not found');
    return r.json();
  });
  try { sessionStorage.setItem('stage_sl_' + setlistId, JSON.stringify(data)); } catch {}

  const songs = data.songs ?? [];
  const gigParts = [data.gig_name, data.gig_date ? String(data.gig_date).slice(0, 10) : null, data.gig_venue]
    .filter(Boolean);
  const gigLine   = gigParts.join(' — ');
  const setTitle  = data.title ? `"${escHtml(data.title)}"` : '';
  const mainTitle = gigLine ? escHtml(gigLine) : (setTitle || `Setlist #${setlistId}`);

  document.title = `${data.title || data.gig_name || 'Stage'} — ${cfg.name}`;

  let totalMin = 0;
  const items = songs.map((song, i) => {
    totalMin += song.length_min || 0;
    const gitCapo = song.extra && song.extra.gitCapo != null ? song.extra.gitCapo : null;
    const bjCapo  = song.extra && song.extra.banjoCapo != null ? song.extra.banjoCapo : null;
    return `<li class="stage-song">
      <span class="stage-num">${i + 1}.</span>
      <a class="stage-song-title stage-song-link" href="/stage?song=${song.id}&from=${setlistId}">${escHtml(song.title)}</a>
      ${song.key     ? `<span class="stage-key">${escHtml(song.key)}</span>`    : ''}
      ${gitCapo !== null ? `<span class="stage-capo">Git: ${gitCapo}</span>` : ''}
      ${bjCapo  !== null ? `<span class="stage-capo">Bj: ${bjCapo}</span>`   : ''}
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
    ${totalMin ? `<p class="stage-total">${songs.length} song${songs.length !== 1 ? 's' : ''} &middot; ${formatLength(totalMin)}</p>` : ''}`;

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
    fetch(`/api/${cfg.slug}/songs/${songId}`).then(r => {
      if (!r.ok) throw new Error('not found');
      return r.json();
    }),
    cachedSl         ? Promise.resolve(cachedSl)
      : fromId       ? fetch(`/api/${cfg.slug}/setlists/${fromId}`).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Fetch active arrangement if one exists
  var activeArr   = null;
  var arrConfig   = (cfg.config && cfg.config.arrangementConfig) || null;
  var activeArrMeta = (song.arrangements || []).find(function(a) { return a.is_active; });
  if (activeArrMeta) {
    try {
      var arrVersions = await fetch('/api/' + cfg.slug + '/songs/' + songId + '/arrangements').then(function(r) { if (!r.ok) throw new Error(); return r.json(); });
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

  var chartBtnHtml = activeArr
    ? '<button class="stage-chart-btn" onclick="openArrStagePopup(window._stageActiveArr, window._stageArrConfig)" title="Show arrangement chart">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>' +
      '<span style="font-size:11px">ARRANGEMENT</span>' +
    '</button>'
    : '';

  document.title = `${song.title} — ${cfg.name}`;

  const extra   = song.extra || {};
  const gitCapo = extra.gitCapo   != null ? extra.gitCapo   : null;
  const bjCapo  = extra.banjoCapo != null ? extra.banjoCapo : null;
  const audioRe = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i;

  // Subtitle: interpret · genre
  const subParts = [song.interpret, song.genre].filter(Boolean);
  const subtitle = subParts.length ? `<p class="stage-sub">${escHtml(subParts.join(' · '))}</p>` : '';

  // Meta badges — reuse .stage-key / .stage-capo from the setlist view
  const metaBadges = [
    song.key         ? `<span class="stage-key">${escHtml(song.key)}</span>`          : '',
    gitCapo !== null ? `<span class="stage-capo">Git: ${escHtml(String(gitCapo))}</span>` : '',
    bjCapo  !== null ? `<span class="stage-capo">Bj: ${escHtml(String(bjCapo))}</span>`  : '',
    extra.lead       ? `<span class="stage-capo">${escHtml(extra.lead)}</span>`        : '',
    song.tempo       ? `<span class="stage-capo">${escHtml(song.tempo)}</span>`        : '',
    song.bpm         ? `<span class="stage-capo">${song.bpm} bpm</span>`               : '',
    song.length_min  ? `<span class="stage-capo">${formatLength(song.length_min)}</span>` : '',
  ].filter(Boolean).join('');

  // Recordings
  let recItems = [];
  if (extra.listenUrl) {
    recItems.push(audioRe.test(extra.listenUrl)
      ? `<div class="song-stage-rec"><span class="song-stage-rec-label">&#9654; Listen</span><audio class="song-stage-audio" controls src="${escHtml(extra.listenUrl)}"></audio></div>`
      : `<a class="song-stage-link" href="${escHtml(extra.listenUrl)}" target="_blank" rel="noopener">&#9654; Listen</a>`);
  }
  if (extra.playbackUrl) {
    recItems.push(audioRe.test(extra.playbackUrl)
      ? `<div class="song-stage-rec"><span class="song-stage-rec-label">&#9655; Playback</span><audio class="song-stage-audio" controls src="${escHtml(extra.playbackUrl)}"></audio></div>`
      : `<a class="song-stage-link" href="${escHtml(extra.playbackUrl)}" target="_blank" rel="noopener">&#9655; Playback</a>`);
  }
  const recHtml = recItems.length ? `<div class="song-stage-section">${recItems.join('')}</div>` : '';

  // Links
  const linkItems = [
    extra.sheetUrl     ? `<a class="song-stage-link" href="${escHtml(extra.sheetUrl)}"      target="_blank" rel="noopener">&#8801; Sheet music</a>` : '',
    extra.referenceUrl ? `<a class="song-stage-link" href="${escHtml(extra.referenceUrl)}"  target="_blank" rel="noopener">&#9654; Reference</a>`   : '',
    extra.songinfoUrl  ? `<a class="song-stage-link" href="${escHtml(extra.songinfoUrl)}"   target="_blank" rel="noopener">&#8505; Song info</a>`    : '',
  ].filter(Boolean);
  const linksHtml = linkItems.length ? `<div class="song-stage-section song-stage-links">${linkItems.join('')}</div>` : '';

  const lyricsHtml = extra.lyrics
    ? `<div class="song-stage-lyrics" id="_stage_lyrics"></div>`
    : `<p class="stage-message" style="padding:3rem 0">No lyrics saved.</p>`;

  el.innerHTML = `
    <div class="stage-header"${navHtml ? ' style="padding-right:13rem"' : ''}>
      <div class="stage-band">${escHtml(cfg.name)}</div>
      <h1 class="stage-title">${escHtml(song.title)}</h1>
      ${subtitle}
      ${chartBtnHtml ? '<div class="stage-chart-wrap">' + chartBtnHtml + '</div>' : ''}
      ${_shareHtml(navHtml)}
    </div>
    ${metaBadges ? `<div class="song-stage-meta">${metaBadges}</div>` : ''}
    ${recHtml}
    ${linksHtml}
    ${lyricsHtml}`;

  if (extra.lyrics) {
    document.getElementById('_stage_lyrics').textContent = extra.lyrics;
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

function _closeStageMenu(e) {
  var menu = document.getElementById('stage-share-menu');
  if (menu && !menu.contains(e.target)) {
    menu.style.display = 'none';
    document.removeEventListener('click', _closeStageMenu);
  }
}

function toggleStageShareMenu(e) {
  e.stopPropagation();
  var menu = document.getElementById('stage-share-menu');
  if (!menu) return;
  if (menu.style.display === 'none') {
    menu.style.display = 'block';
    document.addEventListener('click', _closeStageMenu);
  } else {
    menu.style.display = 'none';
    document.removeEventListener('click', _closeStageMenu);
  }
}

function stageSharePrint() {
  document.getElementById('stage-share-menu').style.display = 'none';
  document.removeEventListener('click', _closeStageMenu);
  window.print();
}

function stageShareCopyLink() {
  navigator.clipboard.writeText(window.location.href).then(function() {
    var label = document.getElementById('stage-copy-label');
    if (label) {
      label.textContent = 'Copied!';
      setTimeout(function() { label.textContent = 'Copy link'; }, 1500);
    }
  });
}

function stageShareEmail() {
  document.getElementById('stage-share-menu').style.display = 'none';
  document.removeEventListener('click', _closeStageMenu);
  var hasToken = !!sessionStorage.getItem('smartist_token');
  var pwField = document.getElementById('stage-modal-pw-field');
  if (pwField) pwField.style.display = hasToken ? 'none' : '';
  document.getElementById('stage-share-status').textContent = '';
  document.getElementById('stage-share-email').value = '';
  var sendBtn = document.getElementById('stage-share-send');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send PDF'; }
  document.getElementById('stage-share-modal').style.display = 'flex';
  var focusId = hasToken ? 'stage-share-email' : 'stage-share-pw';
  setTimeout(function() {
    var el = document.getElementById(focusId);
    if (el) el.focus();
  }, 50);
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

  var token = sessionStorage.getItem('smartist_token');
  var pwEl  = document.getElementById('stage-share-pw');
  if (pwEl && pwEl.value.trim()) token = pwEl.value.trim();

  if (!token) {
    status.textContent = 'Password required.';
    if (pwEl) pwEl.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  status.textContent = '';

  var result = await sendSetlistEmail(_shareSlug, _shareSetlistId, email, token);

  if (result.ok) {
    status.textContent = 'Sent to ' + escHtml(email);
    btn.disabled = true;
    setTimeout(function() {
      document.getElementById('stage-share-modal').style.display = 'none';
    }, 1800);
  } else {
    status.textContent = result.error;
    btn.disabled = false;
    btn.textContent = 'Send PDF';
  }
}
