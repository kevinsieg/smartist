var _settingsSlug    = '';
var _currentUserId = null;

window.onNavAuthEmpty = function() { goToLogin(); };

initPage(function(cfg) {
  if (requireLogin()) return;
  if (getAuthRole() !== 'admin') { navigate('/dashboard'); return; }
  _settingsSlug = cfg.slug;
  _currentUserId = sessionUserId();
  document.getElementById('settings-loading').style.display = 'none';
  document.getElementById('settings-content').style.display = '';
  renderWorkspace(cfg);
  renderPlan(cfg);
  loadUsers();
});

function _roleLabel(role) {
  var map = { admin: t('settings.roleAdmin'), member: t('settings.roleMember'), viewer: t('settings.roleViewer') };
  return map[role] || escHtml(role);
}

// Local status helper — setStatus() applies .status-msg, which is display:none
// without a .success/.error class, so success feedback would be invisible.
function _usersStatus(msg, isError) {
  var el = document.getElementById('users-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'users-status' + (isError ? ' error' : '');
}

async function loadUsers() {
  try {
    const r = await apiFetch('/api/' + _settingsSlug + '/members');
    if (!r.ok) { _usersStatus(t('settings.accessDenied'), true); return; }
    const { users } = await r.json();
    _allUsers = users;
    _settingsUsers = users.filter(function(u) { return u.accepted; });
    _renderArrMembersIfReady();
    _renderUsers(users);
  } catch (e) {
    if (String(e.message).includes('Session')) return;
    _usersStatus(t('settings.failedToLoadUsers'), true);
  }
}

function _renderUsers(users) {
  var active   = users.filter(function(u) { return u.accepted; });
  var pending  = users.filter(function(u) { return u.invite_pending; });
  var expired  = users.filter(function(u) { return u.invite_expired; });

  var activeEl       = document.getElementById('active-list');
  var pendingEl      = document.getElementById('pending-list');
  var pendingSection = document.getElementById('pending-section');

  if (!active.length) {
    activeEl.innerHTML = '<p class="empty-users">' + t('settings.noActiveUsers') + '</p>';
  } else {
    activeEl.innerHTML =
      '<div class="user-row header"><span>' + t('settings.colEmail') + '</span><span>' + t('settings.colStatus') + '</span><span>' + t('settings.colRole') + '</span><span></span></div>' +
      active.map(function(u) {
        var isMe     = u.id === _currentUserId;
        var roleCell = isMe
          ? '<span style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--third-color)">' + _roleLabel(u.role) + '</span>'
          : '<select class="role-select-inline" data-onchange="_changeRole(' + u.id + ',this.value)">' +
              ['admin', 'member', 'viewer'].map(function(r) {
                return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + _roleLabel(r) + '</option>';
              }).join('') +
            '</select>';
        var actionCell = isMe
          ? '<span></span>'
          : '<span style="display:flex;gap:0.35rem">' +
            '<button class="user-action-btn danger" data-onclick="_removeUser(' + u.id + ')">' + t('songs.remove') + '</button></span>';
        return '<div class="user-row">' +
          '<span class="user-email">' + escHtml(u.email) +
            (isMe ? '<span class="you-badge">' + t('settings.youBadge') + '</span>' : '') +
          '</span>' +
          '<span class="status-badge status-active">' + t('settings.statusActive') + '</span>' +
          roleCell + actionCell +
        '</div>';
      }).join('');
  }

  var pendingRows = pending.map(function(u) {
    var sentDate = u.invite_expires_at
      ? formatDate(new Date(new Date(u.invite_expires_at).getTime() - 7 * 24 * 60 * 60 * 1000), 'short')
      : '';
    return '<div class="user-row">' +
      '<span class="user-email">' + escHtml(u.email) + '</span>' +
      '<span class="status-badge status-pending">' + t('settings.statusInviteSent') + '</span>' +
      '<span style="font-size:0.72rem;color:var(--third-color)">' + escHtml(sentDate) + '</span>' +
      '<span style="display:flex;gap:0.35rem">' +
        '<button class="user-action-btn" data-onclick="_resendInvite(' + u.id + ')">' + t('settings.resendBtn') + '</button>' +
        '<button class="user-action-btn danger" data-onclick="_revokeInvite(' + u.id + ')">' + t('settings.revokeBtn') + '</button>' +
      '</span>' +
    '</div>';
  });

  var expiredRows = expired.map(function(u) {
    return '<div class="user-row">' +
      '<span class="user-email">' + escHtml(u.email) + '</span>' +
      '<span class="status-badge" style="background:#f3ede4;color:var(--third-color)">' + t('settings.statusExpired') + '</span>' +
      '<span style="font-size:0.72rem;color:var(--third-color)">' + _roleLabel(u.role) + '</span>' +
      '<button class="user-action-btn danger" data-onclick="_revokeInvite(' + u.id + ')">' + t('songs.remove') + '</button>' +
    '</div>';
  });

  var allPending = pendingRows.concat(expiredRows);
  if (allPending.length) {
    pendingSection.style.display = '';
    pendingEl.innerHTML = allPending.join('');
  } else {
    pendingSection.style.display = 'none';
  }
}

async function sendInvite() {
  var email = document.getElementById('invite-email').value.trim();
  var role  = document.getElementById('invite-role').value;
  if (!email) { _usersStatus(t('settings.enterEmail'), true); return; }
  var btn = document.getElementById('invite-btn');
  btn.disabled = true; btn.textContent = '…'; _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/members/invite', 'POST', { email, role });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || t('settings.failedToSendInvite'), true); return; }
    _usersStatus(t('settings.inviteSentTo', { email: email }));
    document.getElementById('invite-email').value = '';
    loadUsers();
  } catch (e) {
    if (!String(e.message).includes('Session')) _usersStatus(t('settings.connError'), true);
  } finally {
    btn.disabled = false; btn.textContent = t('settings.sendInviteBtn');
  }
}

