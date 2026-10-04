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

function _platforms() { return _cfg?.config?.platforms || {}; }

// ── Boot ──────────────────────────────────────────────────────────────────────

window.onNavAuthEmpty = function() { goToLogin(); };
initPage(async function(cfg) {
  _cfg = cfg;
  renderHub();
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

  var addTile =
    `<div class="platform-card pc-add" data-onclick="openAddModal()">
       <div class="pc-top">
         <span class="pc-icon pc-icon-add" aria-hidden="true">+</span>
         <div class="pc-info">
           <button type="button" class="pc-name">${t('hub.addPlatform')}</button>
           <div class="pc-status">${t('hub.customIntegration')}</div>
         </div>
       </div>
     </div>`;
  el.innerHTML = customs.map(([id, c]) => customCard(id, c)).join('') + addTile;
}

function platformCard(p, conn) {
  const on = conn?.url;
  const initials = p.label.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const urlDisplay = on ? conn.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  var clickAttr = on ? `data-onclick="openEditModal('${p.id}')"` : `data-onclick="openConnectModal('${p.id}')"`;
  return `
    <div class="platform-card${on ? ' pc-on' : ''}" ${clickAttr}>
      <div class="pc-top">
        <span class="pc-icon">${escHtml(initials)}</span>
        <div class="pc-info">
          <button type="button" class="pc-name">${escHtml(p.label)}</button>
          <div class="pc-status"><span class="pc-dot${on ? ' pc-dot-on' : ''}"></span>${on ? t('hub.connected') : t('hub.notConnected')}</div>
        </div>
      </div>
      ${on ? `<div class="pc-url">${escHtml(urlDisplay)}</div>
              <div class="pc-links" data-onclick="event.stopPropagation()">
                <a class="btn pc-visit" href="${escHtml(safeUrl(conn.url))}" target="_blank" rel="noopener noreferrer">${t('hub.visitLink')}</a>
              </div>` : ''}
    </div>`;
}

function customCard(id, conn) {
  const label = conn.label || t('hub.customFallback');
  const initials = label.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const urlDisplay = conn.url ? conn.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  return `
    <div class="platform-card pc-on" data-id="${escHtml(id)}" data-onclick="openEditModal(this.dataset.id)">
      <div class="pc-top">
        <span class="pc-icon">${escHtml(initials)}</span>
        <div class="pc-info">
          <button type="button" class="pc-name">${escHtml(label)}</button>
          <div class="pc-status"><span class="pc-dot pc-dot-on"></span>${t('hub.connected')}</div>
        </div>
      </div>
      ${conn.url ? `<div class="pc-url">${escHtml(urlDisplay)}</div>
                    <div class="pc-links" data-onclick="event.stopPropagation()">
                      <a class="btn pc-visit" href="${escHtml(safeUrl(conn.url))}" target="_blank" rel="noopener noreferrer">${t('hub.visitLink')}</a>
                    </div>` : ''}
    </div>`;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openConnectModal(platformId) {
  const p = PLATFORMS.find(x => x.id === platformId);
  if (!p) return;
  _editingId = platformId;
  document.getElementById('pm-title').textContent     = t('hub.connectTitle', { label: p.label });
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
  document.getElementById('pm-title').textContent       = t('hub.editTitle', { label: p ? p.label : (conn.label || t('hub.platformFallback')) });
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
  document.getElementById('pm-title').textContent       = t('hub.addPlatform');
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

async function savePlatform(btn) {
  const url   = document.getElementById('pm-url').value.trim();
  const label = document.getElementById('pm-label').value.trim();
  const note  = document.getElementById('pm-note').value.trim() || undefined;

  if (!url) { setStatus('pm-status', t('hub.urlRequired'), true); return; }

  const platforms = { ..._platforms() };

  if (_editingId === null) {
    if (!label) { setStatus('pm-status', t('hub.nameRequired'), true); return; }
    platforms[`custom_${Date.now()}`] = { url, label, note };
  } else {
    const isCustom = _editingId.startsWith('custom_');
    const entry = { url, note };
    if (isCustom) entry.label = label || platforms[_editingId]?.label || t('hub.customFallback');
    platforms[_editingId] = entry;
  }

  setStatus('pm-status', '');
  const r = await withBusy(btn, () => apiFetch('/api/config', 'PATCH', { config: { platforms } }));
  if (!r) return;
  if (!r.ok) { const j = await r.json(); setStatus('pm-status', j.error || t('hub.errorFallback'), true); return; }

  if (!_cfg.config) _cfg.config = {};
  _cfg.config.platforms = platforms;
  invalidateConfigCache();
  closePlatformModal();
  renderHub();
}

async function disconnectPlatform(btn) {
  if (!_editingId) return;
  const platforms = { ..._platforms() };
  delete platforms[_editingId];

  setStatus('pm-status', '');
  const r = await withBusy(btn, () => apiFetch('/api/config', 'PATCH', { config: { platforms } }));
  if (!r) return;
  if (!r.ok) { const j = await r.json(); setStatus('pm-status', j.error || t('hub.errorFallback'), true); return; }

  if (!_cfg.config) _cfg.config = {};
  _cfg.config.platforms = platforms;
  invalidateConfigCache();
  closePlatformModal();
  renderHub();
}

