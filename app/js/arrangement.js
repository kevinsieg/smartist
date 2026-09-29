
// arrangement.js — per-song arrangement editor, read-only table, and stage popup.
// Loaded by songs.html (editor + panel) and stage.html (popup only).
// Requires: escHtml (core.js), apiFetch + setStatus (session.js / ui.js, songs page only).
// Caller must set window._arrSlug before calling openArrangementEditor.

// stage.html loads this file with core.js only; there apiFetch does not exist, so the
// token is read straight from storage (same keys session.js uses).
function _arrAuthHeaders() {
  var t = sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token');
  return t ? { Authorization: 'Bearer ' + t } : {};
}

// Guarded translation helper — stage.html does not load i18n.js so window.t is absent there.
// vars: optional object for {key} interpolation on the English fallback.
function _arrT(key, en, vars) {
  var s = (typeof window !== 'undefined' && window.t) ? window.t(key, vars) : en;
  if (!window.t && vars) {
    s = en.replace(/\{(\w+)\}/g, function(_, k) { return vars[k] !== undefined ? vars[k] : '{' + k + '}'; });
  }
  return s;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function _arrHarmDisplay(harmony, members) {
  if (!harmony || !harmony.length) return '';
  var abbrMap = {};
  (members || []).forEach(function(m) { abbrMap[m.name] = m.abbr; });
  return harmony.map(function(name) { return abbrMap[name] || name; }).join('+');
}

function _arrVisibleInstruments(configInstruments, hiddenInstruments, rows) {
  var hidden = new Set(hiddenInstruments || []);
  var visible = (configInstruments || [])
    .filter(function(inst) { return !hidden.has(inst.key); })
    .map(function(inst) { return { key: inst.key, label: inst.label || inst.key, orphan: false }; });
  var configKeys = new Set((configInstruments || []).map(function(i) { return i.key; }));
  var orphanKeys = new Set();
  (rows || []).forEach(function(row) {
    Object.keys(row.parts || {}).forEach(function(k) {
      if (!configKeys.has(k) && !hidden.has(k)) orphanKeys.add(k);
    });
  });
  orphanKeys.forEach(function(k) { visible.push({ key: k, label: k, orphan: true }); });
  return visible;
}

// ── Read-only table renderer ──────────────────────────────────────────────────
// Used by: songs panel (auth-only), stage popup

function _arrReadOnlyHtml(arrangement, arrConfig) {
  var members     = (arrConfig && arrConfig.members)     || [];
  var instruments = (arrConfig && arrConfig.instruments) || [];
  var rows        = (arrangement && arrangement.rows)    || [];
  var hidden      = (arrangement && arrangement.hidden_instruments) || [];
  var visible     = _arrVisibleInstruments(instruments, hidden, rows);

  if (!rows.length) {
    return '<p style="color:var(--third-color);font-size:0.82rem;margin:0.5rem 0">' + _arrT('arr.noSections', 'No sections yet.') + '</p>';
  }

  var thFixed = [
    _arrT('arr.colStructure', 'STRUCTURE'),
    _arrT('arr.colPart', 'PART'),
    _arrT('arr.colLead', 'LEAD'),
    _arrT('arr.colHarm', 'HARM'),
    _arrT('arr.colLicks', 'LICKS')
  ].map(function(h) {
    return '<th class="arr-th">' + h + '</th>';
  }).join('');
  var thInst = visible.map(function(v) {
    return '<th class="arr-th arr-th--inst' + (v.orphan ? ' arr-th--orphan' : '') + '">' + escHtml(v.label) + '</th>';
  }).join('');

  var bodyRows = rows.map(function(row, i) {
    var bg       = i % 2 === 1 ? ' arr-tr--alt' : '';
    var leadCls  = row.lead_type === 'person' ? ' arr-lead--person' : row.lead_type === 'instrument' ? ' arr-lead--inst' : '';
    var harmStr  = _arrHarmDisplay(row.harmony, members);
    var tdFixed  =
      '<td class="arr-td arr-td--struct">' + escHtml(row.structure || '') + '</td>' +
      '<td class="arr-td">'                + escHtml(row.part      || '') + '</td>' +
      '<td class="arr-td' + leadCls + '">' + escHtml(row.lead      || '') + '</td>' +
      '<td class="arr-td arr-td--harm">'   + escHtml(harmStr)             + '</td>' +
      '<td class="arr-td">'                + escHtml(row.licks     || '') + '</td>';
    var tdInst = visible.map(function(v) {
      return '<td class="arr-td arr-td--inst">' + escHtml((row.parts || {})[v.key] || '') + '</td>';
    }).join('');
    var tdCom = '<td class="arr-td arr-td--com">' + escHtml(row.comment || '') + '</td>';
    return '<tr class="arr-tr' + bg + '">' + tdFixed + tdInst + tdCom + '</tr>';
  }).join('');

  return '<div class="arr-table-wrap"><table class="arr-table"><thead><tr>' +
    thFixed + thInst + '<th class="arr-th">' + _arrT('arr.colCom', 'COM') + '</th>' +
    '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>';
}

// ── Editor modal state ────────────────────────────────────────────────────────

var _arrEditorSongId    = null;
var _arrEditorSongTitle = '';
var _arrEditorVersions  = [];   // full version objects from API
var _arrEditorActive    = 0;    // index into _arrEditorVersions
var _arrEditorConfig    = null; // arrangementConfig from artists.config
var _arrEditorDirty     = false;
var _arrEditorDraft     = false; // new, unsaved song: edit in memory, persist on song save
var _arrEditorOnDraftSave = null;

// ── Editor entry point ────────────────────────────────────────────────────────

// opts (optional): { draft: <saved draft or null>, onDraftSave: fn(draft) }.
// In draft mode there is no song id: a single version is edited in memory and
// handed back via onDraftSave instead of being written to the server.
function openArrangementEditor(songId, songTitle, arrConfig, opts) {
  opts = opts || {};
  _arrEditorSongId    = songId;
  _arrEditorSongTitle = songTitle || '';
  _arrEditorConfig    = arrConfig || { members: [], instruments: [] };
  _arrEditorDirty     = false;
  _arrEditorDraft     = !songId;
  _arrEditorOnDraftSave = opts.onDraftSave || null;
  _ensureArrModal();
  if (_arrEditorDraft) {
    var d = opts.draft;
    _arrEditorVersions = [{
      id: '_draft', name: 'Default', is_active: true,
      rows: (d && d.rows) || [], hidden_instruments: (d && d.hidden_instruments) || [],
    }];
    _arrEditorActive = 0;
    var modal = document.getElementById('arr-modal');
    if (modal) modal.classList.add('open');
    document.getElementById('arr-modal-title').textContent = '⊞ ' + _arrT('arr.modalTitle', 'Arrangement — {title}', { title: _arrEditorSongTitle });
    _arrRenderEditor();
    return;
  }
  _arrLoadVersions();
}

function _ensureArrModal() {
  if (document.getElementById('arr-modal')) return;
  var el = document.createElement('div');
  el.id        = 'arr-modal';
  el.className = 'arr-modal-overlay';
  el.innerHTML =
    '<div class="arr-modal">' +
      '<div class="arr-modal-header">' +
        '<span class="arr-modal-title" id="arr-modal-title"></span>' +
        '<div class="arr-modal-header-actions">' +
          '<button class="btn active" id="arr-save-btn" onclick="arrSave()">' + _arrT('arr.save', 'Save') + '</button>' +
          '<button class="btn" onclick="closeArrangementEditor()">&#215;</button>' +
        '</div>' +
      '</div>' +
      '<div class="arr-version-bar" id="arr-version-bar"></div>' +
      '<div class="arr-col-toggles" id="arr-col-toggles"></div>' +
      '<div class="arr-grid-wrap" id="arr-grid-wrap"></div>' +
      '<div class="arr-modal-footer">' +
        '<span class="arr-modal-hint">' + _arrT('arr.editorHint', 'Tab — next cell  ·  Enter — new row  ·  ✥ drag to reorder') + '</span>' +
        '<div class="status-msg" id="arr-modal-status"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  el.addEventListener('click', function(e) { if (e.target === el) closeArrangementEditor(); });
}

async function _arrLoadVersions() {
  var modal = document.getElementById('arr-modal');
  if (!modal) return;
  modal.classList.add('open');
  document.getElementById('arr-modal-title').textContent = '⊞ ' + _arrT('arr.modalTitle', 'Arrangement — {title}', { title: _arrEditorSongTitle });
  document.getElementById('arr-grid-wrap').innerHTML =
    '<div style="padding:1rem;color:var(--third-color)">' + _arrT('arr.loading', 'Loading…') + '</div>';

  try {
    // stage.html loads this file without session.js, so apiFetch may not exist —
    // fall back to a plain request with the token added by hand.
    var _arrUrl = '/api/' + window._arrSlug + '/songs/' + _arrEditorSongId + '/arrangements';
    var r = typeof apiFetch === 'function'
      ? await apiFetch(_arrUrl)
      : await fetch(_arrUrl, { headers: _arrAuthHeaders() });
    var data = await r.json();
    _arrEditorVersions = Array.isArray(data) ? data : [];

    if (!_arrEditorVersions.length) {
      var cr = await apiFetch(
        '/api/' + window._arrSlug + '/songs/' + _arrEditorSongId + '/arrangements',
        'POST',
        { name: _arrT('arr.defaultVersionName', 'Default') }
      );
      if (!cr.ok) throw new Error('Failed to create arrangement');
      var v = await cr.json();
      _arrEditorVersions = [v];
    }

    var activeIdx = _arrEditorVersions.findIndex(function(v) { return v.is_active; });
    _arrEditorActive = activeIdx >= 0 ? activeIdx : 0;
    _arrRenderEditor();
  } catch (e) {
    document.getElementById('arr-grid-wrap').innerHTML =
      '<div style="padding:1rem;color:#e55">' + _arrT('arr.loadFailed', 'Failed to load arrangements.') + '</div>';
  }
}

// ── Editor rendering ──────────────────────────────────────────────────────────

function _arrRenderEditor() {
  _arrRenderVersionBar();
  _arrRenderColToggles();
  _arrRenderGrid();
}

function _arrRenderVersionBar() {
  var bar = document.getElementById('arr-version-bar');
  if (!bar) return;
  // Draft mode (new song): single version only, no version management.
  if (_arrEditorDraft) {
    bar.innerHTML = '<span class="arr-tab arr-tab--current"><span class="arr-tab-name">' +
      escHtml(_arrEditorVersions[0].name) + '</span></span>';
    return;
  }
  var html = _arrEditorVersions.map(function(v, i) {
    var isCurrent = i === _arrEditorActive;
    var tabCls    = 'arr-tab' + (isCurrent ? ' arr-tab--current' : '');
    var dot       = v.is_active ? '<span class="arr-active-dot" title="' + _arrT('arr.activeOnStage', 'Active on stage') + '">●</span>' : '';
    var closeBtn  = '<span class="arr-tab-close" onclick="event.stopPropagation();arrDeleteVersion(' + i + ')" title="' + _arrT('arr.deleteVersion', 'Delete version') + '">×</span>';
    return '<button class="' + tabCls + '" onclick="arrSwitchVersion(' + i + ')">' +
      dot +
      '<span class="arr-tab-name" ondblclick="event.stopPropagation();arrRenameVersion(' + i + ')">' +
        escHtml(v.name) +
      '</span>' +
      closeBtn +
    '</button>';
  }).join('');

  html += '<button class="arr-tab arr-tab--add" onclick="arrNewVersion()" title="' + _arrT('arr.newVersion', 'New version') + '">+</button>';

  var cur = _arrEditorVersions[_arrEditorActive];
  if (cur && !cur.is_active) {
    html += '<button class="btn arr-set-active-btn" onclick="arrSetActive()">' + _arrT('arr.setActive', 'Set active') + '</button>';
  }

  var delLabel = _arrEditorVersions.length === 1 ? _arrT('arr.deleteArrangement', 'Delete arrangement') : _arrT('arr.deleteVersion', 'Delete version');
  html += '<button class="btn arr-delete-btn" onclick="arrDeleteVersion(' + _arrEditorActive + ')" title="' + delLabel + '">' + delLabel + '</button>';

  bar.innerHTML = html;
}

function _arrRenderColToggles() {
  var el          = document.getElementById('arr-col-toggles');
  if (!el) return;
  var instruments = (_arrEditorConfig && _arrEditorConfig.instruments) || [];
  if (!instruments.length) { el.innerHTML = ''; return; }
  var cur    = _arrEditorVersions[_arrEditorActive];
  var hidden = new Set((cur && cur.hidden_instruments) || []);
  el.innerHTML =
    '<span class="arr-col-label">' + _arrT('arr.columnsLabel', 'Columns:') + '</span>' +
    instruments.map(function(inst) {
      var checked = !hidden.has(inst.key) ? ' checked' : '';
      return '<label class="arr-col-toggle">' +
        '<input type="checkbox"' + checked + ' data-key="' + escHtml(inst.key) + '" onchange="arrToggleColumn(this.dataset.key,this.checked)"> ' +
        escHtml(inst.label || inst.key) +
      '</label>';
    }).join('');
}

function arrToggleColumn(key, visible) {
  var cur = _arrEditorVersions[_arrEditorActive];
  if (!cur) return;
  var hidden = (cur.hidden_instruments || []).slice();
  if (visible) {
    hidden = hidden.filter(function(k) { return k !== key; });
  } else {
    if (!hidden.includes(key)) hidden.push(key);
  }
  cur.hidden_instruments = hidden;
  _arrEditorDirty = true;
  _arrRenderGrid();
}

function _arrRenderGrid() {
  var wrap = document.getElementById('arr-grid-wrap');
  if (!wrap) return;
  var cur         = _arrEditorVersions[_arrEditorActive];
  if (!cur) return;
  var instruments = (_arrEditorConfig && _arrEditorConfig.instruments) || [];
  var members     = (_arrEditorConfig && _arrEditorConfig.members)     || [];
  var visible     = _arrVisibleInstruments(instruments, cur.hidden_instruments || [], cur.rows || []);
  var rows        = cur.rows || [];
  var colCount    = 1 + 2 + 4 + visible.length + 1; // drag + fixed(struct,part,lead,harm,licks) + inst + actions

  var thFixed =
    '<th class="arr-th"></th>' + // drag handle
    '<th class="arr-th">' + _arrT('arr.colStructure', 'STRUCTURE') + '</th>' +
    '<th class="arr-th">' + _arrT('arr.colPart', 'PART') + '</th>' +
    '<th class="arr-th">' + _arrT('arr.colLead', 'LEAD') + '</th>' +
    '<th class="arr-th">' + _arrT('arr.colHarm', 'HARM') + '</th>' +
    '<th class="arr-th">' + _arrT('arr.colLicks', 'LICKS') + '</th>';
  var thInst = visible.map(function(v) {
    return '<th class="arr-th arr-th--inst">' + escHtml(v.label) + '</th>';
  }).join('');
  var thActions = '<th class="arr-th arr-th--actions"></th>';

  var bodyHtml = rows.map(function(row, ri) {
    return _arrEditorRowHtml(row, ri, visible, members, instruments);
  }).join('');

  bodyHtml +=
    '<tr><td colspan="' + (6 + visible.length + 1) + '" class="arr-add-row-cell">' +
      '<button class="arr-add-row-btn" onclick="arrAddRow()">' + _arrT('arr.addRow', '+ Add row') + '</button>' +
    '</td></tr>';

  wrap.innerHTML =
    '<div style="overflow-x:auto"><table class="arr-table arr-table--edit" id="arr-edit-table">' +
      '<thead><tr>' + thFixed + thInst + thActions + '</tr></thead>' +
      '<tbody id="arr-tbody">' + bodyHtml + '</tbody>' +
    '</table></div>';

  _arrWireDrag();
}

function _arrEditorRowHtml(row, ri, visible, members, instruments) {
  // LEAD grouped select: value encodes "type:name" e.g. "person:Ludo"
  var leadVal = row.lead ? (row.lead_type + ':' + row.lead) : '';
  var leadColor = row.lead_type === 'person'     ? 'style="color:var(--arr-lead-person,#3d6bce);font-weight:600"'
                : row.lead_type === 'instrument' ? 'style="color:var(--arr-lead-inst,#b06a2a);font-weight:600"'
                : '';
  var membersOpts = (members || []).map(function(m) {
    var sel = (row.lead === m.name && row.lead_type === 'person') ? ' selected' : '';
    return '<option value="person:' + escHtml(m.name) + '"' + sel + '>' + escHtml(m.name) + '</option>';
  }).join('');
  var instOpts = (instruments || []).map(function(inst) {
    var sel = (row.lead === inst.key && row.lead_type === 'instrument') ? ' selected' : '';
    return '<option value="instrument:' + escHtml(inst.key) + '"' + sel + '>' + escHtml(inst.key) + '</option>';
  }).join('');
  var leadSel =
    '<select class="arr-sel arr-lead-sel" data-ri="' + ri + '" onchange="arrLeadChange(this)" ' + leadColor + '>' +
      '<option value="">—</option>' +
      '<optgroup label="' + _arrT('arr.people', 'People') + '">'      + membersOpts + '</optgroup>' +
      '<optgroup label="' + _arrT('arr.instruments', 'Instruments') + '">' + instOpts    + '</optgroup>' +
    '</select>';

  // HARM chip display + clickable cell
  var harmStr = _arrHarmDisplay(row.harmony, members);
  var harmEl =
    '<div class="arr-harm-cell" data-ri="' + ri + '" onclick="arrOpenHarmPicker(this,' + ri + ')">' +
      (harmStr
        ? '<span class="arr-harm-value">' + escHtml(harmStr) + '</span>'
        : '<span class="arr-harm-placeholder">—</span>') +
    '</div>';

  // LICKS select (instruments only)
  var licksOpts = (instruments || []).map(function(inst) {
    var sel = row.licks === inst.key ? ' selected' : '';
    return '<option value="' + escHtml(inst.key) + '"' + sel + '>' + escHtml(inst.key) + '</option>';
  }).join('');
  var licksSel =
    '<select class="arr-sel" data-ri="' + ri + '" data-field="licks" onchange="arrCellChange(this)">' +
      '<option value="">—</option>' + licksOpts +
    '</select>';

  // Instrument technique selects
  var instCells = visible.map(function(v) {
    var instCfg    = (instruments || []).find(function(i) { return i.key === v.key; });
    var techniques = (instCfg && instCfg.techniques) || [];
    if (v.orphan) {
      var curVal = (row.parts || {})[v.key] || '';
      if (curVal && !techniques.includes(curVal)) techniques = [curVal];
    }
    var techOpts = techniques.map(function(t) {
      var sel = (row.parts || {})[v.key] === t ? ' selected' : '';
      return '<option value="' + escHtml(t) + '"' + sel + '>' + escHtml(t) + '</option>';
    }).join('');
    return '<td class="arr-td arr-td--inst">' +
      '<select class="arr-sel" data-ri="' + ri + '" data-field="parts.' + escHtml(v.key) + '" onchange="arrCellChange(this)">' +
        '<option value="">—</option>' + techOpts +
      '</select>' +
    '</td>';
  }).join('');

  return '<tr class="arr-tr" draggable="true" data-ri="' + ri + '">' +
    '<td class="arr-td arr-td--drag" title="' + _arrT('arr.dragToReorder', 'Drag to reorder') + '">&#10021;</td>' +
    '<td class="arr-td"><input class="arr-inp" data-ri="' + ri + '" data-field="structure" value="' + escHtml(row.structure || '') + '" onchange="arrCellChange(this)" onkeydown="arrKeydown(event,' + ri + ')"></td>' +
    '<td class="arr-td"><input class="arr-inp arr-inp--sm" data-ri="' + ri + '" data-field="part" value="' + escHtml(row.part || '') + '" onchange="arrCellChange(this)" onkeydown="arrKeydown(event,' + ri + ')"></td>' +
    '<td class="arr-td">' + leadSel + '</td>' +
    '<td class="arr-td">' + harmEl  + '</td>' +
    '<td class="arr-td">' + licksSel + '</td>' +
    instCells +
    '<td class="arr-td arr-td--actions">' +
      '<button class="arr-row-btn" onclick="arrDuplicateRow(' + ri + ')" title="' + _arrT('arr.duplicate', 'Duplicate') + '">&#10066;</button>' +
      '<button class="arr-row-btn arr-row-btn--del" onclick="arrDeleteRow(' + ri + ')" title="' + _arrT('arr.deleteRow', 'Delete') + '">&#215;</button>' +
    '</td>' +
  '</tr>';
}

// ── Cell change handlers ──────────────────────────────────────────────────────

function arrLeadChange(sel) {
  var ri  = Number(sel.dataset.ri);
  var val = sel.value;
  var cur = _arrEditorVersions[_arrEditorActive];
  if (!cur || !cur.rows[ri]) return;
  if (!val) {
    cur.rows[ri].lead      = '';
    cur.rows[ri].lead_type = '';
    sel.style.color      = '';
    sel.style.fontWeight = '';
  } else {
    var idx  = val.indexOf(':');
    var type = val.slice(0, idx);
    var name = val.slice(idx + 1);
    cur.rows[ri].lead_type = type;
    cur.rows[ri].lead      = name;
    sel.style.color      = type === 'person' ? 'var(--arr-lead-person,#3d6bce)' : 'var(--arr-lead-inst,#b06a2a)';
    sel.style.fontWeight = '600';
  }
  _arrEditorDirty = true;
}

function arrCellChange(el) {
  var ri    = Number(el.dataset.ri);
  var field = el.dataset.field;
  var val   = el.value;
  var cur   = _arrEditorVersions[_arrEditorActive];
  if (!cur || !cur.rows[ri]) return;
  if (field.startsWith('parts.')) {
    var key = field.slice(6);
    if (!cur.rows[ri].parts) cur.rows[ri].parts = {};
    cur.rows[ri].parts[key] = val;
  } else {
    cur.rows[ri][field] = val;
  }
  _arrEditorDirty = true;
}

function arrKeydown(e, ri) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  var cur = _arrEditorVersions[_arrEditorActive];
  if (!cur) return;
  cur.rows.splice(ri + 1, 0, { structure: '', part: '', lead: '', lead_type: '', harmony: [], licks: '', parts: {}, comment: '' });
  _arrEditorDirty = true;
  _arrRenderGrid();
  setTimeout(function() {
    var rows = document.querySelectorAll('#arr-tbody .arr-tr');
    if (rows[ri + 1]) {
      var inp = rows[ri + 1].querySelector('.arr-inp');
      if (inp) inp.focus();
    }
  }, 0);
}

