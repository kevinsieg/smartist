// Stage view — full-screen setlist for on-stage use

var _shareSlug      = null;
var _shareSetlistId = null;

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

function _shareHtml() {
  return `<button class="stage-share-btn" id="stage-share-btn" onclick="toggleStageShareMenu(event)" title="Share"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg></button>
    <div class="stage-share-menu" id="stage-share-menu" style="display:none">
      <button class="stage-share-item" onclick="stageSharePrint()"><span class="stage-share-icon">⎙</span>Print / Export PDF</button>
      <button class="stage-share-item" onclick="stageShareCopyLink()"><span class="stage-share-icon">⧉</span><span id="stage-copy-label">Copy link</span></button>
      <button class="stage-share-item" onclick="stageShareEmail()"><span class="stage-share-icon">✉</span>Share via email</button>
    </div>`;
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const el     = document.getElementById('stage-content');

  try {
    const cfg = await fetch('/api/config').then(r => { if (!r.ok) throw new Error(); return r.json(); });
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
      <span class="stage-song-title">${escHtml(song.title)}</span>
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
  if (!songId) {
    el.innerHTML = '<p class="stage-message">No song ID provided.</p>';
    return;
  }

  const song = await fetch(`/api/${cfg.slug}/songs/${songId}`).then(r => {
    if (!r.ok) throw new Error('not found');
    return r.json();
  });

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
    <div class="stage-header">
      <div class="stage-band">${escHtml(cfg.name)}</div>
      <h1 class="stage-title">${escHtml(song.title)}</h1>
      ${subtitle}
      ${_shareHtml()}
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
});
window.addEventListener('afterprint', function() {
  document.documentElement.style.fontSize = '';
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
