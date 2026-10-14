// Melodies block of the song edit panel: sheet images and an audio recording
// per band instrument. Files upload at once (presign, PUT, confirm), not with
// the panel's Save. Same global scope as the other songs scripts; loaded before
// songs-panel.js, which calls melodiesLoad. SPA rule: no top-level const/let.

var MELODY_IMAGE_MAX_EDGE = 2000;
var MELODY_AUDIO_MAX_BYTES = 50 * 1024 * 1024;
var _melodyDrafts = {};

function melodyFitSize(w, h, max) {
  var scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

async function melodyResize(file) {
  var bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { throw new Error('not_image'); }
  var size = melodyFitSize(bmp.width, bmp.height, MELODY_IMAGE_MAX_EDGE);
  var canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.drawImage(bmp, 0, 0, size.w, size.h);
  if (bmp.close) bmp.close();
  var blob = await new Promise(function(resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
  if (!blob) throw new Error('not_image');
  return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
}

function melodyInstruments() {
  var cfg = _songsCfg && _songsCfg.config && _songsCfg.config.arrangementConfig;
  return (cfg && cfg.instruments) || [];
}

function melodyLabel(key) {
  if (key === MELODY_SONG_KEY) return t('songs.melodyWholeSong');
  var found = melodyInstruments().find(function(i) { return i.key === key; });
  return (found && found.label) || key;
}

function melodyRowHtml(sid, row) {
  var data = ' data-sid="' + escHtml(sid) + '" data-instrument="' + escHtml(row.instrument) + '"';
  var thumbs = (row.sheet_urls || []).map(function(url) {
    return '<span class="melody-thumb"><a href="' + escHtml(safeUrl(url)) + '" target="_blank" rel="noopener">' +
      '<img src="' + escHtml(safeUrl(url)) + '" alt="' + escHtml(melodyLabel(row.instrument)) + '" loading="lazy"></a>' +
      '<button type="button" class="melody-x auth-action"' + data + ' data-kind="sheet" data-url="' + escHtml(url) + '"' +
      ' data-onclick="melodyRemove(this)" aria-label="' + escHtml(t('songs.remove')) + '">&times;</button></span>';
  }).join('');
  var audio = row.instrument === MELODY_SONG_KEY ? '' : row.audio_url
    ? '<div class="melody-audio"><audio class="vsp-audio" controls src="' + escHtml(safeUrl(row.audio_url)) + '"></audio>' +
      '<button type="button" class="btn auth-action"' + data + ' data-kind="audio" data-onclick="melodyRemove(this)">' + t('songs.remove') + '</button></div>'
    : '<button type="button" class="btn auth-action"' + data + ' data-kind="audio" data-onclick="melodyOpenPicker(this)">&#9654; ' + t('songs.melodyAddAudio') + '</button>' +
      '<input type="file" class="melody-file" style="display:none" accept="audio/*"' + data + ' data-kind="audio" data-onchange="melodyFilesChosen(this)">';
  return '<div class="melody-row">' +
    '<div class="melody-head"><strong>' + escHtml(melodyLabel(row.instrument)) + '</strong>' +
    '<button type="button" class="btn auth-action"' + data + ' data-kind="melody" data-onclick="melodyRemove(this)">' + t('songs.melodyRemove') + '</button></div>' +
    '<div class="melody-thumbs">' + thumbs + '</div>' +
    '<button type="button" class="btn auth-action"' + data + ' data-kind="sheet" data-onclick="melodyOpenPicker(this)">+ ' + t('songs.melodyAddPhoto') + '</button>' +
    '<input type="file" class="melody-file" style="display:none" accept="image/jpeg,image/png" multiple' + data + ' data-kind="sheet" data-onchange="melodyFilesChosen(this)">' +
    audio + '</div>';
}

function melodyBlockHtml(sid, melodies) {
  var instruments = melodyInstruments();
  // The whole song comes first and is always there: its images belong to no voice.
  var song = melodies.find(function(m) { return m.instrument === MELODY_SONG_KEY; }) || { instrument: MELODY_SONG_KEY, sheet_urls: [], audio_url: null };
  var rows = melodies.filter(function(m) { return m.instrument !== MELODY_SONG_KEY; });
  var have = {};
  rows.forEach(function(m) { have[m.instrument] = true; });
  (_melodyDrafts[sid] || []).forEach(function(key) {
    if (!have[key]) { have[key] = true; rows.push({ instrument: key, sheet_urls: [], audio_url: null }); }
  });
  var html = '';
  if (!instruments.length) {
    html += '<p class="auth-hint">' + t('songs.melodyNoInstruments') + ' <a href="/' + _artistSlug + '/settings#arrangement-section">' + t('songs.arrSettingsLink') + '</a></p>';
  } else if (!rows.length) {
    html += '<p class="auth-hint">' + t('songs.melodyNone') + '</p>';
  }
  html = melodyRowHtml(sid, song) + html + rows.map(function(row) { return melodyRowHtml(sid, row); }).join('');
  var free = instruments.filter(function(i) { return !have[i.key]; });
  if (free.length) {
    html += '<div class="melody-add"><select class="edit-input" id="melody-add-select">' +
      free.map(function(i) { return '<option value="' + escHtml(i.key) + '">' + escHtml(i.label || i.key) + '</option>'; }).join('') +
      '</select><button type="button" class="btn auth-action" data-sid="' + escHtml(sid) + '" data-onclick="melodyAdd(this)">' + t('songs.melodyAdd') + '</button></div>';
  }
  return html;
}

async function melodiesLoad(sid) {
  var el = document.getElementById('melodies-body');
  if (!el) return;
  sid = String(sid);
  try {
    var r = await apiFetch('/api/' + artistSlug + '/songs/' + Number(sid));
    if (!r.ok) throw new Error('load');
    var d = await r.json();
    var again = document.getElementById('melodies-body');
    if (!again || again.dataset.sid !== sid) return;
    again.innerHTML = melodyBlockHtml(sid, d.melodies || []);
  } catch (e) {
    if (e.message !== 'auth') el.innerHTML = '<p class="auth-hint">' + t('songs.melodyLoadFailed') + '</p>';
  }
}

function melodyUrl(sid, instrument, kind) {
  return '/api/' + artistSlug + '/songs/' + Number(sid) + '/melodies/' + encodeURIComponent(instrument) + (kind ? '/' + kind : '');
}

async function melodyFail(r, step) {
  var code = '';
  try { code = (await r.json()).code || ''; } catch (e) { /* no body */ }
  return new Error(code || step);
}

async function melodyUpload(sid, instrument, kind, file) {
  var base = melodyUrl(sid, instrument, kind);
  var r = await apiFetch(base, 'POST', { filename: file.name, contentType: file.type, size: file.size });
  if (!r.ok) throw await melodyFail(r, 'presign');
  var json = await r.json();
  var put = await fetch(json.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!put.ok) throw new Error('storage');
  var body = { publicUrl: json.publicUrl };
  if (kind === 'audio') body.waveform = await _songWaveform(file);
  var confirmed = await apiFetch(base, 'PUT', body);
  if (!confirmed.ok) throw await melodyFail(confirmed, 'confirm');
}

function melodyErrorText(err) {
  if (err.message === 'not_image') return t('songs.melodyImagesOnly');
  if (err.message === 'storage_limit') return t('songs.melodyStorageFull');
  if (err.message === 'image_limit') return t('songs.melodyImageLimit');
  return t('songs.uploadFailed');
}

function melodyOpenPicker(btn) {
  var input = btn.parentNode.querySelector('input.melody-file[data-kind="' + btn.dataset.kind + '"]');
  if (input) input.click();
}

async function melodyFilesChosen(input) {
  var d = input.dataset;
  var files = Array.prototype.slice.call(input.files);
  input.value = '';
  if (!files.length) return;
  try {
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (d.kind === 'audio' && file.size > MELODY_AUDIO_MAX_BYTES) {
        _setBulkStatus('error', t('songs.fileTooLargeMax', { max: '50 MB' }));
        return;
      }
      await melodyUpload(d.sid, d.instrument, d.kind, d.kind === 'sheet' ? await melodyResize(file) : file);
    }
    _melodyDrafts[d.sid] = (_melodyDrafts[d.sid] || []).filter(function(k) { return k !== d.instrument; });
    _setBulkStatus('saved', t('songs.fileUploaded'));
    setTimeout(function() { _setBulkStatus('', ''); }, 3000);
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', melodyErrorText(err));
  } finally {
    melodiesLoad(d.sid);
  }
}

async function melodyRemove(btn) {
  var d = btn.dataset;
  if (d.kind === 'melody' && !confirm(t('songs.melodyRemoveConfirm'))) return;
  try {
    var query = d.kind === 'sheet' ? '?url=' + encodeURIComponent(d.url) : '';
    var r = await apiFetch(melodyUrl(d.sid, d.instrument, d.kind === 'melody' ? '' : d.kind) + query, 'DELETE');
    if (!r.ok && r.status !== 404) throw new Error('remove');
    if (d.kind === 'melody') _melodyDrafts[d.sid] = (_melodyDrafts[d.sid] || []).filter(function(k) { return k !== d.instrument; });
  } catch (err) {
    if (err.message !== 'auth') _setBulkStatus('error', t('songs.uploadFailed'));
  }
  melodiesLoad(d.sid);
}

function melodyAdd(btn) {
  var select = document.getElementById('melody-add-select');
  var sid = btn.dataset.sid;
  if (!select || !select.value) return;
  _melodyDrafts[sid] = (_melodyDrafts[sid] || []).concat([select.value]);
  melodiesLoad(sid);
}
