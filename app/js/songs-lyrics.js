// Lyrics modal: view, edit, AI suggestion, delete — plus the reference-URL preview.
// Split out of songs.js — same global scope, loaded before it. Uses songs/artistSlug/getVal from songs.js.
// SPA rule applies here too: no top-level const/let (see tests/unit/page_scripts.js).

// --- Lyrics column ---

var _lyricsChordsOn = true;
try { _lyricsChordsOn = localStorage.getItem('lyrics_chords') !== '0'; } catch (_) {}
var _lyricsSteps    = 0;
var _lyricsText     = '';

function _lyricsShow(text) {
  _lyricsText = text || '';
  var view = document.getElementById('lyrics-view');
  view.innerHTML = chordsRender(_lyricsText, { chords: _lyricsChordsOn, steps: _lyricsSteps });
  document.getElementById('lyrics-chord-bar').style.display = chordsHas(_lyricsText) ? '' : 'none';
  document.getElementById('lyrics-chords-toggle').setAttribute('aria-pressed', String(_lyricsChordsOn));
  document.getElementById('lyrics-transpose-val').textContent = (_lyricsSteps > 0 ? '+' : '') + _lyricsSteps;
}

function lyricsToggleChords() {
  _lyricsChordsOn = !_lyricsChordsOn;
  try { localStorage.setItem('lyrics_chords', _lyricsChordsOn ? '1' : '0'); } catch (_) {}
  _lyricsShow(_lyricsText);
}

function lyricsTranspose(d) {
  _lyricsSteps = Math.max(-11, Math.min(11, _lyricsSteps + d));
  _lyricsShow(_lyricsText);
}

function _lyricsSetMode(mode) { // 'view' or 'edit'
  document.getElementById('lyrics-suggest-preview').style.display = 'none';
  document.getElementById('lyrics-view').style.display        = mode === 'view' ? '' : 'none';
  document.getElementById('lyrics-edit').style.display        = mode === 'edit' ? '' : 'none';
  document.getElementById('lyrics-actions-view').style.display = mode === 'view' ? '' : 'none';
  document.getElementById('lyrics-actions-edit').style.display = mode === 'edit' ? '' : 'none';
  // AI suggest needs a saved song (title + artist) — hide it for a new, unsaved one.
  var suggestBtn = document.getElementById('lyrics-suggest-btn');
  if (suggestBtn) suggestBtn.style.display = _isNewPanelSid(currentLyricsSid) ? 'none' : '';
  var newHint = document.getElementById('lyrics-suggest-new-hint');
  if (newHint) newHint.style.display = mode === 'edit' && _isNewPanelSid(currentLyricsSid) ? '' : 'none';
  _lyricsSaveStatus('', false);
}

// The song list carries has_lyrics only; the text is fetched with the song's
// details the first time the modal opens (loadSongLyrics in session.js).
async function _lyricsLoad(sid, song) {
  try {
    const text = await loadSongLyrics(artistSlug, song);
    return currentLyricsSid === sid ? text : null; // modal moved on meanwhile
  } catch {
    if (currentLyricsSid === sid) _lyricsSaveStatus(t('songs.lyricsCouldNotFetch'), true);
    return null;
  }
}

async function openLyrics(sid) {
  const song  = songs.find(s => String(s.id) === String(sid));
  const title = song?.title ?? 'Lyrics';

  currentLyricsSid = sid;
  document.getElementById('lyrics-title').textContent = `¶ ${title}`;
  _lyricsSteps = 0;
  if (song?.lyrics === undefined) {
    document.getElementById('lyrics-view').textContent = t('songs.loading');
    document.getElementById('lyrics-chord-bar').style.display = 'none';
  } else {
    _lyricsShow(song.lyrics);
  }
  document.getElementById('lyrics-edit').value        = chordsToAbove(song?.lyrics ?? '');
  document.getElementById('lyrics-delete-confirm').style.display = 'none';
  document.getElementById('lyrics-delete-btn').style.display     = _viewMode ? 'none' : '';
  _lyricsSetMode('view');
  document.getElementById('lyrics-modal').classList.add('open');

  const text = await _lyricsLoad(sid, song);
  if (text === null) return;
  _lyricsShow(text);
  document.getElementById('lyrics-edit').value       = chordsToAbove(text);
}