function arrAddRow() {
  var cur = _arrEditorVersions[_arrEditorActive];
  if (!cur) return;
  cur.rows.push({ structure: '', part: '', lead: '', lead_type: '', harmony: [], licks: '', parts: {}, comment: '' });
  _arrEditorDirty = true;
  _arrRenderGrid();
  setTimeout(function() {
    var rows = document.querySelectorAll('#arr-tbody .arr-tr');
    var last = rows[rows.length - 1];
    if (last) {
      var inp = last.querySelector('.arr-inp');
      if (inp) { inp.focus(); inp.scrollIntoView({ block: 'nearest' }); }
    }
  }, 0);
}

function arrDeleteRow(ri) {
  var cur = _arrEditorVersions[_arrEditorActive];
  if (!cur) return;
  cur.rows.splice(ri, 1);
  _arrEditorDirty = true;
  _arrRenderGrid();
}

function arrDuplicateRow(ri) {
  var cur = _arrEditorVersions[_arrEditorActive];
  if (!cur) return;
  var copy = JSON.parse(JSON.stringify(cur.rows[ri]));
  cur.rows.splice(ri + 1, 0, copy);
  _arrEditorDirty = true;
  _arrRenderGrid();
}

// ── Harmony picker ────────────────────────────────────────────────────────────

