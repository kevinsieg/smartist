var _artistSlug   = '';
var _currentUserId = null;

initPage(function(cfg) {
  _artistSlug = cfg.slug;
  // Decode current user id from stored token (so we can mark "you" row)
  try {
    var tok = getToken();
    if (tok) {
      var b64 = tok.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var outer = JSON.parse(atob(b64));
      if (outer.payload) _currentUserId = JSON.parse(outer.payload).userId || null;
    }
  } catch {}
  loadUsers();
});

async function loadUsers() {
  try {
    const r = await apiFetch('/api/' + _artistSlug + '/auth');
    if (!r.ok) { setStatus('users-status', 'Access denied.', true); return; }
    const { users } = await r.json();
    _renderUsers(users);
  } catch (e) {
    if (String(e.message).includes('Session')) return;
    setStatus('users-status', 'Failed to load users.', true);
  }
}

function _renderUsers(users) {
  var active  = users.filter(function(u) { return u.accepted; });
  var pending = users.filter(function(u) { return u.invite_pending; });

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
        var actionCell = isMe
          ? '<span style="display:inline-block;width:50px"></span>'
          : '<button class="user-action-btn danger" onclick="_removeUser(' + u.id + ',\'' + escHtml(u.email) + '\')">Remove</button>';
        return '<div class="user-row">' +
          '<span class="user-email">' + escHtml(u.email) +
            (isMe ? '<span class="you-badge">you</span>' : '') +
          '</span>' +
          '<span class="status-badge status-active">active</span>' +
          roleCell + actionCell +
          '</div>';
      }).join('');
  }

  if (pending.length) {
    pendingSection.style.display = '';
    pendingEl.innerHTML = pending.map(function(u) {
      return '<div class="user-row">' +
        '<span class="user-email">' + escHtml(u.email) + '</span>' +
        '<span class="status-badge status-pending">invite sent</span>' +
        '<span style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--third-color)">' + escHtml(u.role) + '</span>' +
        '<button class="user-action-btn" onclick="_resendInvite(' + u.id + ')">Resend</button>' +
        '</div>';
    }).join('');
  } else {
    pendingSection.style.display = 'none';
  }
}

async function sendInvite() {
  var email = document.getElementById('invite-email').value.trim();
  var role  = document.getElementById('invite-role').value;
  if (!email) { setStatus('users-status', 'Enter an email address.', true); return; }
  var btn = document.getElementById('invite-btn');
  btn.disabled = true; btn.textContent = '…'; setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth?action=invite', 'POST', { email, role });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to send invite.', true); return; }
    setStatus('users-status', 'Invite sent to ' + email + '.');
    document.getElementById('invite-email').value = '';
    loadUsers();
  } catch (e) {
    if (!String(e.message).includes('Session')) setStatus('users-status', 'Connection error.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Send invite';
  }
}

async function _changeRole(userId, role) {
  setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth', 'PUT', { userId, role });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to update role.', true); loadUsers(); }
  } catch {}
}

async function _removeUser(userId, email) {
  if (!confirm('Remove ' + email + '? They will lose access immediately.')) return;
  setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth', 'DELETE', { userId });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to remove user.', true); return; }
    setStatus('users-status', email + ' removed.');
    loadUsers();
  } catch {}
}

async function _resendInvite(userId) {
  setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth?action=resend-invite', 'POST', { userId });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to resend invite.', true); return; }
    setStatus('users-status', 'Invite resent.');
  } catch {}
}
