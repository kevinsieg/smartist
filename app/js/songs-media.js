// Audio, sheet music and playback: upload, players, replace, delete, history.
// Split out of songs.js — same global scope, loaded before it. Uses getVal/songs/artistSlug from songs.js.
// SPA rule applies here too: no top-level const/let (see tests/unit/page_scripts.js).

// --- Panel file upload (side-panel edit form) ---

function _panelUploadFile(inputId) {
  var el = document.getElementById(inputId);
  if (el) el.click();
}

async function _panelUploadHandler(input, sid, mediaType) {
  var file = input.files[0];
  input.value = '';
  if (!file) return;

  var maxBytes = mediaType === 'sheet' ? 20 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > maxBytes) { _setBulkStatus('error', t('songs.fileTooLarge')); return; }

  var btn = input.previousElementSibling;
  var origText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  try {
    var publicUrl = await _uploadSongMedia(sid, mediaType, file);
    var keyMap = { audio: 'extra.listenUrl', sheet: 'extra.sheetUrl', playback: 'extra.playbackUrl' };
    var panelInput = document.querySelector('[data-key="' + keyMap[mediaType] + '"][data-id="' + sid + '"]');
    if (panelInput) { panelInput.value = publicUrl; markPanelEditDirty(); }
    var song = songs.find(function(s) { return String(s.id) === String(sid); });
    var extraKeyMap = { audio: 'listenUrl', sheet: 'sheetUrl', playback: 'playbackUrl' };
    if (song) song.extra = Object.assign({}, song.extra, { [extraKeyMap[mediaType]]: publicUrl });
    _setBulkStatus('saved', t('songs.fileUploaded'));
    setTimeout(function() { _setBulkStatus('', ''); }, 3000);
    if (dirty.size > 0) saveAll();
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

// Shared presign → PUT → confirm pipeline for all media types.
// Returns publicUrl on success. Throws on failure; err.message is one of:
//   'auth'    — session expired (requireLogin already called; caller should bail silently)
//   'presign' — presign request failed
//   'storage' — PUT to storage failed
//   'confirm' — confirm request failed
async function _uploadSongMedia(sid, type, file) {
  var token = getToken();
  var contentType = type === 'sheet' ? 'application/pdf' : file.type;
  var r = await fetch('/api/' + artistSlug + '/songs/' + sid + '/' + type, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
  });
  if (r.status === 401) { if (!isViewMode()) { clearToken(); requireLogin(); } throw new Error('auth'); }
  if (!r.ok) throw new Error('presign');

  var json = await r.json();
  var put = await fetch(json.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
  if (!put.ok) throw new Error('storage');

  var confirm = await fetch('/api/' + artistSlug + '/songs/' + sid + '/' + type, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ publicUrl: json.publicUrl }),
  });
  if (confirm.status === 401) { if (!isViewMode()) { clearToken(); requireLogin(); } throw new Error('auth'); }
  if (!confirm.ok) throw new Error('confirm');

  // Media URLs live in songs.extra, which the cached config payload carries.
  invalidateConfigCache();
  return json.publicUrl;
}

// --- Audio upload ---

function triggerAudioUpload(sid) {
  const row = document.getElementById(`row-${sid}`);
  if (!row) return;
  row.querySelector('.listen-file-input')?.click();
}

async function handleAudioFile(input, sid) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > 50 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' })); return; }

  const uploadBtn = document.querySelector(`#row-${sid} .listen-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'audio', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), listenUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .listen-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.listen-upload-btn')?.remove();
      if (!td.querySelector('.listen-play-btn')) {
        const btn = document.createElement('button');
        btn.className = 'listen-play-btn'; btn.title = t('songs.play'); btn.textContent = '▶';
        btn.setAttribute('data-onclick', `openPlayer('${sid}')`);
        td.prepend(btn);
      }
    }
    _setBulkStatus('saved', t('songs.audioUploaded'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
    if (dirty.size > 0) saveAll();
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (uploadBtn) { uploadBtn.textContent = uploadBtn.dataset.orig || '↑'; uploadBtn.classList.remove('listen-uploading'); uploadBtn.disabled = false; }
  }
}

// --- Player modal ---

function toEmbedUrl(url) {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1`;
  // SoundCloud uses cross-site tracking — open in new tab instead
  return null;
}