async function _changeRole(userId, role) {
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/members', 'PUT', { userId, role });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || t('settings.failedToUpdateRole'), true); loadUsers(); }
  } catch {}
}

async function _removeUser(userId) {
  var email = _userEmailById(userId);
  if (!confirm(t('settings.confirmRemoveUser', { email: email }))) return;
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/members', 'DELETE', { userId });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || t('settings.failedToRemoveUser'), true); return; }
    _usersStatus(t('settings.userRemoved', { email: email }));
    loadUsers();
  } catch {}
}

async function _revokeInvite(userId) {
  var email = _userEmailById(userId);
  if (!confirm(t('settings.confirmRevokeInvite', { email: email }))) return;
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/members', 'DELETE', { userId });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || t('settings.failedToRevokeInvite'), true); return; }
    _usersStatus(t('settings.inviteRevoked'));
    loadUsers();
  } catch {}
}

async function _resendInvite(userId) {
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/members/resend-invite', 'POST', { userId });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || t('settings.failedToResendInvite'), true); return; }
    _usersStatus(t('settings.inviteResent'));
  } catch {}
}

var _settingsUsers = [];   // active users, cached for the account-link dropdowns
var _allUsers = [];        // all users, cached for id→email lookup

function _userEmailById(userId) {
  var u = _allUsers.find(function(x) { return x.id === userId; });
  return u ? u.email : '';
}

function _renderArrMembersIfReady() {
  if (_profileCfg) renderArrMembers(_arrCfg().members || []);
}

// ── Workspace config (ported from profile.html inline script) ─────────────────

var STANDARD_FIELDS = [
  { field: 'title',               label: 'Song',           required: true },
  { field: 'key',                 label: 'Key' },
  { field: 'genre',               label: 'Genre' },
  { field: 'tempo',               label: 'Tempo' },
  { field: 'length_min',          label: 'Length' },
  { field: 'interpret',           label: 'Interpret' },
  { field: 'reference_interpret', label: 'Ref. interpret' },
  { field: 'comment',             label: 'Comment' },
];

// Stored so editors can read current config without re-fetching
var _profileCfg = null;

function initials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
}

// ── Arrangement config ────────────────────────────────────────────────────

function _arrCfg() {
  return _profileCfg && _profileCfg.config && _profileCfg.config.arrangementConfig
    ? _profileCfg.config.arrangementConfig
    : { members: [], instruments: [] };
}