var _arrHarmPickerRi       = -1;
var _arrHarmPickerCloseFn  = null; // tracked so closeArrangementEditor can remove it

function arrOpenHarmPicker(cell, ri) {
  var existing = document.getElementById('arr-harm-picker');
  if (existing) {
    existing.remove();
    if (_arrHarmPickerCloseFn) { document.removeEventListener('click', _arrHarmPickerCloseFn); _arrHarmPickerCloseFn = null; }
    if (_arrHarmPickerRi === ri) { _arrHarmPickerRi = -1; return; }
  }
  _arrHarmPickerRi = ri;
  var cur     = _arrEditorVersions[_arrEditorActive];
  if (!cur || !cur.rows[ri]) return;
  var members  = (_arrEditorConfig && _arrEditorConfig.members) || [];
  var selected = new Set(cur.rows[ri].harmony || []);

  var picker = document.createElement('div');
  picker.id        = 'arr-harm-picker';
  picker.className = 'arr-harm-picker';
  // Use data-name attribute instead of inline onclick string to avoid escaping issues
  picker.innerHTML = members.length
    ? members.map(function(m) {
        var isSel = selected.has(m.name);
        return '<div class="arr-harm-item' + (isSel ? ' arr-harm-item--sel' : '') + '" data-ri="' + ri + '" data-name="' + escHtml(m.name) + '">' +
          '<span class="arr-harm-abbr">' + escHtml(m.abbr) + '</span>' +
          '<span>' + escHtml(m.name) + '</span>' +
          (isSel ? '<span style="margin-left:auto;color:var(--arr-lead-person,#3d6bce)">✓</span>' : '') +
        '</div>';
      }).join('')
    : '<div style="padding:0.5rem;color:var(--third-color);font-size:0.8rem">' + _arrT('arr.noMembers', 'No members configured in Hub') + '</div>';

  picker.addEventListener('click', function(e) {
    var item = e.target.closest('.arr-harm-item');
    if (item) arrToggleHarm(Number(item.dataset.ri), item.dataset.name);
  });

  var rect = cell.getBoundingClientRect();
  picker.style.cssText = 'position:fixed;top:' + (rect.bottom + 2) + 'px;left:' + rect.left + 'px;z-index:1001';
  document.body.appendChild(picker);

  setTimeout(function() {
    _arrHarmPickerCloseFn = function close(e) {
      if (!picker.contains(e.target) && e.target !== cell) {
        picker.remove();
        _arrHarmPickerRi      = -1;
        _arrHarmPickerCloseFn = null;
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', _arrHarmPickerCloseFn);
  }, 0);
}

function arrToggleHarm(ri, name) {
  var cur = _arrEditorVersions[_arrEditorActive];
  if (!cur || !cur.rows[ri]) return;
  var harmony = (cur.rows[ri].harmony || []).slice();
  var idx = harmony.indexOf(name);
  if (idx >= 0) harmony.splice(idx, 1); else harmony.push(name);
  cur.rows[ri].harmony = harmony;
  _arrEditorDirty = true;

  // Update the cell display without full re-render
  var cell = document.querySelector('.arr-harm-cell[data-ri="' + ri + '"]');
  if (cell) {
    var members = (_arrEditorConfig && _arrEditorConfig.members) || [];
    var harmStr = _arrHarmDisplay(harmony, members);
    cell.innerHTML = harmStr
      ? '<span class="arr-harm-value">' + escHtml(harmStr) + '</span>'
      : '<span class="arr-harm-placeholder">—</span>';
    // Refresh picker
    var picker = document.getElementById('arr-harm-picker');
    if (picker) arrOpenHarmPicker(cell, ri);
  }
}

// ── Drag-to-reorder ───────────────────────────────────────────────────────────

var _arrDragRi = -1;

function _arrWireDrag() {
  var tbody = document.getElementById('arr-tbody');
  if (!tbody) return;
  tbody.addEventListener('dragstart', function(e) {
    var row = e.target.closest('.arr-tr[draggable]');
    if (!row) return;
    _arrDragRi = Number(row.dataset.ri);
    e.dataTransfer.effectAllowed = 'move';
  });
  tbody.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  tbody.addEventListener('drop', function(e) {
    e.preventDefault();
    var row = e.target.closest('.arr-tr[draggable]');
    if (!row || _arrDragRi < 0) return;
    var targetRi = Number(row.dataset.ri);
    if (targetRi === _arrDragRi) return;
    var cur = _arrEditorVersions[_arrEditorActive];
    if (!cur) return;
    var moved = cur.rows.splice(_arrDragRi, 1)[0];
    cur.rows.splice(targetRi, 0, moved);
    _arrEditorDirty = true;
    _arrRenderGrid();
    _arrDragRi = -1;
  });
}

// ── Version management ────────────────────────────────────────────────────────

function arrSwitchVersion(i) {
  if (_arrEditorDirty) {
    if (!confirm(_arrT('arr.unsavedSwitchConfirm', 'You have unsaved changes. Switch version without saving?'))) return;
  }
  _arrEditorActive = i;
  _arrEditorDirty  = false;
  _arrRenderEditor();
}

async function arrNewVersion() {
  var choice = confirm(_arrT('arr.newVersionConfirm', 'Copy current version?\nOK = copy, Cancel = blank'));
  var body   = { name: _arrT('arr.versionNamePrefix', 'Version') + ' ' + (_arrEditorVersions.length + 1) };
  if (choice) {
    var cur = _arrEditorVersions[_arrEditorActive];
    if (cur) body.copy_from = cur.id;
  }
  var r = await apiFetch(
    '/api/' + window._arrSlug + '/songs/' + _arrEditorSongId + '/arrangements',
    'POST',
    body
  );
  var v = await r.json();
  if (!r.ok) { setStatus('arr-modal-status', v.error || _arrT('arr.error', 'Error'), true); return; }
  _arrEditorVersions.push(v);
  _arrEditorActive = _arrEditorVersions.length - 1;
  _arrEditorDirty  = false;
  _arrRenderEditor();
}

async function arrDeleteVersion(i) {
  var v = _arrEditorVersions[i];
  if (!v) return;
  var isLast = _arrEditorVersions.length === 1;
  var msg = isLast
    ? _arrT('arr.deleteAllConfirm', 'Delete all arrangement data for "{title}"? This cannot be undone.', { title: _arrEditorSongTitle })
    : _arrT('arr.deleteVersionConfirm', 'Delete version "{name}"?', { name: v.name });
  if (!confirm(msg)) return;
  var r = await apiFetch(
    '/api/' + window._arrSlug + '/songs/' + _arrEditorSongId + '/arrangements/' + v.id,
    'DELETE'
  );
  if (!r.ok) {
    var j = await r.json();
    setStatus('arr-modal-status', j.error || _arrT('arr.cannotDelete', 'Cannot delete'), true);
    return;
  }
  _arrEditorVersions.splice(i, 1);
  _arrEditorDirty = false;
  if (!_arrEditorVersions.length) {
    closeArrangementEditor();
    if (typeof window._arrOnAllDeleted === 'function') window._arrOnAllDeleted(_arrEditorSongId);
    return;
  }
  if (_arrEditorActive >= _arrEditorVersions.length) _arrEditorActive = _arrEditorVersions.length - 1;
  _arrRenderEditor();
}

async function arrSetActive() {
  var v = _arrEditorVersions[_arrEditorActive];
  if (!v) return;
  var r = await apiFetch(
    '/api/' + window._arrSlug + '/songs/' + _arrEditorSongId + '/arrangements/' + v.id + '/activate',
    'POST'
  );
  if (!r.ok) {
    var j = await r.json();
    setStatus('arr-modal-status', j.error || _arrT('arr.error', 'Error'), true);
    return;
  }
  var updated = await r.json();
  _arrEditorVersions.forEach(function(ver) { ver.is_active = false; });
  _arrEditorVersions[_arrEditorActive] = updated;
  _arrRenderVersionBar();
  setStatus('arr-modal-status', _arrT('arr.activeUpdated', 'Active version updated.'));
  setTimeout(function() { setStatus('arr-modal-status', ''); }, 2000);
}

async function arrRenameVersion(i) {
  var v = _arrEditorVersions[i];
  if (!v) return;
  var name = prompt(_arrT('arr.versionNamePrompt', 'Version name:'), v.name);
  if (!name || name === v.name) return;
  var r = await apiFetch(
    '/api/' + window._arrSlug + '/songs/' + _arrEditorSongId + '/arrangements/' + v.id,
    'PUT',
    { name: name }
  );
  if (!r.ok) { var j = await r.json(); setStatus('arr-modal-status', j.error || _arrT('arr.renameFailed', 'Rename failed'), true); return; }
  v.name = name;
  _arrRenderVersionBar();
}

async function arrSave() {
  var cur = _arrEditorVersions[_arrEditorActive];
  if (!cur) return;

  // Draft mode: hand the arrangement back to the caller; it persists when the
  // song is created. No API call (the song has no id yet).
  if (_arrEditorDraft) {
    _arrEditorDirty = false;
    if (_arrEditorOnDraftSave) {
      _arrEditorOnDraftSave({ rows: cur.rows || [], hidden_instruments: cur.hidden_instruments || [] });
    }
    closeArrangementEditor();
    return;
  }

  setStatus('arr-modal-status', _arrT('arr.saving', 'Saving…'));
  var btn = document.getElementById('arr-save-btn');
  if (btn) btn.disabled = true;
  var r = await apiFetch(
    '/api/' + window._arrSlug + '/songs/' + _arrEditorSongId + '/arrangements/' + cur.id,
    'PUT',
    { rows: cur.rows, hidden_instruments: cur.hidden_instruments || [] }
  );
  if (btn) btn.disabled = false;
  if (!r.ok) {
    var j = await r.json();
    setStatus('arr-modal-status', j.error || _arrT('arr.errorSaving', 'Error saving'), true);
    return;
  }
  var updated = await r.json();
  _arrEditorVersions[_arrEditorActive] = updated;
  _arrEditorDirty = false;
  if (btn) {
    btn.textContent = _arrT('arr.savedConfirm', '✓ Saved');
    btn.style.background = '#4a9a6a';
    btn.style.borderColor = '#4a9a6a';
    setTimeout(function() {
      btn.textContent = _arrT('arr.save', 'Save');
      btn.style.background = '';
      btn.style.borderColor = '';
    }, 1500);
  }
}

function closeArrangementEditor() {
  if (_arrEditorDirty && !confirm(_arrT('arr.unsavedCloseConfirm', 'Unsaved changes. Close without saving?'))) return;
  var modal = document.getElementById('arr-modal');
  if (modal) modal.classList.remove('open');
  var picker = document.getElementById('arr-harm-picker');
  if (picker) picker.remove();
  if (_arrHarmPickerCloseFn) { document.removeEventListener('click', _arrHarmPickerCloseFn); _arrHarmPickerCloseFn = null; }
  _arrHarmPickerRi = -1;
  _arrEditorDirty  = false;
}

// ── Stage popup ───────────────────────────────────────────────────────────────

function openArrStagePopup(arrangement, arrConfig) {
  _ensureArrStageModal();
  var body = document.getElementById('arr-stage-body');
  if (!body) return;
  body.innerHTML = _arrReadOnlyHtml(arrangement, arrConfig);
  document.getElementById('arr-stage-modal').classList.add('open');
}

function _ensureArrStageModal() {
  if (document.getElementById('arr-stage-modal')) return;
  var el = document.createElement('div');
  el.id        = 'arr-stage-modal';
  el.className = 'arr-stage-modal-overlay';
  el.innerHTML =
    '<div class="arr-stage-modal">' +
      '<div class="arr-stage-modal-header">' +
        '<span>' + _arrT('arr.stageTitle', 'Arrangement') + '</span>' +
        '<button onclick="closeArrStagePopup()" style="background:none;border:none;color:#888;cursor:pointer;font-size:1.1rem;line-height:1">&#215;</button>' +
      '</div>' +
      '<div class="arr-stage-body" id="arr-stage-body"></div>' +
    '</div>';
  el.addEventListener('click', function(e) { if (e.target === el) closeArrStagePopup(); });
  document.body.appendChild(el);
}

function closeArrStagePopup() {
  var modal = document.getElementById('arr-stage-modal');
  if (modal) modal.classList.remove('open');
}
