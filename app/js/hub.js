'use strict';

// ── Platform registry ─────────────────────────────────────────────────────────

var PLATFORMS = [
  // Streaming
  { id: 'spotify',       label: 'Spotify',       group: 'streaming', urlHint: 'https://open.spotify.com/artist/…' },
  { id: 'apple_music',   label: 'Apple Music',   group: 'streaming', urlHint: 'https://music.apple.com/artist/…' },
  { id: 'deezer',        label: 'Deezer',        group: 'streaming', urlHint: 'https://www.deezer.com/artist/…' },
  { id: 'tidal',         label: 'Tidal',         group: 'streaming', urlHint: 'https://tidal.com/artist/…' },
  { id: 'qobuz',         label: 'Qobuz',         group: 'streaming', urlHint: 'https://www.qobuz.com/…/interpreter/…' },
  { id: 'amazon_music',  label: 'Amazon Music',  group: 'streaming', urlHint: 'https://music.amazon.com/artists/…' },
  { id: 'youtube_music', label: 'YouTube Music', group: 'streaming', urlHint: 'https://music.youtube.com/channel/…' },
  { id: 'soundcloud',    label: 'SoundCloud',    group: 'streaming', urlHint: 'https://soundcloud.com/…' },
  { id: 'bandcamp',      label: 'Bandcamp',      group: 'streaming', urlHint: 'https://….bandcamp.com' },
  { id: 'audiomack',     label: 'Audiomack',     group: 'streaming', urlHint: 'https://audiomack.com/…' },
  { id: 'boomplay',      label: 'Boomplay',      group: 'streaming', urlHint: 'https://www.boomplay.com/artists/…' },
  // Social & video
  { id: 'instagram',     label: 'Instagram',     group: 'social',    urlHint: 'https://instagram.com/…' },
  { id: 'facebook',      label: 'Facebook',      group: 'social',    urlHint: 'https://facebook.com/…' },
  { id: 'tiktok',        label: 'TikTok',        group: 'social',    urlHint: 'https://tiktok.com/@…' },
  { id: 'x',             label: 'X',             group: 'social',    urlHint: 'https://x.com/…' },
  { id: 'youtube',       label: 'YouTube',       group: 'social',    urlHint: 'https://youtube.com/@…' },
  { id: 'linkedin',      label: 'LinkedIn',      group: 'social',    urlHint: 'https://linkedin.com/in/…' },
];

// ── State ─────────────────────────────────────────────────────────────────────

var _cfg = null;
var _editingId = null; // platform key being edited; null = new custom
var _viewMode = false;

function _platforms() { return _cfg?.config?.platforms || {}; }

// ── Boot ──────────────────────────────────────────────────────────────────────

initPage(async function(cfg, viewMode) {
  _cfg = cfg;
  _viewMode = viewMode;
  renderHub();
  renderArrangementConfig();
  if (_viewMode) {
    applyViewMode();
  }
});

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderHub() {
  const conn = _platforms();
  renderGroup('streaming-grid', 'streaming', conn);
  renderGroup('social-grid',    'social',    conn);
  renderCustom(conn);
}

function renderGroup(containerId, group, conn) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = PLATFORMS
    .filter(p => p.group === group)
    .map(p => platformCard(p, conn[p.id]))
    .join('');
}

function renderCustom(conn) {
  const el = document.getElementById('custom-grid');
  if (!el) return;
  const customs = Object.entries(conn)
    .filter(([id]) => id.startsWith('custom_'))
    .sort(([, a], [, b]) => (a.label || '').localeCompare(b.label || ''));

  var addTile = _viewMode ? '' :
    `<div class="platform-card pc-add" onclick="openAddModal()">
       <div class="pc-top">
         <span class="pc-icon pc-icon-add">+</span>
         <div class="pc-info">
           <div class="pc-name">Add platform</div>
           <div class="pc-status">Custom integration</div>
         </div>
       </div>
     </div>`;
  el.innerHTML = customs.map(([id, c]) => customCard(id, c)).join('') + addTile;
}