function renderArrMembers(members) {
  var list = document.getElementById('arr-members-list');
  if (!list) return;
  var instruments = (_arrCfg().instruments || []).filter(function(inst) { return inst.key; });
  list.innerHTML = members.map(function(m, i) {
    var chips = instruments.map(function(inst, j) {
      var on = (m.instruments || []).indexOf(inst.key) !== -1;
      return '<button type="button" class="member-inst-chip' + (on ? ' on' : '') + '" ' +
        'data-onclick="arrToggleMemberInstrument(' + i + ',' + j + ')">' +
        escHtml(inst.label || inst.key) + '</button>';
    }).join('');
    var accountOpts = '<option value="">' + t('settings.noAccount') + '</option>' + _settingsUsers.map(function(u) {
      var sel = m.userEmail === u.email ? ' selected' : '';
      return '<option value="' + escHtml(u.email) + '"' + sel + '>' + escHtml(u.email) + '</option>';
    }).join('');
    return '<div class="arr-member-card">' +
      '<div class="arr-member-row">' +
        '<input class="arr-cfg-input" type="text" value="' + escHtml(m.name || '') + '" placeholder="' + t('settings.memberNamePlaceholder') + '" data-oninput="arrMemberChange(' + i + ',\'name\',this.value)">' +
        '<input class="arr-cfg-input arr-cfg-abbr" type="text" value="' + escHtml(m.abbr || '') + '" placeholder="' + t('settings.memberAbbrPlaceholder') + '" maxlength="4" title="' + t('settings.memberAbbrTitle') + '" data-oninput="arrMemberChange(' + i + ',\'abbr\',this.value)">' +
        '<button class="arr-cfg-remove" data-onclick="arrRemoveMember(' + i + ')" title="' + t('songs.remove') + '">&#215;</button>' +
      '</div>' +
      '<div class="member-inst-row">' +
        (chips || '<span class="member-inst-empty">' + t('settings.noInstrumentsYet') + '</span>') +
      '</div>' +
      '<div class="member-account-row">' +
        '<label>' + t('settings.accountLabel') +
        ' <select class="member-account-select" data-onchange="arrMemberAccountChange(' + i + ',this.value)">' + accountOpts + '</select></label>' +
      '</div>' +
    '</div>';
  }).join('');
}

function arrToggleMemberInstrument(i, instIdx) {
  var cfg = _arrCfg();
  var m = cfg.members[i];
  if (!m) return;
  var instruments = (cfg.instruments || []).filter(function(inst) { return inst.key; });
  var inst = instruments[instIdx];
  if (!inst) return;
  m.instruments = m.instruments || [];
  var idx = m.instruments.indexOf(inst.key);
  if (idx === -1) m.instruments.push(inst.key); else m.instruments.splice(idx, 1);
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrMembers(cfg.members);
}

function renderArrInstruments(instruments) {
  var list = document.getElementById('arr-instruments-list');
  if (!list) return;
  list.innerHTML = instruments.map(function(inst, i) {
    var chips = (inst.techniques || []).map(function(_tech, ti) {
      return '<span class="arr-tech-chip">' + escHtml(_tech) +
        '<button data-onclick="arrRemoveTechnique(' + i + ',' + ti + ')" title="' + t('songs.remove') + '">&#215;</button></span>';
    }).join('');
    return '<div class="arr-instrument-card">' +
      '<div class="arr-instrument-hdr">' +
        '<input class="arr-instrument-key" type="text" value="' + escHtml(inst.key || '') + '" placeholder="' + t('settings.instKeyPlaceholder') + '" data-oninput="arrInstChange(' + i + ',\'key\',this.value)">' +
        '<input class="arr-instrument-label" type="text" value="' + escHtml(inst.label || '') + '" placeholder="' + t('settings.instLabelPlaceholder') + '" data-oninput="arrInstChange(' + i + ',\'label\',this.value)">' +
        '<button class="arr-cfg-remove" data-onclick="arrRemoveInstrument(' + i + ')" title="' + t('songs.remove') + '">&#215;</button>' +
      '</div>' +
      '<div class="arr-techniques">' + chips +
        '<input class="arr-tech-add" placeholder="' + t('settings.addTechniquePlaceholder') + '" data-onkeydown="arrTechKeydown(event,' + i + ')">' +
      '</div>' +
    '</div>';
  }).join('');
}

function arrMemberChange(i, field, value) {
  var cfg = _arrCfg();
  if (cfg.members[i]) cfg.members[i][field] = value;
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
}

// An empty choice unlinks the member from an account.
function arrMemberAccountChange(i, value) { arrMemberChange(i, 'userEmail', value || undefined); }

function arrInstChange(i, field, value) {
  var cfg = _arrCfg();
  if (cfg.instruments[i]) cfg.instruments[i][field] = value;
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrMembers(cfg.members || []);
}

function arrAddMember() {
  var cfg = _arrCfg();
  cfg.members.push({ name: '', abbr: '' });
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrMembers(cfg.members);
}

function arrRemoveMember(i) {
  var cfg = _arrCfg();
  cfg.members.splice(i, 1);
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrMembers(cfg.members);
}

function arrAddInstrument() {
  var cfg = _arrCfg();
  cfg.instruments.push({ key: '', label: '', techniques: [] });
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrInstruments(cfg.instruments);
  renderArrMembers(cfg.members || []);
}

function arrRemoveInstrument(i) {
  var cfg = _arrCfg();
  var inst = cfg.instruments[i];
  if (!inst) return;
  if (inst.key) {
    if (!confirm(t('settings.confirmRemoveInstrument', { key: inst.key }))) return;
  }
  cfg.instruments.splice(i, 1);
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrInstruments(cfg.instruments);
  renderArrMembers(cfg.members || []);
}

