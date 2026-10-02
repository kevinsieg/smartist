(function () {
  var _slug = '';
  var _deletionEmail = '';

  window.onNavAuthEmpty = function() { goToLogin(); };

  // Runs before initPage(), not inside its callback. initPage() calls
  // isViewMode() first and redirects to /login the instant there is no valid
  // session (initPage in shell.js) — before the page callback, and so before any
  // code that only runs inside it, ever executes. The confirmation link is
  // designed to work with no session at all (it may be opened on a different
  // device than the one that requested it, or the original session may have
  // expired inside the 30-minute window) — so waiting for initPage to let us
  // in would drop the token exactly in the case this exists for. It would
  // also be dropped a second way: loginPageUrl() (session.js) builds
  // `next` from pathname+search only, never the hash, so even the bounce to
  // /login loses it for good.
  var _pendingDeleteToken = _peekDeleteToken();
  if (_pendingDeleteToken) {
    _startDeleteFlow(_pendingDeleteToken).then(function (tookOver) {
      // The confirmation panel stands on its own and must work with no session
      // at all, so the page must not bounce to /login behind it. Anything else
      // (a dead link, a blocker, a network blip) falls through to the normal
      // page, which still gates on requireLogin() as before.
      if (!tookOver) initPage(_onReady);
    });
  } else {
    initPage(_onReady);
  }

  async function _onReady(cfg) {
    if (requireLogin()) return;
    _slug = cfg.slug;
    document.getElementById('profile-email').textContent =
      sessionStorage.getItem('smartist_admin_email') || '—';

    // The demo session has no users row → no personal password, email or deletion.
    var noAccount = sessionUserId() === null;
    document.getElementById(noAccount ? 'demo-note' : 'password-section').style.display = '';
    if (noAccount) return;

    document.getElementById('pw-save-btn').addEventListener('click', changePassword);

    // Reached only past the early return above, so sessions without a users
    // row never see this — matching the server, which rejects them.
    document.getElementById('email-section').style.display = '';
    document.getElementById('em-save-btn').addEventListener('click', requestEmailChange);

    document.getElementById('sessions-section').style.display = '';
    document.getElementById('logout-all-btn').addEventListener('click', logoutEverywhere);

    // Same reasoning: deletion acts on a users row.
    document.getElementById('delete-account-btn').addEventListener('click', _requestDeletion);
    _loadDeletionZone();
  }

  async function changePassword() {
    var cur = document.getElementById('pw-current').value;
    var nw  = document.getElementById('pw-new').value;
    var cf  = document.getElementById('pw-confirm').value;
    var msg = document.getElementById('pw-msg');
    msg.className = 'save-msg';
    if (!cur || !nw || !cf) { msg.textContent = t('profile.fillAll');     msg.className = 'save-msg err'; return; }
    if (nw.length < 8)      { msg.textContent = t('profile.minChars');    msg.className = 'save-msg err'; return; }
    if (nw !== cf)          { msg.textContent = t('profile.pwMismatch');  msg.className = 'save-msg err'; return; }
    var btn = document.getElementById('pw-save-btn');
    btn.disabled = true; msg.textContent = t('profile.saving');
    try {
      var r = await apiFetch('/api/' + _slug + '/members/change-password', 'POST',
        { currentPassword: cur, newPassword: nw, rememberMe: !!localStorage.getItem(AUTH_TOKEN_KEY) });
      var data = await r.json();
      if (!r.ok) { msg.textContent = data.error || t('profile.failed'); msg.className = 'save-msg err'; return; }
      // The new password revokes every earlier session, this one included; the
      // response carries its replacement. Keep it in the store the old one was in.
      if (data.token) {
        if (localStorage.getItem(AUTH_TOKEN_KEY)) localStorage.setItem(AUTH_TOKEN_KEY, data.token);
        else sessionStorage.setItem(AUTH_TOKEN_KEY, data.token);
      }
      msg.textContent = t('profile.changed'); msg.className = 'save-msg ok';
      document.getElementById('pw-current').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-confirm').value = '';
    } catch (e) {
      if (!String(e.message).includes('Session')) { msg.textContent = t('profile.connError'); msg.className = 'save-msg err'; }
    } finally { btn.disabled = false; }
  }

  async function requestEmailChange() {
    var cur = document.getElementById('em-current').value;
    var nw  = document.getElementById('em-new').value.trim();
    var msg = document.getElementById('em-msg');
    msg.className = 'save-msg';
    if (!cur || !nw) { msg.textContent = t('profile.fillAll'); msg.className = 'save-msg err'; return; }
    var btn = document.getElementById('em-save-btn');
    btn.disabled = true; msg.textContent = t('profile.saving');
    try {
      var r = await apiFetch('/api/' + _slug + '/members/request-email-change', 'POST',
        { currentPassword: cur, newEmail: nw });
      var data = await r.json();
      if (!r.ok) { msg.textContent = data.error || t('profile.failed'); msg.className = 'save-msg err'; return; }
      msg.textContent = t('profile.emailLinkSent'); msg.className = 'save-msg ok';
      document.getElementById('em-current').value = '';
      document.getElementById('em-new').value = '';
    } catch (e) {
      if (!String(e.message).includes('Session')) { msg.textContent = t('profile.connError'); msg.className = 'save-msg err'; }
    } finally { btn.disabled = false; }
  }

  // Ends every session of this address, this one included, then leaves the
  // page the way the menu's logout does.
  async function logoutEverywhere() {
    var btn = document.getElementById('logout-all-btn');
    var msg = document.getElementById('logout-all-msg');
    btn.disabled = true; msg.className = 'save-msg'; msg.textContent = '';
    try {
      var r = await apiFetch('/api/config', 'POST', { action: 'logout-everywhere' });
      if (!r.ok) { msg.textContent = t('profile.logoutEverywhereFailed'); msg.className = 'save-msg err'; return; }
      doLogout();
    } catch (e) {
      if (!String(e.message).includes('Session')) { msg.textContent = t('profile.connError'); msg.className = 'save-msg err'; }
    } finally { btn.disabled = false; }
  }

  // ── Account deletion ────────────────────────────────────────────────────

  // Reads delete-token=<raw> out of the URL hash without touching it — the
  // fragment must survive a network blip or an unexpected response so a
  // reload can retry with the same token. Returns null when there is none.
  function _peekDeleteToken() {
    var m = /(?:^|[#&])delete-token=([^&]+)/.exec(window.location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function _clearDeleteTokenFromUrl() {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // initPage() never runs on the emailed-link paths, so nothing else re-applies
  // translations to the markup they reveal. applyTranslations is idempotent.
  function _retranslate() {
    if (window.i18n && window.i18n.applyTranslations) window.i18n.applyTranslations(document);
  }

  // Phase 1 of the emailed link: ask what the link would destroy and show it.
  // Read-only on purpose — landing on a URL is not a gesture. The fragment is
  // deliberately kept on a retryable failure, so this page is re-entered by the
  // Back button, a restored tab, any history revisit, and by mail scanners that
  // execute JS; if the load itself deleted, every one of those would destroy an
  // account nobody clicked on. Nothing is deleted until _confirmAccountDeletion
  // below, which only a click reaches. Same two-phase shape as
  // confirm-email-change (api/_band/members.js).
  //
  // No session required — the token authenticates it — so this uses apiFetch
  // only to keep the guard happy, not because a token is needed. Runs before
  // initPage(), so — unlike every other t() call on this page — it cannot rely
  // on initPage having already awaited the dictionary. Returns true when this
  // flow has taken the page over and initPage must not run.
  async function _startDeleteFlow(token) {
    if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }
    var banner = document.getElementById('delete-result-banner');
    banner.style.display = '';
    banner.className = 'auth-banner';
    banner.textContent = t('profile.dangerChecking');
    try {
      var r = await apiFetch('/api/config', 'POST', { action: 'confirm-deletion', token: token });
      var data = await r.json().catch(function () { return {}; });
      if (r.ok && data.preview) {
        banner.style.display = 'none';
        _showDeleteConfirmPanel(token, data);
        return true;
      }
      if (r.status === 409 && data.blocked && data.blocked.length) {
        // Nothing was consumed — the same link still works once the block is
        // resolved. Leave it in the URL.
        banner.textContent = t('profile.dangerBlocked') + ' ' +
          data.blocked.map(function (a) { return a.name; }).join(', ');
        return false;
      }
      if (r.status === 400) {
        // Definitive: invalid, expired, already used, or the account is gone
        // — this token will never work again, so nothing is lost by clearing it.
        _clearDeleteTokenFromUrl();
        banner.textContent = t('profile.dangerFailed');
        return false;
      }
      // Anything else (429, 5xx, a malformed response) is a transport failure,
      // not a verdict on the link — say so honestly and keep the token.
      banner.textContent = t('profile.connError');
      return false;
    } catch (e) {
      banner.textContent = t('profile.connError');
      return false;
    }
  }

  function _showDeleteConfirmPanel(token, plan) {
    _fillDangerList('dc-destroy', 'dc-destroy-list', plan.destroy, false);
    _fillDangerList('dc-leave',   'dc-leave-list',   plan.leave,   false);
    document.getElementById('delete-confirm-panel').style.display = '';
    document.getElementById('dc-confirm-btn')
      .addEventListener('click', function () { _confirmAccountDeletion(token); });
    _retranslate();
  }

  // Phase 2 — the irreversible one. Only ever reached from a click on the
  // button revealed above.
  async function _confirmAccountDeletion(token) {
    var btn = document.getElementById('dc-confirm-btn');
    var msg = document.getElementById('dc-msg');
    btn.disabled = true;
    msg.className = 'save-msg';
    msg.textContent = t('profile.dangerConfirm');
    try {
      var r = await apiFetch('/api/config', 'POST',
        { action: 'confirm-deletion', token: token, confirm: true });
      var data = await r.json().catch(function () { return {}; });
      if (r.ok) {
        clearToken();
        // replace, not assign: Back must not return to a spent link.
        var loc = (window.i18n && window.i18n.getLocale && window.i18n.getLocale()) || 'en';
        window.location.replace('https://smartist.studio' + (loc === 'en' ? '' : '/' + loc) + '/goodbye');
        return;
      }
      if (r.status === 400) {
        // Definitive: invalid, expired, already used, or the account is gone.
        _clearDeleteTokenFromUrl();
        msg.textContent = t('profile.dangerFailed');
        msg.className = 'save-msg err';
        return; // stays disabled — the link is spent
      }
      // 409 (a blocker appeared since the preview), 429, 5xx: none of these
      // consumed the token, so keep it and let them try again.
      msg.textContent = (r.status === 409 && data.blocked && data.blocked.length)
        ? t('profile.dangerBlocked') + ' ' + data.blocked.map(function (a) { return a.name; }).join(', ')
        : (data.error || t('profile.connError'));
      msg.className = 'save-msg err';
      btn.disabled = false;
    } catch (e) {
      msg.textContent = t('profile.connError');
      msg.className = 'save-msg err';
      btn.disabled = false;
    }
  }

  async function _loadDeletionZone() {
    try {
      var r = await apiFetch('/api/config?action=deletion-preflight');
      if (!r.ok) return;
      var plan = await r.json();
      _renderDeletionPlan(plan);
      document.getElementById('danger-zone').style.display = '';
    } catch (e) {
      // apiFetch already redirected on session expiry; any other failure just
      // leaves the danger zone hidden rather than show a broken partial UI.
    }
  }

  function _renderDeletionPlan(plan) {
    _deletionEmail = plan.email;
    _fillDangerList('danger-destroy', 'danger-destroy-list', plan.destroy, true);
    _fillDangerList('danger-leave', 'danger-leave-list', plan.leave, false);
    _fillDangerList('danger-blocked', 'danger-blocked-list', plan.blocked, false);
    document.getElementById('delete-account-btn').disabled = plan.blocked.length > 0;
  }

  function _fillDangerList(sectionId, listId, items, withExport) {
    var section = document.getElementById(sectionId);
    var list = document.getElementById(listId);
    if (!items || !items.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    list.innerHTML = items.map(function (a) {
      var name = escHtml(a.name);
      if (!withExport) return '<li>' + name + '</li>';
      return '<li>' + name + ' — <button type="button" class="danger-export-btn" data-slug="' +
        escHtml(a.slug) + '">' + t('profile.dangerExport') + '</button></li>';
    }).join('');
    if (withExport) {
      list.querySelectorAll('.danger-export-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { _exportWorkspace(btn.dataset.slug, btn); });
      });
    }
  }

  // Downloads a workspace's full data export. A plain <a href> would 401 —
  // the export route only reads the Bearer header, which a link click never
  // sends — so this fetches the file itself and hands the browser a blob.
  async function _exportWorkspace(slug, btn) {
    btn.disabled = true;
    var original = btn.textContent;
    try {
      var r = await apiFetch('/api/' + encodeURIComponent(slug) + '/export');
      if (!r.ok) throw new Error('export failed');
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = slug + '-export.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 100);
    } catch (e) {
      btn.textContent = t('profile.failed');
      setTimeout(function () { btn.textContent = original; }, 2000);
    } finally {
      btn.disabled = false;
    }
  }

  async function _requestDeletion() {
    if (!confirm(t('profile.dangerConfirmPrompt'))) return;
    var btn = document.getElementById('delete-account-btn');
    var msg = document.getElementById('danger-msg');
    btn.disabled = true;
    msg.className = 'save-msg';
    msg.textContent = t('profile.dangerRequesting');
    try {
      var r = await apiFetch('/api/config', 'POST', { action: 'request-deletion' });
      var data = await r.json().catch(function () { return {}; });
      if (r.ok) {
        msg.textContent = t('profile.dangerSent', { email: _deletionEmail });
        msg.className = 'save-msg ok';
        return; // stays disabled — a link is already on its way
      }
      msg.textContent = data.error || t('profile.failed');
      msg.className = 'save-msg err';
      if (r.status === 409) {
        // _loadDeletionZone() sets disabled = plan.blocked.length > 0 itself —
        // re-enabling here unconditionally would put the button right back in
        // front of the newly-appeared blocker it just found.
        await _loadDeletionZone();
      } else {
        btn.disabled = false;
      }
    } catch (e) {
      msg.textContent = t('profile.connError');
      msg.className = 'save-msg err';
      btn.disabled = false;
    }
  }
}());
