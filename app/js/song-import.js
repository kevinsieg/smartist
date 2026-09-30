'use strict';

// CSV song import: template download, upload, a preview where flagged rows are
// fixed in place or skipped, then the import. Every check runs on the server
// (api/_domain/song_import.js); this page sends the file once, then the edited
// rows, and shows what comes back. Nothing is saved before "Import".

// Template columns — the same names, in the same order, as COLUMNS in
// api/_domain/song_import.js (tests/unit/song_import.js keeps them in step).
var SI_COLUMNS = [
  'title', 'active', 'favourite', 'key', 'bpm', 'time_signature', 'length', 'language',
  'genre', 'tags', 'energy', 'reference_interpret', 'reference_url', 'songinfo_url',
  'comment', 'lead', 'guitar2', 'harmonica', 'guitar_capo', 'banjo_capo', 'author',
  'lyricist', 'interpret', 'label', 'publisher', 'lyrics',
];

var _siSlug = null;
var _siColumns = [];
var _siIgnored = [];
var _siRows = [];
var _siSummary = null;
var _siLimit = null;
var _siFlagged = {};    // line → true once a row has shown a problem: it stays in the filtered view
var _siEditable = {};   // 'line|column' → true once the cell has been an input
var _siOnlyIssues = true;
var _siSeq = 0;
var _siTimer = null;

initPage(async function(cfg) {
  _siSlug = cfg.slug;
  _siReset();
  document.getElementById('si-guide-body').innerHTML = SI_COLUMNS.map(function(c) {
    return '<tr><td class="gema-mono">' + c + (c === 'title' ? ' *' : '') + '</td><td>' + escHtml(t('songImport.col.' + c)) + '</td></tr>';
  }).join('');
  document.getElementById('si-area').style.display = '';
});

// ── Template ──────────────────────────────────────────────────────────────────

function siDownloadTemplate() {
  var csv = '﻿' + SI_COLUMNS.join(',') + '\r\n';
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'smartist-songs-template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 100);
}

// ── File ──────────────────────────────────────────────────────────────────────

function siHandleDrop(e) {
  e.preventDefault();
  var file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) siHandleFile(file);
}

// Excel on Windows saves "CSV" in the legacy code page, where ä ö ü é come
// out as U+FFFD when read as UTF-8: such a file is read again as Windows-1252.
function siHandleFile(file) {
  if (!file) return;
  _siReset();
  _siStatus(t('songImport.reading'));
  var read = function(encoding) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var text = e.target.result;
      if (encoding === 'UTF-8' && text.indexOf('�') >= 0) { read('windows-1252'); return; }
      document.getElementById('si-file-info').textContent = file.name + ' (' + Math.max(1, Math.round(file.size / 1024)) + ' KB)';
      document.getElementById('si-file-info').style.display = '';
      document.getElementById('si-drop-label').style.display = 'none';
      _siSend({ csv: text }, true);
    };
    reader.onerror = function() { _siStatus(t('songImport.readFailed'), true); };
    reader.readAsText(file, encoding);
  };
  read('UTF-8');
}

// ── Server round-trips ────────────────────────────────────────────────────────

function _siPayloadRows() {
  return _siRows.map(function(r) {
    return { line: r.line, values: r.values, skip: !!r.skip, force: !!r.force };
  });
}

async function _siSend(body, isFile) {
  var seq = ++_siSeq;
  var r, data;
  try {
    r = await apiFetch('/api/' + _siSlug + '/songs/import', 'POST', body);
    data = await r.json();
  } catch (e) {
    if (seq === _siSeq) _siStatus(t('common.networkError'), true);
    return null;
  }
  if (seq !== _siSeq) return null;   // a newer check is on its way
  if (!r.ok && !(r.status === 422 && data.rows)) {
    _siStatus(_siErrorText(data), true);
    if (isFile) _siResetFile();
    return null;
  }
  if (isFile) {
    _siColumns = data.columns || [];
    _siIgnored = data.ignored || [];
    _siFlagged = {};
    _siEditable = {};
  }
  _siRows = data.rows;
  _siSummary = data.summary;
  if (data.limit !== undefined) _siLimit = data.limit;
  _siRows.forEach(function(row) { if (row.status === 'error' || row.duplicate) _siFlagged[row.line] = true; });
  if (isFile) _siOnlyIssues = Object.keys(_siFlagged).length > 0;
  _siStatus(r.status === 422 ? t('songImport.stillProblems') : '', r.status === 422);
  _siRender();
  return data;
}

function _siRecheck(delay) {
  _siSeq++;   // an answer to an earlier check would undo this edit
  clearTimeout(_siTimer);
  _siTimer = setTimeout(function() { _siSend({ rows: _siPayloadRows() }); }, delay || 0);
}