function platformCard(p, conn) {
  const on = conn?.url;
  const initials = p.label.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const urlDisplay = on ? conn.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  var clickAttr = _viewMode ? '' : (on ? `onclick="openEditModal('${p.id}')"` : `onclick="openConnectModal('${p.id}')"`);
  return `
    <div class="platform-card${on ? ' pc-on' : ''}${_viewMode ? ' pc-view' : ''}" ${clickAttr}>
      <div class="pc-top">
        <span class="pc-icon">${escHtml(initials)}</span>
        <div class="pc-info">
          <div class="pc-name">${escHtml(p.label)}</div>
          <div class="pc-status"><span class="pc-dot${on ? ' pc-dot-on' : ''}"></span>${on ? 'Connected' : 'Not connected'}</div>
        </div>
      </div>
      ${on ? `<div class="pc-url">${escHtml(urlDisplay)}</div>
              <div class="pc-links" onclick="event.stopPropagation()">
                <a class="btn pc-visit" href="${safeUrl(conn.url)}" target="_blank" rel="noopener noreferrer">Visit ↗</a>
              </div>` : ''}
    </div>`;
}

function customCard(id, conn) {
  const label = conn.label || 'Custom';
  const initials = label.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const urlDisplay = conn.url ? conn.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  return `
    <div class="platform-card pc-on${_viewMode ? ' pc-view' : ''}" ${_viewMode ? '' : `onclick="openEditModal('${escHtml(id)}')"`}>
      <div class="pc-top">
        <span class="pc-icon">${escHtml(initials)}</span>
        <div class="pc-info">
          <div class="pc-name">${escHtml(label)}</div>
          <div class="pc-status"><span class="pc-dot pc-dot-on"></span>Connected</div>
        </div>
      </div>
      ${conn.url ? `<div class="pc-url">${escHtml(urlDisplay)}</div>
                    <div class="pc-links" onclick="event.stopPropagation()">
                      <a class="btn pc-visit" href="${safeUrl(conn.url)}" target="_blank" rel="noopener noreferrer">Visit ↗</a>
                    </div>` : ''}
    </div>`;
}

function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : '#';
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openConnectModal(platformId) {
  const p = PLATFORMS.find(x => x.id === platformId);
  if (!p) return;
  _editingId = platformId;
  document.getElementById('pm-title').textContent     = `Connect ${p.label}`;
  document.getElementById('pm-label-row').style.display = 'none';
  document.getElementById('pm-label').value           = p.label;
  document.getElementById('pm-url').value             = '';
  document.getElementById('pm-url').placeholder       = p.urlHint;
  document.getElementById('pm-note').value            = '';
  document.getElementById('pm-disconnect').style.display = 'none';
  setStatus('pm-status', '');
  openModal('platform-modal');
  setTimeout(() => document.getElementById('pm-url').focus(), 50);
}

function openEditModal(platformId) {
  const conn = _platforms()[platformId];
  if (!conn) return;
  _editingId = platformId;
  const p = PLATFORMS.find(x => x.id === platformId);
  const isCustom = platformId.startsWith('custom_');
  document.getElementById('pm-title').textContent       = `Edit ${p ? p.label : (conn.label || 'platform')}`;
  document.getElementById('pm-label-row').style.display = isCustom ? '' : 'none';
  document.getElementById('pm-label').value             = conn.label || (p?.label || '');
  document.getElementById('pm-url').value               = conn.url  || '';
  document.getElementById('pm-url').placeholder         = p?.urlHint || 'https://…';
  document.getElementById('pm-note').value              = conn.note || '';
  document.getElementById('pm-disconnect').style.display = '';
  setStatus('pm-status', '');
  openModal('platform-modal');
  setTimeout(() => document.getElementById('pm-url').focus(), 50);
}