function arrRemoveTechnique(instIdx, techIdx) {
  var cfg = _arrCfg();
  if (!cfg.instruments[instIdx]) return;
  cfg.instruments[instIdx].techniques.splice(techIdx, 1);
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrInstruments(cfg.instruments);
}

function arrTechKeydown(e, instIdx) {
  if (e.key !== 'Enter' && e.key !== ',') return;
  e.preventDefault();
  var val = e.target.value.trim().toUpperCase();
  if (!val) return;
  var cfg = _arrCfg();
  if (!cfg.instruments[instIdx]) return;
  cfg.instruments[instIdx].techniques.push(val);
  e.target.value = '';
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrInstruments(cfg.instruments);
}

async function saveArrangementConfig(btn) {
  var cfg = _arrCfg();
  var msg = document.getElementById('arr-save-msg');
  msg.textContent = t('settings.saving'); msg.className = 'arr-save-msg';
  var ok = await withBusy(btn, () => patchConfig({ arrangementConfig: cfg }));
  if (ok === undefined) return;
  if (ok) {
    if (!_profileCfg.config) _profileCfg.config = {};
    _profileCfg.config.arrangementConfig = cfg;
    msg.textContent = t('settings.saved'); msg.className = 'arr-save-msg ok';
  } else {
    msg.textContent = t('settings.saveFailed'); msg.className = 'arr-save-msg err';
  }
  setTimeout(function() { msg.textContent = ''; msg.className = 'arr-save-msg'; }, 2500);
}

// ─────────────────────────────────────────────────────────────────────────────

function renderWorkspace(cfg) {
  _profileCfg = cfg;

  // Photo / monogram
  document.getElementById('photo-monogram').textContent = initials(cfg.name);
  if (cfg.config && cfg.config.logoUrl) {
    showPhoto(cfg.config.logoUrl);
  }

  // Name
  var nameInput = document.getElementById('band-name-input');
  nameInput.value = cfg.name || '';
  nameInput.disabled = false;
  document.getElementById('save-name-btn').disabled = false;

  // Slug
  document.getElementById('slug-value').textContent = cfg.slug;

  // Privacy toggles. Two settings, not one: publishing a song list used to
  // publish the gig schedule and the venue CRM with it.
  function _wirePrivacyToggle(id, msgId, key, onLabel, offLabel) {
    var toggle = document.getElementById(id);
    if (!toggle) return;
    // Both default to off — read each the way the server does (identity with
    // true), so the switch matches what is actually enforced.
    toggle.checked = (cfg.config || {})[key] === true;
    toggle.disabled = false;
    toggle.addEventListener('change', function () {
      var msg = document.getElementById(msgId);
      msg.textContent = t('settings.saving');
      msg.className = 'save-msg';
      var patch = {};
      patch[key] = toggle.checked;
      apiFetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), 'PATCH', { config: patch })
        .then(function (r) {
          if (!r.ok) throw new Error('');
          invalidateConfigCache();
          msg.textContent = toggle.checked ? t(onLabel) : t(offLabel);
          setTimeout(function () { msg.textContent = ''; }, 2500);
        })
        .catch(function (err) {
          toggle.checked = !toggle.checked;
          msg.textContent = err.message || t('settings.failedToSave');
          msg.className = 'save-msg err';
        });
    });
  }

  _wirePrivacyToggle('public-catalogue-toggle', 'public-catalogue-msg', 'publicCatalogue',
    'settings.catalogueNowPublic', 'settings.catalogueNowPrivate');
  _wirePrivacyToggle('public-stage-toggle', 'public-stage-msg', 'publicStage',
    'settings.stageNowPublic', 'settings.stageNowPrivate');

  _renderHiddenSongFields(cfg);

  renderFieldTags('display-fields', cfg.config && cfg.config.displayFields);
  renderFieldTags('filter-fields',  cfg.config && cfg.config.filterFields);

  var arrConfig = cfg.config && cfg.config.arrangementConfig || { members: [], instruments: [] };
  renderArrMembers(arrConfig.members || []);
  renderArrInstruments(arrConfig.instruments || []);

  // Name input hint
  nameInput.addEventListener('input', function () {
    document.getElementById('photo-monogram').textContent = initials(nameInput.value);
  });

  // Save name
  document.getElementById('save-name-btn').addEventListener('click', function () {
    var btn = this;
    var msg = document.getElementById('save-name-msg');
    var name = nameInput.value.trim();
    if (!name) { msg.textContent = t('settings.nameRequired'); msg.className = 'save-msg err'; return; }
    btn.disabled = true;
    msg.textContent = '';
    apiFetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), 'PATCH', { name: name })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (r) {
        if (r.ok) {
          msg.textContent = t('settings.saved');
          msg.className = 'save-msg ok';
          invalidateConfigCache();
          applyNav(name, null);
        } else {
          msg.textContent = r.data.error || t('settings.errorSaving');
          msg.className = 'save-msg err';
        }
        btn.disabled = false;
      })
      .catch(function () {
        msg.textContent = t('settings.networkError');
        msg.className = 'save-msg err';
        btn.disabled = false;
      });
  });

  // Photo upload
  var photoInput = document.getElementById('photo-input');
  var frame = document.getElementById('photo-frame');
  var hint = document.getElementById('photo-hint');
  frame.addEventListener('click', function () { photoInput.click(); });
  hint.addEventListener('click', function () { photoInput.click(); });

  photoInput.addEventListener('change', function () {
    var file = photoInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      document.getElementById('photo-progress').textContent = t('settings.selectImageFile');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      document.getElementById('photo-progress').textContent = t('settings.maxFileSizeMb', { mb: 5 });
      return;
    }
    uploadPhoto(file);
  });

  // Favicon upload
  if (cfg.config && cfg.config.faviconUrl) showFavicon(cfg.config.faviconUrl);
  var faviconInput = document.getElementById('favicon-input');
  document.getElementById('favicon-hint').addEventListener('click', function () { faviconInput.click(); });
  faviconInput.addEventListener('change', function () {
    var file = faviconInput.files[0];
    if (!file) return;
    if (file.size > 512 * 1024) {
      document.getElementById('favicon-progress').textContent = t('settings.maxFileSizeKb', { kb: 512 });
      return;
    }
    uploadFavicon(file);
  });
}