function openPlayer(sid) {
  const row  = document.getElementById(`row-${sid}`);
  const song = songs.find(s => String(s.id) === String(sid));
  const url  = (row?.querySelector('.listen-cell input[type="text"]')?.value?.trim())
             || song?.extra?.listenUrl || '';
  if (!url) return;

  const title = song?.title ?? row?.querySelector('[data-key="title"]')?.value ?? 'Listen';

  currentPlayerSid = sid;
  document.getElementById('player-title').textContent = `♪ ${title}`;

  const isAudio  = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(url);
  const embedUrl = toEmbedUrl(url);
  const content  = document.getElementById('player-content');

  if (isAudio) {
    content.innerHTML = `<div class="audio-speed-wrap"><audio controls src="${escHtml(safeUrl(url))}" autoplay></audio><div class="audio-speed-btns"><button data-onclick="_setAudioSpeed(this,0.7)">0.7×</button><button data-onclick="_setAudioSpeed(this,0.8)">0.8×</button><button data-onclick="_setAudioSpeed(this,0.9)">0.9×</button></div></div>`;
  } else if (embedUrl) {
    content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(safeUrl(embedUrl))}"
      allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
  } else {
    content.innerHTML = `<p class="player-link"><a href="${escHtml(safeUrl(url))}" target="_blank" rel="noopener">${t('songs.openNewTab')}</a></p>`;
  }

  // Reset delete confirm state
  document.getElementById('player-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('player-delete-btn').style.display = '';
  document.getElementById('player-history').innerHTML = '';

  // Fetch audio history for this song
  apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
    .then(r => r.ok ? r.json() : [])
    .then(renderPlayerHistory)
    .catch(() => {});

  document.getElementById('player-modal').classList.add('open');
}