function openAddModal() {
  _editingId = null;
  document.getElementById('pm-title').textContent       = 'Add platform';
  document.getElementById('pm-label-row').style.display = '';
  document.getElementById('pm-label').value             = '';
  document.getElementById('pm-url').value               = '';
  document.getElementById('pm-url').placeholder         = 'https://…';
  document.getElementById('pm-note').value              = '';
  document.getElementById('pm-disconnect').style.display = 'none';
  setStatus('pm-status', '');
  openModal('platform-modal');
  setTimeout(() => document.getElementById('pm-label').focus(), 50);
}

function closePlatformModal() { closeModal('platform-modal'); }

async function savePlatform() {
  const url   = document.getElementById('pm-url').value.trim();
  const label = document.getElementById('pm-label').value.trim();
  const note  = document.getElementById('pm-note').value.trim() || undefined;

  if (!url) { setStatus('pm-status', 'URL is required', true); return; }

  const platforms = { ..._platforms() };

  if (_editingId === null) {
    if (!label) { setStatus('pm-status', 'Name is required', true); return; }
    platforms[`custom_${Date.now()}`] = { url, label, note };
  } else {
    const isCustom = _editingId.startsWith('custom_');
    const entry = { url, note };
    if (isCustom) entry.label = label || platforms[_editingId]?.label || 'Custom';
    platforms[_editingId] = entry;
  }

  setStatus('pm-status', 'Saving…');
  const r = await apiFetch('/api/config', 'PATCH', { config: { platforms } });
  if (!r.ok) { const j = await r.json(); setStatus('pm-status', j.error || 'Error', true); return; }

  if (!_cfg.config) _cfg.config = {};
  _cfg.config.platforms = platforms;
  invalidateConfigCache();
  closePlatformModal();
  renderHub();
}

async function disconnectPlatform() {
  if (!_editingId) return;
  const platforms = { ..._platforms() };
  delete platforms[_editingId];

  setStatus('pm-status', 'Saving…');
  const r = await apiFetch('/api/config', 'PATCH', { config: { platforms } });
  if (!r.ok) { const j = await r.json(); setStatus('pm-status', j.error || 'Error', true); return; }

  if (!_cfg.config) _cfg.config = {};
  _cfg.config.platforms = platforms;
  invalidateConfigCache();
  closePlatformModal();
  renderHub();
}

// ── Arrangement config ────────────────────────────────────────────────────

function _arrCfg() {
  return _cfg && _cfg.config && _cfg.config.arrangementConfig
    ? _cfg.config.arrangementConfig
    : { members: [], instruments: [] };
}

function renderArrangementConfig() {
  var cfg = _arrCfg();
  renderArrMembers(cfg.members || []);
  renderArrInstruments(cfg.instruments || []);
  var sec = document.getElementById('hub-arrangement');
  if (sec) sec.style.display = '';
}

function renderArrMembers(members) {
  var list = document.getElementById('arr-members-list');
  if (!list) return;
  list.innerHTML = members.map(function(m, i) {
    return '<div class="arr-member-row">' +
      '<input class="arr-cfg-input" type="text" value="' + escHtml(m.name || '') + '" placeholder="Name" oninput="arrMemberChange(' + i + ',\'name\',this.value)">' +
      '<input class="arr-cfg-input arr-cfg-abbr" type="text" value="' + escHtml(m.abbr || '') + '" placeholder="Abbr" maxlength="4" title="Abbreviation shown in harmony chips" oninput="arrMemberChange(' + i + ',\'abbr\',this.value)">' +
      '<button class="arr-cfg-remove" onclick="arrRemoveMember(' + i + ')" title="Remove">&#215;</button>' +
    '</div>';
  }).join('');
}

