(function () {
  // var, not const/let: SPA navigation re-executes page scripts in the same
  // document, and a repeated top-level declaration throws before this runs.
  var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  var token  = params.get('token') || '';
  var slug   = params.get('slug')  || '';
  // Strip the token from the address bar so it does not linger in history.
  history.replaceState(null, '', window.location.pathname);

  var statusEl = document.getElementById('confirm-status');

  function fail(key) {
    statusEl.textContent = t(key);
    statusEl.className = 'status-msg error';
  }

  async function post(body) {
    return await fetch('/api/' + encodeURIComponent(slug) + '/auth?action=confirm-email-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function start() {
    if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }
    if (!token || !slug) { fail('confirmEmail.badLink'); return; }
    try {
      var r = await post({ token: token });
      var data = await r.json();
      if (!r.ok) { fail('confirmEmail.invalid'); return; }
      document.getElementById('confirm-email-value').textContent = data.newEmail;
      document.getElementById('confirm-bands').innerHTML =
        (data.bands || []).map(function (b) { return '<li>' + escHtml(b.name) + '</li>'; }).join('');
      statusEl.style.display = 'none';
      document.getElementById('confirm-body').style.display = '';
    } catch (e) { fail('confirmEmail.connError'); }
  }

  document.getElementById('confirm-btn').addEventListener('click', async function () {
    var btn = document.getElementById('confirm-btn');
    var msg = document.getElementById('confirm-msg');
    btn.disabled = true;
    msg.className = 'save-msg';
    msg.textContent = t('confirmEmail.applying');
    try {
      var r = await post({ token: token, confirm: true });
      var data = await r.json();
      if (!r.ok) {
        msg.textContent = data.error || t('confirmEmail.failed');
        msg.className = 'save-msg err';
        btn.disabled = false;
        return;
      }
      document.getElementById('confirm-body').style.display = 'none';
      statusEl.style.display = '';
      statusEl.textContent = t('confirmEmail.changed');
      statusEl.className = 'status-msg';
      document.getElementById('confirm-done').style.display = '';
    } catch (e) {
      msg.textContent = t('confirmEmail.connError');
      msg.className = 'save-msg err';
      btn.disabled = false;
    }
  });

  start();
}());