function closePlayer() {
  document.getElementById('player-modal').classList.remove('open');
  document.getElementById('player-content').innerHTML = ''; // stops playback
  document.getElementById('player-history').innerHTML = '';
  document.getElementById('player-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('player-delete-btn').style.display = '';
  currentPlayerSid = null;
}

function showDeleteConfirm() {
  document.getElementById('player-delete-btn').style.display = 'none';
  document.getElementById('player-delete-confirm').style.display = 'flex';
}

function cancelDeleteAudio() {
  document.getElementById('player-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('player-delete-btn').style.display = '';
}

async function confirmDeleteAudio() {
  const sid = currentPlayerSid;
  if (!sid) return;
  closePlayer();

  try {
    const r = await fetch(`/api/${artistSlug}/songs/${sid}/audio`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    });
    if (r.status === 401) { if (!isViewMode()) { clearToken(); requireLogin(); } return; }
    if (!r.ok) { _setBulkStatus('error', t('songs.couldNotRemoveAudio')); return; }
    invalidateConfigCache();

    // Update local cache and swap ▶ back to ↑ in the table cell
    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.listenUrl;
    const td = document.querySelector(`#row-${sid} .listen-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = '';
      td.querySelector('.listen-play-btn')?.remove();
      if (!td.querySelector('.listen-upload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'listen-upload-btn';
        btn.title = t('songs.uploadAudio');
        btn.textContent = '↑';
        btn.setAttribute('data-onclick', `triggerAudioUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    _setBulkStatus('saved', t('songs.audioRemoved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch {
    _setBulkStatus('error', t('songs.couldNotRemoveAudio'));
  }
}

function triggerReplaceAudio() {
  document.getElementById('player-file-input').click();
}

async function handleReplaceFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const sid = currentPlayerSid;
  if (!sid) return;
  if (file.size > 50 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' })); return; }

  const replaceBtn = document.getElementById('player-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'audio', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), listenUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .listen-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;
    const isAudio = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(publicUrl);
    const embedUrl = toEmbedUrl(publicUrl);
    const content = document.getElementById('player-content');
    if (isAudio) {
      content.innerHTML = `<div class="audio-speed-wrap"><audio controls src="${escHtml(safeUrl(publicUrl))}" autoplay></audio><div class="audio-speed-btns"><button data-onclick="_setAudioSpeed(this,0.7)">0.7×</button><button data-onclick="_setAudioSpeed(this,0.8)">0.8×</button><button data-onclick="_setAudioSpeed(this,0.9)">0.9×</button></div></div>`;
    } else if (embedUrl) {
      content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(safeUrl(embedUrl))}" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
    } else {
      content.innerHTML = `<p class="player-link"><a href="${escHtml(safeUrl(publicUrl))}" target="_blank" rel="noopener">${t('songs.openNewTab')}</a></p>`;
    }
    apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`).then(r => r.ok ? r.json() : []).then(renderPlayerHistory).catch(() => {});
    _setBulkStatus('saved', t('songs.audioReplaced'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (replaceBtn) { replaceBtn.textContent = t('songs.replace'); replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderPlayerHistory(logs) {
  const el = document.getElementById('player-history');
  if (!el) return;
  const audio = logs.filter(l => l.action === 'audio_replace' || l.action === 'audio_delete');
  if (!audio.length) { el.innerHTML = ''; return; }

  const items = audio.map(log => {
    const desc = log.action === 'audio_replace'
      ? t('songs.histReplaced', { file: escHtml(log.song_data?.previousFilename ?? '?') })
      : t('songs.histRemoved', { file: escHtml(log.song_data?.filename ?? '?') });
    return `<div class="player-history-item">
      <span class="player-history-time">${timeAgo(log.changed_at)}</span>
      <span>${desc}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<h3 class="player-history-heading">${t('songs.history')}</h3>${items}`;
}

// --- Sheet (PDF) column ---

function triggerSheetUpload(sid) {
  const row = document.getElementById(`row-${sid}`);
  if (!row) return;
  row.querySelector('.sheet-file-input')?.click();
}

async function handleSheetFile(input, sid) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > 20 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '20 MB' })); return; }

  const uploadBtn = document.querySelector(`#row-${sid} .sheet-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'sheet', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), sheetUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.sheet-upload-btn')?.remove();
      if (!td.querySelector('.sheet-open-btn')) {
        const btn = document.createElement('button');
        btn.className = 'sheet-open-btn'; btn.title = t('songs.openSheet'); btn.textContent = '≡';
        btn.setAttribute('data-onclick', `openSheet('${sid}')`);
        td.prepend(btn);
      }
    }
    _setBulkStatus('saved', t('songs.sheetUploaded'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
    if (dirty.size > 0) saveAll();
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (uploadBtn) { uploadBtn.textContent = uploadBtn.dataset.orig || '↑'; uploadBtn.classList.remove('listen-uploading'); uploadBtn.disabled = false; }
  }
}

function openSheet(sid) {
  const row  = document.getElementById(`row-${sid}`);
  const song = songs.find(s => String(s.id) === String(sid));
  const url  = (row?.querySelector('.sheet-cell input[type="text"]')?.value?.trim())
             || song?.extra?.sheetUrl || '';
  if (!url) return;

  const title = song?.title ?? row?.querySelector('[data-key="title"]')?.value ?? 'Sheet';

  currentSheetSid = sid;
  document.getElementById('sheet-title').textContent = `≡ ${title}`;
  document.getElementById('sheet-open-link').href = safeUrl(url);
  document.getElementById('sheet-content').innerHTML =
    `<div class="sheet-embed"><iframe src="${escHtml(safeUrl(url))}" title="Sheet"></iframe></div>`;

  document.getElementById('sheet-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('sheet-delete-btn').style.display = '';
  document.getElementById('sheet-history').innerHTML = '';

  apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
    .then(r => r.ok ? r.json() : [])
    .then(renderSheetHistory)
    .catch(() => {});

  document.getElementById('sheet-modal').classList.add('open');
}

function closeSheet() {
  document.getElementById('sheet-modal').classList.remove('open');
  document.getElementById('sheet-content').innerHTML = ''; // unload iframe
  document.getElementById('sheet-history').innerHTML = '';
  document.getElementById('sheet-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('sheet-delete-btn').style.display = '';
  currentSheetSid = null;
}

function showSheetDeleteConfirm() {
  document.getElementById('sheet-delete-btn').style.display = 'none';
  document.getElementById('sheet-delete-confirm').style.display = 'flex';
}

function cancelDeleteSheet() {
  document.getElementById('sheet-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('sheet-delete-btn').style.display = '';
}

async function confirmDeleteSheet() {
  const sid = currentSheetSid;
  if (!sid) return;
  closeSheet();

  try {
    const r = await fetch(`/api/${artistSlug}/songs/${sid}/sheet`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    });
    if (r.status === 401) { if (!isViewMode()) { clearToken(); requireLogin(); } return; }
    if (!r.ok) { _setBulkStatus('error', t('songs.couldNotRemoveSheet')); return; }
    invalidateConfigCache();

    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.sheetUrl;
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = '';
      td.querySelector('.sheet-open-btn')?.remove();
      if (!td.querySelector('.sheet-upload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'sheet-upload-btn';
        btn.title = t('songs.uploadPdf');
        btn.textContent = '↑';
        btn.setAttribute('data-onclick', `triggerSheetUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    _setBulkStatus('saved', t('songs.sheetRemoved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch {
    _setBulkStatus('error', t('songs.couldNotRemoveSheet'));
  }
}

function triggerReplaceSheet() {
  document.getElementById('sheet-file-input').click();
}

async function handleReplaceSheet(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const sid = currentSheetSid;
  if (!sid) return;
  if (file.size > 20 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '20 MB' })); return; }

  const replaceBtn = document.getElementById('sheet-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'sheet', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), sheetUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .sheet-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;
    document.getElementById('sheet-content').innerHTML = `<div class="sheet-embed"><iframe src="${escHtml(safeUrl(publicUrl))}" title="Sheet"></iframe></div>`;
    apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`).then(r => r.ok ? r.json() : []).then(renderSheetHistory).catch(() => {});
    _setBulkStatus('saved', t('songs.sheetReplaced'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (replaceBtn) { replaceBtn.textContent = t('songs.replace'); replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderSheetHistory(logs) {
  const el = document.getElementById('sheet-history');
  if (!el) return;
  const sheets = logs.filter(l => l.action === 'sheet_replace' || l.action === 'sheet_delete');
  if (!sheets.length) { el.innerHTML = ''; return; }

  const items = sheets.map(log => {
    const desc = log.action === 'sheet_replace'
      ? t('songs.histReplaced', { file: escHtml(log.song_data?.previousFilename ?? '?') })
      : t('songs.histRemoved', { file: escHtml(log.song_data?.filename ?? '?') });
    return `<div class="player-history-item">
      <span class="player-history-time">${timeAgo(log.changed_at)}</span>
      <span>${desc}</span>
    </div>`;
  }).join('');

  el.innerHTML = `<h3 class="player-history-heading">${t('songs.history')}</h3>${items}`;
}

document.getElementById('player-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closePlayer();
});

document.getElementById('sheet-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSheet();
});

// --- Playback column ---

function triggerPlaybackUpload(sid) {
  document.getElementById(`row-${sid}`)?.querySelector('.playback-file-input')?.click();
}

async function handlePlaybackFile(input, sid) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > 50 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' })); return; }

  const uploadBtn = document.querySelector(`#row-${sid} .playback-upload-btn`);
  if (uploadBtn) { uploadBtn.dataset.orig = uploadBtn.textContent; uploadBtn.textContent = '…'; uploadBtn.classList.add('listen-uploading'); uploadBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'playback', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), playbackUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = publicUrl;
      td.querySelector('.playback-upload-btn')?.remove();
      if (!td.querySelector('.playback-open-btn')) {
        const btn = document.createElement('button');
        btn.className = 'playback-open-btn'; btn.title = t('songs.playPlayback'); btn.textContent = '▷';
        btn.setAttribute('data-onclick', `openPlayback('${sid}')`);
        td.prepend(btn);
      }
    }
    _setBulkStatus('saved', t('songs.playbackUploaded'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
    if (dirty.size > 0) saveAll();
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (uploadBtn) { uploadBtn.textContent = uploadBtn.dataset.orig || '↑'; uploadBtn.classList.remove('listen-uploading'); uploadBtn.disabled = false; }
  }
}

function openPlayback(sid) {
  const row  = document.getElementById(`row-${sid}`);
  const song = songs.find(s => String(s.id) === String(sid));
  const url  = (row?.querySelector('.playback-cell input[type="text"]')?.value?.trim())
             || song?.extra?.playbackUrl || '';
  if (!url) return;

  const title = song?.title ?? row?.querySelector('[data-key="title"]')?.value ?? 'Playback';

  currentPlaybackSid = sid;
  document.getElementById('playback-title').textContent = `▷ ${title}`;

  const isAudio  = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(url);
  const embedUrl = toEmbedUrl(url);
  const content  = document.getElementById('playback-content');
  if (isAudio) {
    content.innerHTML = `<div class="audio-speed-wrap"><audio controls src="${escHtml(safeUrl(url))}" autoplay style="width:100%;margin:1rem 0;display:block"></audio><div class="audio-speed-btns"><button data-onclick="_setAudioSpeed(this,0.7)">0.7×</button><button data-onclick="_setAudioSpeed(this,0.8)">0.8×</button><button data-onclick="_setAudioSpeed(this,0.9)">0.9×</button></div></div>`;
  } else if (embedUrl) {
    content.innerHTML = `<div class="player-embed"><iframe src="${escHtml(safeUrl(embedUrl))}" allow="autoplay; encrypted-media" allowfullscreen></iframe></div>`;
  } else {
    content.innerHTML = `<p class="player-link"><a href="${escHtml(safeUrl(url))}" target="_blank" rel="noopener">${t('songs.openNewTab')}</a></p>`;
  }

  document.getElementById('playback-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('playback-delete-btn').style.display = '';
  document.getElementById('playback-history').innerHTML = '';

  apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`)
    .then(r => r.ok ? r.json() : [])
    .then(renderPlaybackHistory)
    .catch(() => {});

  document.getElementById('playback-modal').classList.add('open');
}

function closePlayback() {
  document.getElementById('playback-modal').classList.remove('open');
  document.getElementById('playback-content').innerHTML = ''; // stops playback
  document.getElementById('playback-history').innerHTML = '';
  document.getElementById('playback-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('playback-delete-btn').style.display = '';
  currentPlaybackSid = null;
}

function showPlaybackDeleteConfirm() {
  document.getElementById('playback-delete-btn').style.display = 'none';
  document.getElementById('playback-delete-confirm').style.display = 'flex';
}

function cancelDeletePlayback() {
  document.getElementById('playback-delete-confirm').style.display = 'none';
  if (getToken()) document.getElementById('playback-delete-btn').style.display = '';
}

async function confirmDeletePlayback() {
  const sid = currentPlaybackSid;
  if (!sid) return;
  closePlayback();

  try {
    const r = await fetch(`/api/${artistSlug}/songs/${sid}/playback`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` },
    });
    if (r.status === 401) { if (!isViewMode()) { clearToken(); requireLogin(); } return; }
    if (!r.ok) { _setBulkStatus('error', t('songs.couldNotRemovePlayback')); return; }
    invalidateConfigCache();

    const song = songs.find(s => String(s.id) === String(sid));
    if (song?.extra) delete song.extra.playbackUrl;
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) {
      td.querySelector('input[type="text"]').value = '';
      td.querySelector('.playback-open-btn')?.remove();
      if (!td.querySelector('.playback-upload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'playback-upload-btn';
        btn.title = t('songs.uploadPlayback');
        btn.textContent = '↑';
        btn.setAttribute('data-onclick', `triggerPlaybackUpload('${sid}')`);
        td.appendChild(btn);
      }
    }
    _setBulkStatus('saved', t('songs.playbackRemoved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch {
    _setBulkStatus('error', t('songs.couldNotRemovePlayback'));
  }
}

function triggerReplacePlayback() {
  document.getElementById('playback-file-input').click();
}

async function handleReplacePlayback(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const sid = currentPlaybackSid;
  if (!sid) return;
  if (file.size > 50 * 1024 * 1024) { _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' })); return; }

  const replaceBtn = document.getElementById('playback-replace-btn');
  if (replaceBtn) { replaceBtn.textContent = '…'; replaceBtn.classList.add('listen-uploading'); replaceBtn.disabled = true; }

  try {
    const publicUrl = await _uploadSongMedia(sid, 'playback', file);
    const song = songs.find(s => String(s.id) === String(sid));
    if (song) song.extra = { ...(song.extra ?? {}), playbackUrl: publicUrl };
    const td = document.querySelector(`#row-${sid} .playback-cell`);
    if (td) td.querySelector('input[type="text"]').value = publicUrl;
    document.getElementById('playback-content').innerHTML =
      `<div class="audio-speed-wrap"><audio controls src="${escHtml(safeUrl(publicUrl))}" autoplay style="width:100%;margin:1rem 0;display:block"></audio><div class="audio-speed-btns"><button data-onclick="_setAudioSpeed(this,0.7)">0.7×</button><button data-onclick="_setAudioSpeed(this,0.8)">0.8×</button><button data-onclick="_setAudioSpeed(this,0.9)">0.9×</button></div></div>`;
    apiFetch(`/api/${artistSlug}/song-logs?songId=${sid}`).then(r => r.ok ? r.json() : []).then(renderPlaybackHistory).catch(() => {});
    _setBulkStatus('saved', t('songs.playbackReplaced'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  } finally {
    if (replaceBtn) { replaceBtn.textContent = t('songs.replace'); replaceBtn.classList.remove('listen-uploading'); replaceBtn.disabled = false; }
  }
}

function renderPlaybackHistory(logs) {
  const el = document.getElementById('playback-history');
  if (!el) return;
  const items = logs.filter(l => l.action === 'playback_replace' || l.action === 'playback_delete');
  if (!items.length) { el.innerHTML = ''; return; }

  el.innerHTML = `<h3 class="player-history-heading">${t('songs.history')}</h3>` + items.map(log => {
    const desc = log.action === 'playback_replace'
      ? t('songs.histReplaced', { file: escHtml(log.song_data?.previousFilename ?? '?') })
      : t('songs.histRemoved', { file: escHtml(log.song_data?.filename ?? '?') });
    return `<div class="player-history-item">
      <span class="player-history-time">${timeAgo(log.changed_at)}</span>
      <span>${desc}</span>
    </div>`;
  }).join('');
}

document.getElementById('playback-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closePlayback();
});
