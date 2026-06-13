var _settingsSlug    = '';
var _currentUserId = null;

window.onNavAuthEmpty = function() { goToLogin(); };

initPage(function(cfg) {
  if (requireLogin()) return;
  var _role = getAuthRole();
  if (_role !== null && _role !== 'admin') { navigate('/dashboard'); return; }
  _settingsSlug = cfg.slug;
  try {
    var tok = getToken();
    if (tok) {
      var b64 = tok.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var outer = JSON.parse(atob(b64));
      if (outer.payload) _currentUserId = JSON.parse(outer.payload).userId || null;
    }
  } catch {}
  document.getElementById('settings-loading').style.display = 'none';
  document.getElementById('settings-content').style.display = '';
  renderWorkspace(cfg);
  loadUsers();
});

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
    const r = await apiFetch('/api/' + _settingsSlug + '/auth');
    if (!r.ok) { _usersStatus('Access denied.', true); return; }
    const { users } = await r.json();
    _allUsers = users;
    _settingsUsers = users.filter(function(u) { return u.accepted; });
    _renderArrMembersIfReady();
    _renderUsers(users);
  } catch (e) {
    if (String(e.message).includes('Session')) return;
    _usersStatus('Failed to load users.', true);
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
    activeEl.innerHTML = '<p class="empty-users">No active users yet.</p>';
  } else {
    activeEl.innerHTML =
      '<div class="user-row header"><span>Email</span><span>Status</span><span>Role</span><span></span></div>' +
      active.map(function(u) {
        var isMe     = u.id === _currentUserId;
        var roleCell = isMe
          ? '<span style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--third-color)">' + escHtml(u.role) + '</span>'
          : '<select class="role-select-inline" onchange="_changeRole(' + u.id + ',this.value)">' +
              ['admin', 'member', 'viewer'].map(function(r) {
                return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + r + '</option>';
              }).join('') +
            '</select>';
        var editBtn = '<button class="user-action-btn" onclick="_editEmail(' + u.id + ')">Edit email</button>';
        var actionCell = isMe
          ? '<span style="display:flex;gap:0.35rem">' + editBtn + '</span>'
          : '<span style="display:flex;gap:0.35rem">' + editBtn +
            '<button class="user-action-btn danger" onclick="_removeUser(' + u.id + ')">Remove</button></span>';
        return '<div class="user-row">' +
          '<span class="user-email">' + escHtml(u.email) +
            (isMe ? '<span class="you-badge">you</span>' : '') +
          '</span>' +
          '<span class="status-badge status-active">active</span>' +
          roleCell + actionCell +
        '</div>';
      }).join('');
  }

  var pendingRows = pending.map(function(u) {
    var sentDate = u.invite_expires_at
      ? new Date(new Date(u.invite_expires_at).getTime() - 7 * 24 * 60 * 60 * 1000)
          .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';
    return '<div class="user-row">' +
      '<span class="user-email">' + escHtml(u.email) + '</span>' +
      '<span class="status-badge status-pending">invite sent</span>' +
      '<span style="font-size:0.72rem;color:var(--third-color)">' + escHtml(sentDate) + '</span>' +
      '<span style="display:flex;gap:0.35rem">' +
        '<button class="user-action-btn" onclick="_resendInvite(' + u.id + ')">Resend</button>' +
        '<button class="user-action-btn danger" onclick="_revokeInvite(' + u.id + ')">Revoke</button>' +
      '</span>' +
    '</div>';
  });

  var expiredRows = expired.map(function(u) {
    return '<div class="user-row">' +
      '<span class="user-email">' + escHtml(u.email) + '</span>' +
      '<span class="status-badge" style="background:#f3ede4;color:var(--third-color)">expired</span>' +
      '<span style="font-size:0.72rem;color:var(--third-color)">' + escHtml(u.role) + '</span>' +
      '<button class="user-action-btn danger" onclick="_revokeInvite(' + u.id + ')">Remove</button>' +
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
  if (!email) { _usersStatus('Enter an email address.', true); return; }
  var btn = document.getElementById('invite-btn');
  btn.disabled = true; btn.textContent = '…'; _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/auth?action=invite', 'POST', { email, role });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || 'Failed to send invite.', true); return; }
    _usersStatus('Invite sent to ' + email + '.');
    document.getElementById('invite-email').value = '';
    loadUsers();
  } catch (e) {
    if (!String(e.message).includes('Session')) _usersStatus('Connection error.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Send invite';
  }
}

async function _changeRole(userId, role) {
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/auth', 'PUT', { userId, role });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || 'Failed to update role.', true); loadUsers(); }
  } catch {}
}