function showFavicon(url) {
  var img = document.getElementById('favicon-img');
  var empty = document.getElementById('favicon-empty-label');
  img.src = url;
  img.style.display = 'block';
  empty.style.display = 'none';
}

function uploadFavicon(file) {
  var progress = document.getElementById('favicon-progress');
  progress.textContent = t('settings.gettingUploadUrl');
  apiFetch('/api/config?action=favicon-url&slug=' + encodeURIComponent(_settingsSlug) + '&type=' + encodeURIComponent(file.type) + '&size=' + file.size)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.uploadUrl) throw new Error(d.error || t('settings.failedGetUploadUrl'));
      progress.textContent = t('settings.uploading');
      return fetch(d.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      }).then(function (r) {
        if (!r.ok) throw new Error(t('settings.uploadFailed'));
        return d.publicUrl;
      });
    })
    .then(function (publicUrl) {
      progress.textContent = t('settings.saving');
      var versionedUrl = publicUrl + '?v=' + Date.now();
      return apiFetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), 'PATCH', { config: { faviconUrl: versionedUrl } }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, publicUrl: versionedUrl, data: d }; }); });
    })
    .then(function (r) {
      if (!r.ok) throw new Error(r.data.error || '');
      showFavicon(r.publicUrl);
      invalidateConfigCache();
      document.querySelectorAll('link[rel="icon"]').forEach(function(el) { el.href = r.publicUrl; });
      progress.textContent = t('settings.faviconUpdated');
      setTimeout(function () { progress.textContent = ''; }, 2500);
    })
    .catch(function (err) {
      progress.textContent = err.message || t('settings.uploadFailed');
    });
}

function showPhoto(url) {
  var img = document.getElementById('photo-img');
  var mono = document.getElementById('photo-monogram');
  img.src = url;
  img.style.display = 'block';
  mono.style.display = 'none';
}

function uploadPhoto(file) {
  var progress = document.getElementById('photo-progress');
  progress.textContent = t('settings.gettingUploadUrl');
  apiFetch('/api/config?action=photo-url&slug=' + encodeURIComponent(_settingsSlug) + '&type=' + encodeURIComponent(file.type) + '&size=' + file.size)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.uploadUrl) throw new Error(d.error || t('settings.failedGetUploadUrl'));
      progress.textContent = t('settings.uploading');
      return fetch(d.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      }).then(function (r) {
        if (!r.ok) throw new Error(t('settings.uploadFailed'));
        return d.publicUrl;
      });
    })
    .then(function (publicUrl) {
      progress.textContent = t('settings.saving');
      return apiFetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), 'PATCH', { config: { logoUrl: publicUrl } }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, publicUrl: publicUrl, data: d }; }); });
    })
    .then(function (r) {
      if (!r.ok) throw new Error(r.data.error || '');
      showPhoto(r.publicUrl);
      invalidateConfigCache();
      applyNav(document.getElementById('band-name-input').value || '', { logoUrl: r.publicUrl });
      progress.textContent = t('settings.photoUpdated');
      setTimeout(function () { progress.textContent = ''; }, 2500);
    })
    .catch(function (err) {
      progress.textContent = err.message || t('settings.uploadFailed');
    });
}