function renderArrInstruments(instruments) {
  var list = document.getElementById('arr-instruments-list');
  if (!list) return;
  list.innerHTML = instruments.map(function(inst, i) {
    var chips = (inst.techniques || []).map(function(t, ti) {
      return '<span class="arr-tech-chip">' + escHtml(t) +
        '<button onclick="arrRemoveTechnique(' + i + ',' + ti + ')" title="Remove">&#215;</button></span>';
    }).join('');
    return '<div class="arr-instrument-card">' +
      '<div class="arr-instrument-hdr">' +
        '<input class="arr-instrument-key" type="text" value="' + escHtml(inst.key || '') + '" placeholder="Key (e.g. BANJO)" oninput="arrInstChange(' + i + ',\'key\',this.value)">' +
        '<input class="arr-instrument-label" type="text" value="' + escHtml(inst.label || '') + '" placeholder="Label (e.g. Banjo)" oninput="arrInstChange(' + i + ',\'label\',this.value)">' +
        '<button class="arr-cfg-remove" onclick="arrRemoveInstrument(' + i + ')" title="Remove">&#215;</button>' +
      '</div>' +
      '<div class="arr-techniques">' + chips +
        '<input class="arr-tech-add" placeholder="+ technique" onkeydown="arrTechKeydown(event,' + i + ')">' +
      '</div>' +
    '</div>';
  }).join('');
}

function arrMemberChange(i, field, value) {
  var cfg = _arrCfg();
  if (cfg.members[i]) cfg.members[i][field] = value;
  if (_cfg.config) _cfg.config.arrangementConfig = cfg;
}

function arrInstChange(i, field, value) {
  var cfg = _arrCfg();
  if (cfg.instruments[i]) cfg.instruments[i][field] = value;
  if (_cfg.config) _cfg.config.arrangementConfig = cfg;
}

function arrAddMember() {
  var cfg = _arrCfg();
  cfg.members.push({ name: '', abbr: '' });
  if (_cfg.config) _cfg.config.arrangementConfig = cfg;
  renderArrMembers(cfg.members);
}

function arrRemoveMember(i) {
  var cfg = _arrCfg();
  cfg.members.splice(i, 1);
  if (_cfg.config) _cfg.config.arrangementConfig = cfg;
  renderArrMembers(cfg.members);
}

function arrAddInstrument() {
  var cfg = _arrCfg();
  cfg.instruments.push({ key: '', label: '', techniques: [] });
  if (_cfg.config) _cfg.config.arrangementConfig = cfg;
  renderArrInstruments(cfg.instruments);
}

function arrRemoveInstrument(i) {
  var cfg = _arrCfg();
  var inst = cfg.instruments[i];
  if (!inst) return;
  if (inst.key) {
    if (!confirm('Remove instrument "' + inst.key + '"?\nExisting arrangement data for this instrument will still display in saved versions.')) return;
  }
  cfg.instruments.splice(i, 1);
  if (_cfg.config) _cfg.config.arrangementConfig = cfg;
  renderArrInstruments(cfg.instruments);
}

function arrRemoveTechnique(instIdx, techIdx) {
  var cfg = _arrCfg();
  if (cfg.instruments[instIdx]) {
    cfg.instruments[instIdx].techniques.splice(techIdx, 1);
    if (_cfg.config) _cfg.config.arrangementConfig = cfg;
    renderArrInstruments(cfg.instruments);
  }
}

function arrTechKeydown(e, instIdx) {
  if (e.key !== 'Enter' && e.key !== ',') return;
  e.preventDefault();
  var val = e.target.value.trim().toUpperCase();
  if (!val) return;
  var cfg = _arrCfg();
  if (!cfg.instruments[instIdx]) return;
  cfg.instruments[instIdx].techniques.push(val);
  if (_cfg.config) _cfg.config.arrangementConfig = cfg;
  renderArrInstruments(cfg.instruments);
}

async function saveArrangementConfig() {
  var cfg = _arrCfg();
  setStatus('arr-cfg-status', 'Saving…');
  var r = await apiFetch('/api/config', 'PATCH', { config: { arrangementConfig: cfg } });
  var json = await r.json();
  if (!r.ok) { setStatus('arr-cfg-status', json.error || 'Error', true); return; }
  if (!_cfg.config) _cfg.config = {};
  _cfg.config.arrangementConfig = cfg;
  invalidateConfigCache();
  setStatus('arr-cfg-status', 'Saved.');
  setTimeout(function() { setStatus('arr-cfg-status', ''); }, 2000);
}
