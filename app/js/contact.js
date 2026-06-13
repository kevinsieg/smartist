// Contact page — works with and without a workspace slug in the URL.

async function _contactInit() {
  if (_artistSlug) {
    try {
      var cfg = await loadConfig(undefined, { light: true });
      applyNav(cfg.name, cfg.config);
      document.title = 'Contact — ' + (cfg.name || 'smartist');
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

  if (!name)  { setStatus('cf-status', 'Please enter your name.', true);  return; }
  if (!email) { setStatus('cf-status', 'Please enter your email.', true); return; }
  if (!msg)   { setStatus('cf-status', 'Please enter a message.', true);  return; }

  btn.disabled = true; btn.textContent = 'Sending…';
  setStatus('cf-status', '');
  try {
    var r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'contact', name: name, email: email, message: msg }),
    });
    var d = await r.json().catch(function() { return {}; });
    if (!r.ok) {
      setStatus('cf-status', d.error || 'Failed to send — try again later.', true);
      btn.disabled = false; btn.textContent = 'Send message';
      return;
    }
    setStatus('cf-status', 'Thanks — your message was sent.');
    document.getElementById('cf-msg').value = '';
    btn.textContent = 'Sent';
  } catch (_) {
    setStatus('cf-status', 'Connection error — try again.', true);
    btn.disabled = false; btn.textContent = 'Send message';
  }
}

_contactInit();