async function openLyricsEdit(sid) {
  const song  = songs.find(s => String(s.id) === String(sid));
  const title = song?.title ?? 'Lyrics';

  currentLyricsSid = sid;
  document.getElementById('lyrics-title').textContent = `¶ ${title}`;
  document.getElementById('lyrics-edit').value        = chordsToAbove(song?.lyrics ?? '');
  _lyricsSetMode('edit');
  document.getElementById('lyrics-modal').classList.add('open');
  document.getElementById('lyrics-edit').focus();

  if (song?.lyrics !== undefined) return;
  const edit = document.getElementById('lyrics-edit');
  edit.disabled = true;
  const text = await _lyricsLoad(sid, song);
  edit.disabled = false;
  if (text === null) return;
  // Only fill it if nothing was typed while the text was loading.
  if (!edit.value) edit.value = chordsToAbove(text);
  edit.focus();
}

function closeLyrics() {
  if (_lyricsSuggestAbort) { _lyricsSuggestAbort.abort(); _lyricsSuggestAbort = null; }
  document.getElementById('lyrics-suggest-preview').style.display = 'none';
  document.getElementById('lyrics-modal').classList.remove('open');
  currentLyricsSid = null;
}

function _lyricsShowSuggestState(header, text, showActions) {
  document.getElementById('lyrics-suggest-header').textContent          = header;
  document.getElementById('lyrics-suggest-text').textContent            = text;
  document.getElementById('lyrics-suggest-actions').style.display       = showActions ? '' : 'none';
  document.getElementById('lyrics-suggest-preview').style.display       = '';
}