function renderFieldTags(id, fields) {
  var sec = document.getElementById(id + '-section');
  var tags = document.getElementById(id + '-tags');
  sec.style.display = '';
  tags.innerHTML = (fields && fields.length)
    ? fields.map(function (f) { return '<span class="config-tag">' + escHtml(f.label || f.field) + '</span>'; }).join('')
    : '<span style="font-size:0.78rem;color:var(--third-color);">' + t('settings.noneConfigured') + '</span>';
}

function openDisplayFieldsEditor() {
  var cfg = _profileCfg;
  var current = (cfg && cfg.config && cfg.config.displayFields) || [];
  var currentMap = {};
  current.forEach(function (f) { currentMap[f.field] = f.label; });
  var customFields = current.filter(function (f) { return f.field.startsWith('extra.'); });

  var rows = STANDARD_FIELDS.map(function (f) {
    var checked = f.required || (f.field in currentMap) ? 'checked' : '';
    var disabled = f.required ? 'disabled' : '';
    var cls = f.required ? ' required' : '';
    return '<div class="config-check-row' + cls + '">' +
      '<input type="checkbox" id="df-' + f.field + '" value="' + f.field + '" ' + checked + ' ' + disabled + '>' +
      '<label for="df-' + f.field + '">' + escHtml(f.label) + '</label>' +
      '</div>';
  }).join('');

  var customRows = customFields.map(function (f, i) {
    return '<div class="config-custom-row" id="df-custom-' + i + '">' +
      '<input type="text" value="' + escHtml(f.field) + '" placeholder="extra.field" style="width:120px;" readonly>' +
      '<input class="lbl-input" type="text" value="' + escHtml(f.label) + '" placeholder="' + t('settings.labelPlaceholder') + '" style="width:80px;" data-field="' + escHtml(f.field) + '">' +
      _typeSelect(f.type || 'text') +
      '<button class="config-remove-btn" data-field="' + escHtml(f.field) + '" data-onclick="removeCustomDisplayField(this.dataset.field)">×</button>' +
      '</div>';
  }).join('');

  document.getElementById('display-fields-tags').style.display = 'none';
  document.getElementById('display-fields-editor').style.display = '';
  document.getElementById('display-fields-editor').innerHTML =
    '<div style="margin-bottom:0.5rem;font-size:0.78rem;color:var(--third-color);">' + t('settings.standardFields') + '</div>' +
    rows +
    '<div style="margin:0.75rem 0 0.4rem;font-size:0.78rem;color:var(--third-color);">' + t('settings.customExtraFields') + '</div>' +
    '<div id="df-custom-list">' + customRows + '</div>' +
    '<div class="config-add-row">' +
      '<input type="text" id="df-new-field" placeholder="extra.myfield" style="width:130px;">' +
      '<input type="text" id="df-new-label" placeholder="' + t('settings.labelPlaceholder') + '" style="width:80px;">' +
      _typeSelect('text', 'df-new-type') +
      '<button class="btn" data-onclick="addCustomDisplayField()">' + t('songs.add') + '</button>' +
    '</div>' +
    '<div class="config-editor-actions">' +
      '<button class="btn active" data-onclick="saveDisplayFields(this)">' + t('songs.save') + '</button>' +
      '<button class="btn" data-onclick="closeDisplayFieldsEditor()">' + t('songs.cancel') + '</button>' +
    '</div>' +
    '<div class="save-msg" id="df-msg"></div>';
}

function removeCustomDisplayField(field) {
  var list = document.getElementById('df-custom-list');
  var rows = list.querySelectorAll('.config-custom-row');
  rows.forEach(function (row) {
    var inp = row.querySelector('input[readonly]');
    if (inp && inp.value === field) row.remove();
  });
}

function _typeSelect(selected, id) {
  var idAttr = id ? ' id="' + id + '"' : '';
  return '<select class="type-select"' + idAttr + ' style="font-size:0.78rem;padding:0.25rem 0.3rem;border:1px solid #ddd;border-radius:3px;background:var(--bg-color);">' +
    ['text', 'integer', 'boolean'].map(function(t) {
      return '<option value="' + t + '"' + (t === selected ? ' selected' : '') + '>' + t + '</option>';
    }).join('') +
    '</select>';
}