async function _removeUser(userId) {
  var email = _userEmailById(userId);
  if (!confirm('Remove ' + email + '? They will lose access immediately.')) return;
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/auth', 'DELETE', { userId });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || 'Failed to remove user.', true); return; }
    _usersStatus(email + ' removed.');
    loadUsers();
  } catch {}
}

async function _revokeInvite(userId) {
  var email = _userEmailById(userId);
  if (!confirm('Revoke invite for ' + email + '? The link will stop working immediately.')) return;
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/auth', 'DELETE', { userId });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || 'Failed to revoke invite.', true); return; }
    _usersStatus('Invite revoked.');
    loadUsers();
  } catch {}
}

async function _resendInvite(userId) {
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/auth?action=resend-invite', 'POST', { userId });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || 'Failed to resend invite.', true); return; }
    _usersStatus('Invite resent.');
  } catch {}
}

var _settingsUsers = [];   // active users, cached for the account-link dropdowns
var _allUsers = [];        // all users, cached for id→email lookup

function _userEmailById(userId) {
  var u = _allUsers.find(function(x) { return x.id === userId; });
  return u ? u.email : '';
}

async function _editEmail(userId) {
  var currentEmail = _userEmailById(userId);
  var next = prompt('New email for ' + currentEmail + ':', currentEmail);
  if (next === null) return;
  next = next.trim();
  if (!next || next === currentEmail) return;
  _usersStatus('');
  try {
    const r    = await apiFetch('/api/' + _settingsSlug + '/auth', 'PUT', { userId, email: next });
    const data = await r.json();
    if (!r.ok) { _usersStatus(data.error || 'Failed to update email.', true); return; }
    _usersStatus('Email updated to ' + data.user.email + '.');
    loadUsers();
  } catch {}
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
        'onclick="arrToggleMemberInstrument(' + i + ',' + j + ')">' +
        escHtml(inst.label || inst.key) + '</button>';
    }).join('');
    var accountOpts = '<option value="">— no account —</option>' + _settingsUsers.map(function(u) {
      var sel = m.userEmail === u.email ? ' selected' : '';
      return '<option value="' + escHtml(u.email) + '"' + sel + '>' + escHtml(u.email) + '</option>';
    }).join('');
    return '<div class="arr-member-card">' +
      '<div class="arr-member-row">' +
        '<input class="arr-cfg-input" type="text" value="' + escHtml(m.name || '') + '" placeholder="Name" oninput="arrMemberChange(' + i + ',\'name\',this.value)">' +
        '<input class="arr-cfg-input arr-cfg-abbr" type="text" value="' + escHtml(m.abbr || '') + '" placeholder="Abbr" maxlength="4" title="Abbreviation shown in harmony chips" oninput="arrMemberChange(' + i + ',\'abbr\',this.value)">' +
        '<button class="arr-cfg-remove" onclick="arrRemoveMember(' + i + ')" title="Remove">&#215;</button>' +
      '</div>' +
      '<div class="member-inst-row">' +
        (chips || '<span class="member-inst-empty">No instruments configured yet</span>') +
      '</div>' +
      '<div class="member-account-row">' +
        '<label>Account</label>' +
        '<select class="member-account-select" onchange="arrMemberChange(' + i + ',\'userEmail\',this.value || undefined)">' + accountOpts + '</select>' +
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
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
}

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
    if (!confirm('Remove instrument "' + inst.key + '"?\nExisting arrangement data for this instrument will still display in saved versions.')) return;
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