async function suggestLyrics() {
  if (!currentLyricsSid) return;
  const btn = document.getElementById('lyrics-suggest-btn');
  if (!btn) return;
  btn.textContent = '…'; btn.disabled = true;
  _lyricsShowSuggestState(t('songs.lyricsSearching'), '', false);
  _lyricsSuggestAbort = new AbortController();
  try {
    // apiFetch-exempt: needs an AbortSignal, which apiFetch does not take.
    const r = await fetch(`/api/${artistSlug}/songs/${currentLyricsSid}/lyrics/suggest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: _lyricsSuggestAbort.signal,
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      _lyricsShowSuggestState(body.error ?? t('songs.lyricsCouldNotFetch'), '', false);
      return;
    }
    const data = await r.json();
    const sourcesList = data.sources ? data.sources.join(', ') : t('songs.lyricsAllSources');
    if (!data.lyrics) {
      const aiNote = data.aiSkipped ? ' ' + t('songs.lyricsAiQuota') : '';
      _lyricsShowSuggestState(t('songs.lyricsNotFound', { sources: sourcesList }) + aiNote, '', false);
      return;
    }
    _lyricsShowSuggestState(t('songs.lyricsSuggestedVia', { source: data.source }), data.lyrics, true);
  } catch (e) {
    if (e.name !== 'AbortError') _lyricsShowSuggestState(t('songs.lyricsCouldNotFetch'), '', false);
  } finally {
    btn.textContent = t('songs.aiBtn'); btn.disabled = false;
    _lyricsSuggestAbort = null;
  }
}

function _lyricsAcceptSuggestion() {
  document.getElementById('lyrics-edit').value = document.getElementById('lyrics-suggest-text').textContent;
  document.getElementById('lyrics-suggest-preview').style.display = 'none';
  saveLyrics();
}

function _lyricsDiscardSuggestion() {
  document.getElementById('lyrics-suggest-preview').style.display = 'none';
}

function startEditLyrics() {
  const song = songs.find(s => String(s.id) === String(currentLyricsSid));
  document.getElementById('lyrics-edit').value = chordsToAbove(song?.lyrics ?? '');
  _lyricsSetMode('edit');
  document.getElementById('lyrics-edit').focus();
}

function cancelEditLyrics() {
  const song = songs.find(s => String(s.id) === String(currentLyricsSid));
  if (song?.lyrics) {
    _lyricsSetMode('view');
  } else {
    closeLyrics();
  }
}

function _lyricsSaveStatus(msg, isError) {
  const el = document.getElementById('lyrics-save-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color  = isError ? 'var(--danger-color)' : 'var(--third-color)';
  el.style.display = msg ? '' : 'none';
}

async function saveLyrics() {
  const sid = currentLyricsSid;
  if (!sid) return;
  const text = chordsToPro(document.getElementById('lyrics-edit').value);

  // New, unsaved song: stash lyrics in the panel; they persist when it's created.
  if (_isNewPanelSid(sid)) {
    const hidden = document.querySelector(`input[data-key="lyrics"][data-id="${sid}"]`);
    if (hidden) { hidden.value = text; markPanelEditDirty(); }
    closeLyrics();
    return;
  }

  const saveBtn = document.getElementById('lyrics-save-btn');
  if (saveBtn) { saveBtn.textContent = t('songs.savingDot'); saveBtn.disabled = true; }
  _lyricsSaveStatus('', false);

  try {
    let r;
    // apiFetch sends an ended session to the login page and throws.
    try { r = await apiFetch(`/api/${artistSlug}/songs/${sid}/lyrics`, 'PUT', { lyrics: text }); }
    catch { closeLyrics(); return; }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const msg = body.error ?? t('songs.saveFailedStatus', { status: r.status });
      _lyricsSaveStatus(msg, true);
      console.error('saveLyrics failed', r.status, body);
      return;
    }
    invalidateConfigCache();

    // Update local cache and DOM
    const song = songs.find(s => String(s.id) === String(sid));
    const trimmed = text.trim() || null;
    if (song) { song.lyrics = trimmed; song.has_lyrics = !!trimmed; }

    const td = document.querySelector(`#row-${sid} .lyrics-cell`);
    if (td) {
      const existing = td.querySelector('.lyrics-open-btn, .lyrics-add-btn');
      if (trimmed && existing?.classList.contains('lyrics-add-btn')) {
        existing.className = 'lyrics-open-btn';
        existing.textContent = '¶';
        existing.title = t('songs.viewLyrics');
        existing.setAttribute('data-onclick', `openLyrics('${sid}')`);
      } else if (!trimmed && existing?.classList.contains('lyrics-open-btn')) {
        existing.className = 'lyrics-add-btn';
        existing.textContent = '+';
        existing.title = t('songs.addLyrics');
        existing.setAttribute('data-onclick', `openLyricsEdit('${sid}')`);
      }
    }

    if (trimmed) {
      _lyricsShow(trimmed);
      _lyricsSetMode('view');
    } else {
      closeLyrics();
    }
    _setBulkStatus('saved', t('songs.lyricsSaved'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch (e) {
    _lyricsSaveStatus(t('songs.networkErrorSave'), true);
    console.error('saveLyrics network error', e);
  } finally {
    if (saveBtn) { saveBtn.textContent = t('songs.save'); saveBtn.disabled = false; }
  }
}

function showLyricsDeleteConfirm() {
  document.getElementById('lyrics-delete-btn').style.display     = 'none';
  document.getElementById('lyrics-delete-confirm').style.display = 'flex';
}

function cancelDeleteLyrics() {
  document.getElementById('lyrics-delete-confirm').style.display = 'none';
  document.getElementById('lyrics-delete-btn').style.display     = '';
}

async function confirmDeleteLyrics() {
  const sid = currentLyricsSid;
  if (!sid) return;
  closeLyrics();

  try {
    const r = await apiFetch(`/api/${artistSlug}/songs/${sid}/lyrics`, 'DELETE');
    if (!r.ok) { _setBulkStatus('error', t('songs.couldNotDeleteLyrics')); return; }
    invalidateConfigCache();

    const song = songs.find(s => String(s.id) === String(sid));
    if (song) { song.lyrics = null; song.has_lyrics = false; }

    const td = document.querySelector(`#row-${sid} .lyrics-cell`);
    if (td) {
      const btn = td.querySelector('.lyrics-open-btn');
      if (btn) {
        btn.className = 'lyrics-add-btn';
        btn.textContent = '+';
        btn.title = t('songs.addLyrics');
        btn.setAttribute('data-onclick', `openLyricsEdit('${sid}')`);
      }
    }
    _setBulkStatus('saved', t('songs.lyricsDeleted'));
    setTimeout(() => _setBulkStatus('', ''), 3000);
  } catch {
    _setBulkStatus('error', t('songs.couldNotDeleteLyrics'));
  }
}

document.getElementById('lyrics-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLyrics();
});

// ── URL preview modal ─────────────────────────────────────────────────────────


var _urlPreviewSourceInput = null;

function _setPreviewSrc(url) {
  const iframe  = document.getElementById('url-preview-iframe');
  const loading = document.getElementById('url-preview-loading');
  if (url) {
    loading.style.display = '';
    iframe.style.display  = 'none';
    iframe.src = toEmbedUrl(url) || safeUrl(url);
  } else {
    loading.style.display = 'none';
    iframe.style.display  = '';
    iframe.src = '';
  }
}

function openUrlPreview(url, sourceInput) {
  _urlPreviewSourceInput = sourceInput || null;
  document.getElementById('url-preview-input').value = url || '';
  document.getElementById('url-preview-link').href   = safeUrl(url);
  document.getElementById('url-preview-link').style.display = url ? '' : 'none';
  _setPreviewSrc(url);
  document.getElementById('url-preview-modal').classList.add('open');
  document.getElementById('url-preview-input').focus();
}

function reloadUrlPreviewOnEnter(e) { if (e.key === 'Enter') reloadUrlPreview(); }

function reloadUrlPreview() {
  const url = document.getElementById('url-preview-input').value.trim();
  document.getElementById('url-preview-link').href  = safeUrl(url);
  document.getElementById('url-preview-link').style.display = url ? '' : 'none';
  _setPreviewSrc(url);
  if (_urlPreviewSourceInput) {
    _urlPreviewSourceInput.value = url;
    markDirty(_urlPreviewSourceInput.dataset.id);
    _syncUrlBtn(_urlPreviewSourceInput);
  }
}

function _syncUrlBtn(input) {
  const btn = input.nextElementSibling;
  if (!btn) return;
  const has = !!input.value.trim();
  btn.textContent = has ? '✓ Link' : '+ Add';
  btn.classList.toggle('url-edit-btn--set', has);
}

function closeUrlPreview() {
  const url = document.getElementById('url-preview-input').value.trim();
  if (_urlPreviewSourceInput) {
    _urlPreviewSourceInput.value = url;
    markDirty(_urlPreviewSourceInput.dataset.id);
    _syncUrlBtn(_urlPreviewSourceInput);
  }
  document.getElementById('url-preview-modal').classList.remove('open');
  document.getElementById('url-preview-iframe').src = '';
  _urlPreviewSourceInput = null;
}

document.getElementById('url-preview-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeUrlPreview();
});

document.getElementById('url-preview-iframe').addEventListener('load', () => {
  document.getElementById('url-preview-loading').style.display = 'none';
  document.getElementById('url-preview-iframe').style.display  = '';
});

registerModal('player-modal',   closePlayer);
registerModal('sheet-modal',    closeSheet);
registerModal('playback-modal', closePlayback);
registerModal('lyrics-modal',   closeLyrics);