async function siImport(btn) {
  if (!_siRows.length) return;
  clearTimeout(_siTimer);
  var seq = ++_siSeq;
  btn.disabled = true;
  _siStatus(t('songImport.importing'));
  var r, data;
  try {
    r = await apiFetch('/api/' + _siSlug + '/songs/import', 'POST', { rows: _siPayloadRows(), commit: true });
    data = await r.json();
  } catch (e) {
    _siStatus(t('common.networkError'), true);
    btn.disabled = false;
    return;
  }
  if (seq !== _siSeq) return;
  if (r.status === 201) {
    document.getElementById('si-preview').style.display = 'none';
    document.getElementById('si-upload').style.display = 'none';
    document.getElementById('si-result-text').textContent = data.imported === 1 ? t('songImport.doneOne') : t('songImport.done', { n: data.imported });
    document.getElementById('si-result').style.display = '';
    _siStatus('');
    return;
  }
  if (r.status === 422 && data.rows) {
    _siRows = data.rows;
    _siSummary = data.summary;
    _siRows.forEach(function(row) { if (row.status === 'error' || row.duplicate) _siFlagged[row.line] = true; });
    _siRender();
    _siStatus(t('songImport.stillProblems'), true);
    return;
  }
  _siStatus(_siErrorText(data), true);
  btn.disabled = false;
}

// ── Edits ─────────────────────────────────────────────────────────────────────

function _siRow(line) {
  line = Number(line);
  for (var i = 0; i < _siRows.length; i++) if (_siRows[i].line === line) return _siRows[i];
  return null;
}

// A cell was changed: keep the text, check again once typing pauses.
function siEdit(el) {
  var row = _siRow(el.getAttribute('data-line'));
  if (!row) return;
  row.values[el.getAttribute('data-col')] = el.value;
  _siRecheck(600);
}

function siToggleSkip(el) {
  var row = _siRow(el.getAttribute('data-line'));
  if (!row) return;
  row.skip = !el.checked;
  _siRecheck();
}

function siToggleForce(el) {
  var row = _siRow(el.getAttribute('data-line'));
  if (!row) return;
  row.force = el.checked;
  _siRecheck();
}

function siSkipAll(status) {
  _siRows.forEach(function(r) { if (r.status === status) r.skip = true; });
  _siRecheck();
}

function siToggleFilter(el) {
  _siOnlyIssues = el.checked;
  _siRender();
}

// ── Render ────────────────────────────────────────────────────────────────────

function _siErrorText(data) {
  var code = data && data.error;
  var known = ['empty_file', 'no_title_column', 'duplicate_column', 'no_rows', 'too_many_rows',
               'file_too_large', 'song_limit'];
  if (known.indexOf(code) >= 0) {
    return t('songImport.file.' + code, { column: data.column || '', max: data.max || '', room: data.room != null ? data.room : '' });
  }
  return (data && typeof data.error === 'string') ? data.error : t('songImport.failed');
}

function _siCellError(err) {
  return t('songImport.err.' + err.code, { max: err.max || '' });
}

function _siDisplay(col, text) {
  if (text == null || text === '') return '';
  if (col === 'lyrics') {
    var lines = String(text).split('\n');
    return escHtml(lines[0]) + (lines.length > 1 ? ' <span class="si-more">+' + (lines.length - 1) + '</span>' : '');
  }
  if (text === 'yes') return escHtml(t('songImport.yes'));
  if (text === 'no') return escHtml(t('songImport.no'));
  return escHtml(text);
}

function _siInput(row, col, bad) {
  var value = row.values[col] == null ? '' : row.values[col];
  var cls = 'si-input' + (bad ? ' si-input--bad' : '');
  var attrs = ' class="' + cls + '" data-line="' + row.line + '" data-col="' + col + '" data-oninput="siEdit(this)"';
  if (col === 'lyrics') return '<textarea rows="2"' + attrs + '>' + escHtml(value) + '</textarea>';
  return '<input type="text"' + attrs + ' value="' + escHtml(value) + '">';
}

function _siStatusCell(row) {
  var b = function(cls, text) { return '<span class="gema-badge ' + cls + '">' + escHtml(text) + '</span>'; };
  if (row.skip) return b('gema-badge-other', t('songImport.statusSkipped'));
  var html = '';
  var n = Object.keys(row.errors).length;
  if (n) html += b('gema-badge-err', n === 1 ? t('songImport.statusOneProblem') : t('songImport.statusProblems', { n: n }));
  if (row.duplicate) {
    var dupText = row.duplicate.of === 'song'
      ? t('songImport.dupSong')
      : t('songImport.dupLine', { line: row.duplicate.line });
    html += b(row.force ? 'gema-badge-other' : 'gema-badge-warn', dupText) +
      '<label class="si-force"><input type="checkbox" data-line="' + row.line + '" data-onchange="siToggleForce(this)"' +
      (row.force ? ' checked' : '') + '> ' + escHtml(t('songImport.importAnyway')) + '</label>';
  }
  if (!html) html = b('gema-badge-ok', t('songImport.statusReady'));
  return html;
}