async function saveArrangementConfig() {
  var cfg = _arrCfg();
  var msg = document.getElementById('arr-save-msg');
  msg.textContent = 'Saving…'; msg.className = 'arr-save-msg';
  var ok = await patchConfig({ arrangementConfig: cfg });
  if (ok) {
    if (!_profileCfg.config) _profileCfg.config = {};
    _profileCfg.config.arrangementConfig = cfg;
    msg.textContent = 'Saved.'; msg.className = 'arr-save-msg ok';
  } else {
    msg.textContent = 'Save failed.'; msg.className = 'arr-save-msg err';
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

  // Privacy toggle
  var privToggle = document.getElementById('private-toggle');
  privToggle.checked  = !!(cfg.config && cfg.config.private);
  privToggle.disabled = false;
  privToggle.addEventListener('change', function () {
    var msg = document.getElementById('private-msg');
    msg.textContent = 'Saving…';
    msg.className = 'save-msg';
    fetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken(),
      },
      body: JSON.stringify({ config: { private: privToggle.checked } }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Failed to save');
        invalidateConfigCache();
        msg.textContent = privToggle.checked ? 'Workspace is now private.' : 'Workspace is now public.';
        setTimeout(function () { msg.textContent = ''; }, 2500);
      })
      .catch(function (err) {
        privToggle.checked = !privToggle.checked;
        msg.textContent = err.message || 'Failed to save.';
        msg.className = 'save-msg err';
      });
  });

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
    if (!name) { msg.textContent = 'Name required.'; msg.className = 'save-msg err'; return; }
    btn.disabled = true;
    msg.textContent = '';
    fetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken(),
      },
      body: JSON.stringify({ name: name }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (r) {
        if (r.ok) {
          msg.textContent = 'Saved.';
          msg.className = 'save-msg ok';
          invalidateConfigCache();
          applyNav(name, null);
        } else {
          msg.textContent = r.data.error || 'Error saving.';
          msg.className = 'save-msg err';
        }
        btn.disabled = false;
      })
      .catch(function () {
        msg.textContent = 'Network error.';
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
      document.getElementById('photo-progress').textContent = 'Please select an image file.';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      document.getElementById('photo-progress').textContent = 'Max file size is 5 MB.';
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
      document.getElementById('favicon-progress').textContent = 'Max file size is 512 KB.';
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
  progress.textContent = 'Getting upload URL…';
  fetch('/api/config?action=favicon-url&type=' + encodeURIComponent(file.type), {
    headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem(AUTH_TOKEN_KEY) },
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.uploadUrl) throw new Error(d.error || 'Failed to get upload URL');
      progress.textContent = 'Uploading…';
      return fetch(d.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      }).then(function (r) {
        if (!r.ok) throw new Error('Upload failed');
        return d.publicUrl;
      });
    })
    .then(function (publicUrl) {
      progress.textContent = 'Saving…';
      var versionedUrl = publicUrl + '?v=' + Date.now();
      return fetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getToken(),
        },
        body: JSON.stringify({ config: { faviconUrl: versionedUrl } }),
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, publicUrl: versionedUrl, data: d }; }); });
    })
    .then(function (r) {
      if (!r.ok) throw new Error(r.data.error || 'Failed to save');
      showFavicon(r.publicUrl);
      invalidateConfigCache();
      document.querySelectorAll('link[rel="icon"]').forEach(function(el) { el.href = r.publicUrl; });
      progress.textContent = 'Favicon updated.';
      setTimeout(function () { progress.textContent = ''; }, 2500);
    })
    .catch(function (err) {
      progress.textContent = err.message || 'Upload failed.';
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
  progress.textContent = 'Getting upload URL…';
  fetch('/api/config?action=photo-url&type=' + encodeURIComponent(file.type), {
    headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem(AUTH_TOKEN_KEY) },
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.uploadUrl) throw new Error(d.error || 'Failed to get upload URL');
      progress.textContent = 'Uploading…';
      return fetch(d.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      }).then(function (r) {
        if (!r.ok) throw new Error('Upload failed');
        return d.publicUrl;
      });
    })
    .then(function (publicUrl) {
      progress.textContent = 'Saving…';
      return fetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getToken(),
        },
        body: JSON.stringify({ config: { logoUrl: publicUrl } }),
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, publicUrl: publicUrl, data: d }; }); });
    })
    .then(function (r) {
      if (!r.ok) throw new Error(r.data.error || 'Failed to save');
      showPhoto(r.publicUrl);
      invalidateConfigCache();
      applyNav(document.getElementById('band-name-input').value || '', { logoUrl: r.publicUrl });
      progress.textContent = 'Photo updated.';
      setTimeout(function () { progress.textContent = ''; }, 2500);
    })
    .catch(function (err) {
      progress.textContent = err.message || 'Upload failed.';
    });
}

