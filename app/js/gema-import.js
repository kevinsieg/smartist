'use strict';

let _csvText = null;
let _csvType = null;
let _validationResult = null;
let bandSlug = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function init() {
  const cfg = await loadConfig();
  bandSlug = cfg.slug;
  applyNav(cfg.name, cfg.config);

  window.onNavAuthEmpty = function(el) {
    el.innerHTML = '<button class="nav-auth-login" onclick="showLoginArea()">login to import</button>';
  };

  if (sessionStorage.getItem('setlist_token')) {
    showImportArea();
  } else {
    showLoginArea();
  }
})();

function showLoginArea() {
  document.getElementById('login-area').style.display = '';
  document.getElementById('import-area').style.display = 'none';
}

function showImportArea() {
  document.getElementById('login-area').style.display = 'none';
  document.getElementById('import-area').style.display = '';
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function doLogin() {
  const pw = document.getElementById('login-pw').value;
  if (!pw) return;
  const r = await fetch(`/api/${bandSlug}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (r.ok) {
    sessionStorage.setItem('setlist_token', pw);
    updateAuthIndicator();
    showImportArea();
  } else {
    const err = document.getElementById('login-error');
    err.textContent = 'Wrong password.';
    err.style.display = '';
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'login-pw') doLogin();
});

// ── File handling ─────────────────────────────────────────────────────────────

function handleDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
}

function handleFileSelect(file) {
  if (!file) return;
  resetPreview();

  const reader = new FileReader();
  reader.onload = function(e) {
    _csvText = e.target.result;
    _csvType = detectType(file.name);

    const fileInfo = document.getElementById('file-info');
    fileInfo.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
    fileInfo.style.display = '';
    document.getElementById('drop-label').style.display = 'none';

    const sel = document.getElementById('type-select');
    sel.value = _csvType || 'info';
    document.getElementById('type-row').style.display = '';
    document.getElementById('step1-actions').style.display = '';
    setStatus('');
  };
  reader.readAsText(file, 'UTF-8');
}

function detectType(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes('werkinformation'))  return 'info';
  if (lower.includes('beteiligte'))       return 'beteiligte';
  if (lower.includes('identifikatoren')) return 'ids';
  return 'info';
}

// ── Validate / Import ─────────────────────────────────────────────────────────

async function runValidate() {
  if (!_csvText) return;
  _csvType = document.getElementById('type-select').value;

  setStatus('Validating…');
  document.getElementById('validate-btn').disabled = true;
  document.getElementById('preview-area').style.display = 'none';

  try {
    const data = await callImport({ dryRun: true });
    _validationResult = data;
    renderPreview(data);
    setStatus('');
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  } finally {
    document.getElementById('validate-btn').disabled = false;
  }
}

async function runImport() {
  if (!_csvText || !_validationResult) return;
  _csvType = document.getElementById('type-select').value;

  setStatus('Importing…');
  document.getElementById('import-btn').disabled = true;

  try {
    const data = await callImport({ dryRun: false });
    renderResult(data);
    setStatus('');
    document.getElementById('preview-area').style.display = 'none';
    _csvText = null;
    _csvType = null;
    _validationResult = null;
  } catch (e) {
    setStatus('Error: ' + e.message, true);
    document.getElementById('import-btn').disabled = false;
  }
}

async function callImport({ dryRun }) {
  const r = await fetch(`/api/${bandSlug}/gema/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionStorage.getItem('setlist_token')}`,
    },
    body: JSON.stringify({
      type: _csvType,
      csv: _csvText,
      dryRun,
      ownerIpNameNumber: document.getElementById('owner-ip').value.trim() || undefined,
    }),
  });
  if (r.status === 401) { sessionStorage.removeItem('setlist_token'); showLoginArea(); throw new Error('Session expired — please log in again'); }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Import failed');
  return data;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderPreview(data) {
  const area = document.getElementById('preview-area');
  document.getElementById('preview-summary').innerHTML = summaryHtml(data, true);
  document.getElementById('preview-table-wrap').innerHTML = tableHtml(data, true);
  document.getElementById('import-btn').disabled = false;
  area.style.display = '';
}

function renderResult(data) {
  const area = document.getElementById('result-area');
  document.getElementById('result-summary').innerHTML = summaryHtml(data, false);
  document.getElementById('result-table-wrap').innerHTML = tableHtml(data, false);
  area.style.display = '';
}

function summaryHtml(data, isDryRun) {
  const label = isDryRun ? 'Preview' : 'Imported';
  if (data.type === 'beteiligte') {
    const { total, worksFound, worksMissing, errors } = data.summary;
    const warn     = worksMissing ? `<span class="gema-badge gema-badge-warn">${worksMissing} works not in DB</span>` : '';
    const errBadge = errors       ? `<span class="gema-badge gema-badge-err">${errors} errors</span>` : '';
    return `<strong>${label}:</strong>
      <span class="gema-badge">${total} rightholders</span>
      <span class="gema-badge gema-badge-ok">${worksFound} works updated</span>
      ${warn}${errBadge}`;
  }
  const { total, matched, matchedExact, matchedNorm, ownUnmatched, otherProject, new: newCount, existing, errors } = data.summary;

  const matchDetail = matchedNorm
    ? `${matched} linked (${matchedExact} exact · ${matchedNorm} normalised)`
    : `${matched} linked to songs`;

  const ownBadge   = ownUnmatched != null && ownUnmatched > 0
    ? `<span class="gema-badge gema-badge-own">${ownUnmatched} own composition${ownUnmatched > 1 ? 's' : ''}, no song match</span>`
    : '';
  const otherBadge = otherProject != null && otherProject > 0
    ? `<span class="gema-badge gema-badge-other">${otherProject} other-project work${otherProject > 1 ? 's' : ''}</span>`
    : '';
  const warnBadge  = ownUnmatched == null && (total - matched) > 0
    ? `<span class="gema-badge gema-badge-warn">${total - matched} unmatched</span>`
    : '';
  const errBadge   = errors ? `<span class="gema-badge gema-badge-err">${errors} errors</span>` : '';

  return `<strong>${label}:</strong>
    <span class="gema-badge">${total} works</span>
    <span class="gema-badge gema-badge-ok">${matchDetail}</span>
    ${ownBadge}${otherBadge}${warnBadge}
    <span class="gema-badge">${newCount} new · ${existing} existing</span>
    ${errBadge}`;
}

function fmtDuration(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function tableHtml(data, isDryRun) {
  if (data.type === 'beteiligte') return beteiligteTableHtml(data.rows);
  return infoTableHtml(data.rows, data.type);
}

function infoTableHtml(rows, type) {
  const isIds = type === 'ids';
  const hasOwn = rows.some(r => r.isOwnWork !== null);
  const ownTh  = hasOwn ? '<th>Own?</th>' : '';
  const matchTh = '<th>Match</th>';
  const ths = isIds
    ? `<th>Work #</th><th>Title</th><th>Linked song</th>${matchTh}${ownTh}<th>Status</th><th>ISWC</th><th>ISRC</th>`
    : `<th>Work #</th><th>Title</th><th>Linked song</th>${matchTh}${ownTh}<th>Status</th><th>Lang</th><th>Duration</th>`;

  const trs = rows.map(r => {
    const matchBadge = r.matchedBy === 'exact'
      ? '<span class="gema-badge gema-badge-ok">exact</span>'
      : r.matchedBy === 'normalized'
      ? '<span class="gema-badge gema-badge-new">~norm</span>'
      : '<span style="color:var(--third-color)">—</span>';

    const ownCell = hasOwn
      ? `<td>${r.isOwnWork === true ? '<span class="gema-badge gema-badge-own">own</span>' : r.isOwnWork === false ? '<span class="gema-badge gema-badge-other">other</span>' : '—'}</td>`
      : '';

    const linked  = r.matchedSong ? escHtml(r.matchedSong) : '<span style="color:var(--third-color)">—</span>';
    const status  = r.isNew ? '<span class="gema-badge gema-badge-new">new</span>' : '<span class="gema-badge">update</span>';
    const errCell = r.error ? `<td colspan="2" style="color:var(--danger-color)">${escHtml(r.error)}</td>` : '';
    const extra   = isIds
      ? `<td>${r.iswc || '—'}</td><td>${r.isrc || '—'}</td>`
      : `<td>${r.language || '—'}</td><td>${fmtDuration(r.durationSec)}</td>`;

    const rowClass = !r.matchedSong && r.isOwnWork === true  ? ' class="gema-row-own"'
                   : !r.matchedSong && r.isOwnWork === false ? ' class="gema-row-other"'
                   : r.error                                 ? ' class="gema-row-err"'
                   : '';
    return `<tr${rowClass}>
      <td class="gema-mono">${escHtml(r.gema_work_number)}</td>
      <td>${escHtml(r.title)}</td>
      <td>${linked}</td>
      <td>${matchBadge}</td>
      ${ownCell}
      <td>${status}</td>
      ${errCell || extra}
    </tr>`;
  }).join('');

  return `<table class="gema-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

function beteiligteTableHtml(rows) {
  const ths = '<th>Work #</th><th>Title</th><th>In DB</th><th>New rightholders</th><th>Replacing</th><th>Names</th>';
  const trs = rows.map(r => {
    const inDb    = r.found ? '✓' : '<span style="color:var(--danger-color)">✗ missing</span>';
    const names   = r.rightholders.map(rh => `${escHtml(rh.name)} (${rh.role ?? '?'})`).join(', ');
    const errCell = r.error ? `<td colspan="3" style="color:var(--danger-color)">${escHtml(r.error)}</td>` : '';
    return `<tr${!r.found ? ' class="gema-row-warn"' : ''}${r.error ? ' class="gema-row-err"' : ''}>
      <td class="gema-mono">${escHtml(r.gema_work_number)}</td>
      <td>${escHtml(r.title)}</td>
      <td>${inDb}</td>
      ${errCell || `<td>${r.rightholderCount}</td><td>${r.existingCount}</td><td class="gema-names">${names}</td>`}
    </tr>`;
  }).join('');

  return `<table class="gema-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function resetPreview() {
  document.getElementById('preview-area').style.display = 'none';
  document.getElementById('result-area').style.display = 'none';
  _validationResult = null;
  setStatus('');
}

function resetImport() {
  _csvText = null;
  _csvType = null;
  _validationResult = null;
  document.getElementById('csv-input').value = '';
  document.getElementById('drop-label').style.display = '';
  document.getElementById('file-info').style.display = 'none';
  document.getElementById('type-row').style.display = 'none';
  document.getElementById('step1-actions').style.display = 'none';
  document.getElementById('preview-area').style.display = 'none';
  document.getElementById('result-area').style.display = 'none';
  setStatus('');
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('import-status');
  el.textContent = msg;
  el.style.color  = isError ? 'var(--danger-color)' : 'var(--third-color)';
  el.style.display = msg ? '' : 'none';
}