function _siRender() {
  var s = _siSummary || { total: 0, ready: 0, error: 0, duplicate: 0, skipped: 0 };
  var badge = function(cls, text) { return '<span class="gema-badge ' + cls + '">' + escHtml(text) + '</span>'; };
  document.getElementById('si-summary').innerHTML =
    badge('', t('songImport.sumRows', { n: s.total })) +
    badge('gema-badge-ok', t('songImport.sumReady', { n: s.ready })) +
    (s.error ? badge('gema-badge-err', t('songImport.sumErrors', { n: s.error })) : '') +
    (s.duplicate ? badge('gema-badge-warn', t('songImport.sumDuplicates', { n: s.duplicate })) : '') +
    (s.skipped ? badge('gema-badge-other', t('songImport.sumSkipped', { n: s.skipped })) : '');

  var notes = [];
  if (_siIgnored.length) notes.push(t('songImport.ignoredColumns', { list: _siIgnored.join(', ') }));
  var overLimit = _siLimit && s.ready > _siLimit.room;
  if (overLimit) notes.push(t('songImport.overLimit', { room: _siLimit.room, max: _siLimit.max }));
  document.getElementById('si-notes').innerHTML = notes.map(function(n) { return '<p>' + escHtml(n) + '</p>'; }).join('');

  document.getElementById('si-skip-errors').style.display = s.error ? '' : 'none';
  document.getElementById('si-skip-dups').style.display = s.duplicate ? '' : 'none';
  var hasFlagged = Object.keys(_siFlagged).length > 0;
  document.getElementById('si-filter-row').style.display = hasFlagged ? '' : 'none';
  document.getElementById('si-filter').checked = _siOnlyIssues;

  var blocking = s.error + s.duplicate;
  var btn = document.getElementById('si-import-btn');
  btn.textContent = s.ready === 1 ? t('songImport.importOne') : t('songImport.importN', { n: s.ready });
  btn.disabled = blocking > 0 || s.ready === 0 || !!overLimit;
  document.getElementById('si-import-hint').textContent = blocking
    ? t('songImport.fixFirst', { n: blocking }) : '';

  // Keep the caret where it was: the table is rebuilt after every check.
  var active = document.activeElement;
  var focusLine = active && active.getAttribute && active.getAttribute('data-line');
  var focusCol = active && active.getAttribute('data-col');
  var caret = focusCol && typeof active.selectionStart === 'number' ? active.selectionStart : null;

  var head = '<tr><th>' + escHtml(t('songImport.colImport')) + '</th><th>' + escHtml(t('songImport.colLine')) +
    '</th><th>' + escHtml(t('songImport.colStatus')) + '</th>' +
    _siColumns.map(function(c) { return '<th>' + escHtml(c) + '</th>'; }).join('') + '</tr>';
  var shown = _siRows.filter(function(r) { return !_siOnlyIssues || _siFlagged[r.line]; });
  var body = shown.map(function(row) {
    var cells = _siColumns.map(function(c) {
      var err = !row.skip && row.errors[c];
      var key = row.line + '|' + c;
      // A cell that was editable stays so after it is fixed: the next check
      // must not pull the field away while it is being typed in.
      if (!row.skip && (err || (c === 'title' && row.duplicate))) _siEditable[key] = true;
      var editable = !row.skip && _siEditable[key];
      if (!editable) return '<td class="si-cell">' + _siDisplay(c, row.values[c]) + '</td>';
      return '<td class="si-cell si-cell--edit">' + _siInput(row, c, !!err) +
        (err ? '<div class="si-err">' + escHtml(_siCellError(err)) + '</div>' : '') + '</td>';
    }).join('');
    return '<tr class="' + (row.skip ? 'si-row--skipped' : '') + '">' +
      '<td><input type="checkbox" data-line="' + row.line + '" data-onchange="siToggleSkip(this)"' + (row.skip ? '' : ' checked') +
      ' aria-label="' + escHtml(t('songImport.colImport')) + '"></td>' +
      '<td class="gema-mono">' + row.line + '</td>' +
      '<td class="si-status">' + _siStatusCell(row) + '</td>' + cells + '</tr>';
  }).join('');
  document.getElementById('si-table-wrap').innerHTML = shown.length
    ? '<table class="gema-table si-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>'
    : '<p class="si-empty">' + escHtml(t('songImport.allClear')) + '</p>';
  document.getElementById('si-preview').style.display = '';

  if (focusLine && focusCol) {
    var el = document.querySelector('#si-table-wrap [data-line="' + focusLine + '"][data-col="' + focusCol + '"]');
    if (el) { el.focus(); if (caret != null) try { el.setSelectionRange(caret, caret); } catch (e) {} }
  }
}

function _siStatus(msg, isError) {
  var el = document.getElementById('si-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
  el.style.color = isError ? 'var(--danger-color)' : '';
}

function _siResetFile() {
  var input = document.getElementById('si-file');
  if (input) input.value = '';
  document.getElementById('si-file-info').style.display = 'none';
  document.getElementById('si-drop-label').style.display = '';
}

function _siReset() {
  _siSeq++;
  clearTimeout(_siTimer);
  _siColumns = []; _siIgnored = []; _siRows = []; _siSummary = null; _siLimit = null; _siFlagged = {}; _siEditable = {};
  var preview = document.getElementById('si-preview');
  if (!preview) return;
  preview.style.display = 'none';
  document.getElementById('si-result').style.display = 'none';
  document.getElementById('si-upload').style.display = '';
  _siResetFile();
  _siStatus('');
}

function siStartOver() { _siReset(); }