function addCustomDisplayField() {
  var fieldInp = document.getElementById('df-new-field');
  var labelInp = document.getElementById('df-new-label');
  var typeEl   = document.getElementById('df-new-type');
  var field = fieldInp.value.trim();
  var label = labelInp.value.trim();
  var type  = typeEl ? typeEl.value : 'text';
  if (!field || !field.startsWith('extra.')) {
    fieldInp.style.borderColor = '#e55';
    setTimeout(function () { fieldInp.style.borderColor = ''; }, 1500);
    return;
  }
  var list = document.getElementById('df-custom-list');
  var div = document.createElement('div');
  div.className = 'config-custom-row';
  div.innerHTML =
    '<input type="text" value="' + escHtml(field) + '" style="width:120px;" readonly>' +
    '<input class="lbl-input" type="text" value="' + escHtml(label || field) + '" placeholder="' + t('settings.labelPlaceholder') + '" style="width:80px;" data-field="' + escHtml(field) + '">' +
    _typeSelect(type) +
    '<button class="config-remove-btn" data-field="' + escHtml(field) + '" data-onclick="removeCustomDisplayField(this.dataset.field)">×</button>';
  list.appendChild(div);
  fieldInp.value = '';
  labelInp.value = '';
  if (typeEl) typeEl.value = 'text';
  fieldInp.focus();
}

function closeDisplayFieldsEditor() {
  document.getElementById('display-fields-tags').style.display = '';
  document.getElementById('display-fields-editor').style.display = 'none';
}

async function saveDisplayFields(btn) {
  var fields = [];
  STANDARD_FIELDS.forEach(function (f) {
    var cb = document.getElementById('df-' + f.field);
    if (cb && cb.checked) fields.push({ field: f.field, label: f.label });
  });
  document.getElementById('df-custom-list').querySelectorAll('.config-custom-row').forEach(function (row) {
    var fieldVal = row.querySelector('input[readonly]').value.trim();
    var labelInp = row.querySelector('.lbl-input');
    var typeEl   = row.querySelector('.type-select');
    var labelVal = (labelInp ? labelInp.value.trim() : '') || fieldVal;
    var typeVal  = typeEl ? typeEl.value : 'text';
    if (fieldVal) fields.push({ field: fieldVal, label: labelVal, type: typeVal });
  });

  var msg = document.getElementById('df-msg');
  msg.textContent = t('settings.saving'); msg.className = 'save-msg';
  var ok = await withBusy(btn, () => patchConfig({ displayFields: fields }));
  if (ok === undefined) return;
  if (ok) {
    if (_profileCfg) _profileCfg.config.displayFields = fields;
    renderFieldTags('display-fields', fields);
    closeDisplayFieldsEditor();
  } else {
    msg.textContent = t('settings.saveFailed'); msg.className = 'save-msg err';
  }
}

function openFilterFieldsEditor() {
  var cfg = _profileCfg;
  var displayFields = (cfg && cfg.config && cfg.config.displayFields) || [];
  var currentFilter = (cfg && cfg.config && cfg.config.filterFields) || [];
  var currentMap = {};
  currentFilter.forEach(function (f) { currentMap[f.field] = true; });

  var available = displayFields.filter(function (f) { return f.field !== 'title'; });
  if (!available.length) {
    alert(t('settings.noFieldsConfigured'));
    return;
  }

  var rows = available.map(function (f) {
    var checked = (f.field in currentMap) ? 'checked' : '';
    return '<div class="config-check-row">' +
      '<input type="checkbox" id="' + escHtml('ff-' + f.field.replace('.', '-')) + '" value="' + escHtml(f.field) + '" data-label="' + escHtml(f.label) + '" ' + checked + '>' +
      '<label for="' + escHtml('ff-' + f.field.replace('.', '-')) + '">' + escHtml(f.label) + '</label>' +
      '</div>';
  }).join('');

  document.getElementById('filter-fields-tags').style.display = 'none';
  document.getElementById('filter-fields-editor').style.display = '';
  document.getElementById('filter-fields-editor').innerHTML =
    rows +
    '<div class="config-editor-actions">' +
      '<button class="btn active" data-onclick="saveFilterFields(this)">' + t('songs.save') + '</button>' +
      '<button class="btn" data-onclick="closeFilterFieldsEditor()">' + t('songs.cancel') + '</button>' +
    '</div>' +
    '<div class="save-msg" id="ff-msg"></div>';
}

function closeFilterFieldsEditor() {
  document.getElementById('filter-fields-tags').style.display = '';
  document.getElementById('filter-fields-editor').style.display = 'none';
}

async function saveFilterFields(btn) {
  var fields = [];
  document.getElementById('filter-fields-editor').querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
    if (cb.checked) fields.push({ field: cb.value, label: cb.dataset.label });
  });

  var msg = document.getElementById('ff-msg');
  msg.textContent = t('settings.saving'); msg.className = 'save-msg';
  var ok = await withBusy(btn, () => patchConfig({ filterFields: fields }));
  if (ok === undefined) return;
  if (ok) {
    if (_profileCfg) _profileCfg.config.filterFields = fields;
    renderFieldTags('filter-fields', fields);
    closeFilterFieldsEditor();
  } else {
    msg.textContent = t('settings.saveFailed'); msg.className = 'save-msg err';
  }
}

