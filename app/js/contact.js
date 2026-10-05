// Contact page — works with and without a workspace slug in the URL.

async function _contactInit() {
  if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }

  if (_artistSlug) {
    try {
      var cfg = await loadConfig(undefined, { light: true });
      applyNav(cfg.name, cfg.config);
      document.title = 'smartist · ' + t('contact.heading') + (cfg.name ? ' · ' + cfg.name : '');
    } catch (_) {}
  } else {
    document.querySelectorAll('.band-name').forEach(function(el) { el.textContent = 'smartist'; });
  }

  var knownEmail = sessionStorage.getItem('smartist_admin_email');
  if (knownEmail) document.getElementById('cf-email').value = knownEmail;

  document.getElementById('cf-send').addEventListener('click', _contactSend);
  document.getElementById('cf-msg').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) _contactSend();
  });
}

async function _contactSend() {
  var name  = document.getElementById('cf-name').value.trim();
  var email = document.getElementById('cf-email').value.trim();
  var msg   = document.getElementById('cf-msg').value.trim();
  var btn   = document.getElementById('cf-send');

  if (!name)  { setStatus('cf-status', t('contact.errNameRequired'), true);  return; }
  if (!email) { setStatus('cf-status', t('contact.errEmailRequired'), true); return; }
  if (!msg)   { setStatus('cf-status', t('contact.errMessageRequired'), true);  return; }

  btn.disabled = true; btn.textContent = t('contact.sending');
  setStatus('cf-status', '');
  try {
    var r = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, message: msg }),
    });
    var d = await r.json().catch(function() { return {}; });
    if (!r.ok) {
      setStatus('cf-status', d.error || t('contact.errGeneric'), true);
      btn.disabled = false; btn.textContent = t('contact.sendBtn');
      return;
    }
    setStatus('cf-status', t('contact.successMsg'));
    document.getElementById('cf-msg').value = '';
    btn.textContent = t('contact.sent');
  } catch (_) {
    setStatus('cf-status', t('contact.errNetwork'), true);
    btn.disabled = false; btn.textContent = t('contact.sendBtn');
  }
}

_contactInit();