function renderFieldTags(id, fields) {
  var sec = document.getElementById(id + '-section');
  var tags = document.getElementById(id + '-tags');
  sec.style.display = '';
  tags.innerHTML = (fields && fields.length)
    ? fields.map(function (f) { return '<span class="config-tag">' + escHtml(f.label || f.field) + '</span>'; }).join('')
    : '<span style="font-size:0.78rem;color:var(--third-color);">None configured</span>';
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
      '<input class="lbl-input" type="text" value="' + escHtml(f.label) + '" placeholder="Label" style="width:80px;" data-field="' + escHtml(f.field) + '">' +
      _typeSelect(f.type || 'text') +
      '<button class="config-remove-btn" onclick="removeCustomDisplayField(\'' + escHtml(f.field) + '\')">×</button>' +
      '</div>';
  }).join('');

  document.getElementById('display-fields-tags').style.display = 'none';
  document.getElementById('display-fields-editor').style.display = '';
  document.getElementById('display-fields-editor').innerHTML =
    '<div style="margin-bottom:0.5rem;font-size:0.78rem;color:var(--third-color);">Standard fields</div>' +
    rows +
    '<div style="margin:0.75rem 0 0.4rem;font-size:0.78rem;color:var(--third-color);">Custom extra fields</div>' +
    '<div id="df-custom-list">' + customRows + '</div>' +
    '<div class="config-add-row">' +
      '<input type="text" id="df-new-field" placeholder="extra.myfield" style="width:130px;">' +
      '<input type="text" id="df-new-label" placeholder="Label" style="width:80px;">' +
      _typeSelect('text', 'df-new-type') +
      '<button class="btn" onclick="addCustomDisplayField()">Add</button>' +
    '</div>' +
    '<div class="config-editor-actions">' +
      '<button class="btn active" onclick="saveDisplayFields()">Save</button>' +
      '<button class="btn" onclick="closeDisplayFieldsEditor()">Cancel</button>' +
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
    '<input class="lbl-input" type="text" value="' + escHtml(label || field) + '" placeholder="Label" style="width:80px;" data-field="' + escHtml(field) + '">' +
    _typeSelect(type) +
    '<button class="config-remove-btn" onclick="removeCustomDisplayField(\'' + escHtml(field) + '\')">×</button>';
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

async function saveDisplayFields() {
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
  msg.textContent = 'Saving…'; msg.className = 'save-msg';
  var ok = await patchConfig({ displayFields: fields });
  if (ok) {
    if (_profileCfg) _profileCfg.config.displayFields = fields;
    renderFieldTags('display-fields', fields);
    closeDisplayFieldsEditor();
  } else {
    msg.textContent = 'Save failed.'; msg.className = 'save-msg err';
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
    alert('No fields configured yet. Set up song table columns first.');
    return;
  }

  var rows = available.map(function (f) {
    var checked = (f.field in currentMap) ? 'checked' : '';
    return '<div class="config-check-row">' +
      '<input type="checkbox" id="ff-' + f.field.replace('.', '-') + '" value="' + f.field + '" data-label="' + escHtml(f.label) + '" ' + checked + '>' +
      '<label for="ff-' + f.field.replace('.', '-') + '">' + escHtml(f.label) + '</label>' +
      '</div>';
  }).join('');

  document.getElementById('filter-fields-tags').style.display = 'none';
  document.getElementById('filter-fields-editor').style.display = '';
  document.getElementById('filter-fields-editor').innerHTML =
    rows +
    '<div class="config-editor-actions">' +
      '<button class="btn active" onclick="saveFilterFields()">Save</button>' +
      '<button class="btn" onclick="closeFilterFieldsEditor()">Cancel</button>' +
    '</div>' +
    '<div class="save-msg" id="ff-msg"></div>';
}

function closeFilterFieldsEditor() {
  document.getElementById('filter-fields-tags').style.display = '';
  document.getElementById('filter-fields-editor').style.display = 'none';
}

async function saveFilterFields() {
  var fields = [];
  document.getElementById('filter-fields-editor').querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
    if (cb.checked) fields.push({ field: cb.value, label: cb.dataset.label });
  });

  var msg = document.getElementById('ff-msg');
  msg.textContent = 'Saving…'; msg.className = 'save-msg';
  var ok = await patchConfig({ filterFields: fields });
  if (ok) {
    if (_profileCfg) _profileCfg.config.filterFields = fields;
    renderFieldTags('filter-fields', fields);
    closeFilterFieldsEditor();
  } else {
    msg.textContent = 'Save failed.'; msg.className = 'save-msg err';
  }
}

async function patchConfig(configUpdate) {
  try {
    var r = await fetch('/api/config?slug=' + encodeURIComponent(_settingsSlug), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken(),
      },
      body: JSON.stringify({ config: configUpdate }),
    });
    if (r.ok) invalidateConfigCache();
    return r.ok;
  } catch { return false; }
}