function renderPlan(cfg) {
  var p = cfg.plan, u = cfg.usage || {};
  document.getElementById('plan-label').textContent = p.label;
  var usedMB = ((u.storageUsedBytes || 0) / 1024 / 1024).toFixed(1);
  document.getElementById('plan-storage').textContent =
    p.limits.storageMB == null ? t('settings.plan.storageUnlimited', { used: usedMB })
                               : t('settings.plan.storage', { used: usedMB, limit: p.limits.storageMB });
  document.getElementById('plan-songs').textContent =
    p.limits.songs == null ? t('settings.plan.songsUnlimited', { used: (u.songs == null ? 0 : u.songs) })
                           : t('settings.plan.songs', { used: (u.songs == null ? 0 : u.songs), limit: p.limits.songs });
  var btn = document.getElementById('plan-toggle');
  var target = p.key === 'pro' ? 'free' : 'pro';
  btn.textContent = target === 'pro' ? t('settings.plan.upgrade') : t('settings.plan.downgrade');
  btn.onclick = async function () {
    btn.disabled = true;
    if (target === 'free') {
      try {
        var dr = await apiFetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), 'POST', { action: 'downgrade' });
        if (dr.ok) { invalidateConfigCache(); window.location.reload(); return; }
      } catch (e) {}
      btn.disabled = false;
      return;
    }
    // Upgrade goes through the swappable seam.
    try {
      var r = await apiFetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), 'POST', { action: 'upgrade' });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) { btn.disabled = false; return; }
      invalidateConfigCache();
      if (data.mode === 'checkout' && data.url) { window.location.href = data.url; return; }
      // self-serve: reflect Pro + reveal the donation prompt in place.
      document.getElementById('plan-label').textContent = 'Pro';
      btn.style.display = 'none';
      var donation = document.getElementById('plan-donation');
      var nLinks = renderSupportLinks(donation.querySelector('[data-support-links]'));
      if (nLinks > 0) donation.style.display = '';
      // Unlock Pro-only nav items without forcing a reload.
      try { var _fresh = await loadConfig(); applyPlanNavLocks((_fresh.plan && _fresh.plan.features) || []); } catch (e) {}
    } catch (e) {
      btn.disabled = false;
    }
  };
}

// Mirrors HIDEABLE_SONG_FIELDS in songs.js; read by songs, setlist, print and stage.
var _HIDEABLE_SONG_FIELDS = [
  { field: 'extra.lead',      label: 'songs.fieldLead' },
  { field: 'extra.gitCapo',   label: 'songs.fieldGitCapo' },
  { field: 'extra.banjoCapo', label: 'songs.fieldBanjoCapo' },
  { field: 'extra.git2',      label: 'songs.fieldGuitar2' },
  { field: 'extra.harp',      label: 'songs.fieldHarmonica' },
  { field: 'extra.aCapella',  label: 'songs.fieldACapella' },
  { field: 'tags',            label: 'songs.fieldTags' },
];

function _renderHiddenSongFields(cfg) {
  var box = document.getElementById('hidden-song-fields');
  if (!box) return;
  var hidden = hiddenSongFields(cfg.config);
  box.innerHTML = _HIDEABLE_SONG_FIELDS.map(function (f) {
    return '<label class="config-check-row"><input type="checkbox" class="auth-action" value="' + f.field + '"' +
      (hidden.indexOf(f.field) !== -1 ? ' checked' : '') + '> <span>' + escHtml(t(f.label)) + '</span></label>';
  }).join('');
  box.addEventListener('change', async function () {
    var fields = Array.from(box.querySelectorAll('input:checked')).map(function (el) { return el.value; });
    var msg = document.getElementById('hidden-song-fields-msg');
    msg.textContent = t('settings.saving'); msg.className = 'save-msg';
    if (await patchConfig({ hiddenSongFields: fields })) {
      if (_profileCfg) _profileCfg.config.hiddenSongFields = fields;
      msg.textContent = t('settings.saved');
      setTimeout(function () { msg.textContent = ''; }, 2500);
    } else {
      msg.textContent = t('settings.saveFailed'); msg.className = 'save-msg err';
    }
  });
}

async function patchConfig(configUpdate) {
  try {
    var r = await apiFetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), 'PATCH', { config: configUpdate });
    if (r.ok) invalidateConfigCache();
    return r.ok;
  } catch { return false; }
}
