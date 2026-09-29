(function () {
  var email = '';
  // Messages below come from t(); the dictionary loads in parallel.
  var ready = (window.i18n && window.i18n.ready) || Promise.resolve();

  document.getElementById('s1-next').addEventListener('click', function () {
    var val = document.getElementById('s1-email').value.trim();
    var msg = document.getElementById('s1-msg');
    if (!val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      ready.then(function () { msg.textContent = t('demo.errInvalidEmail'); });
      return;
    }
    msg.textContent = '';
    email = val;
    var btn = document.getElementById('s1-next');
    btn.disabled = true; btn.textContent = '…';
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, source: 'demo' }),
    })
      .then(function (r) { return Promise.all([r.json(), ready]).then(function (a) { return { ok: r.ok, status: r.status, data: a[0] }; }); })
      .then(function (r) {
        if (r.ok || r.status === 409) {
          sessionStorage.setItem('demo_email', email);
          sessionStorage.setItem('demo_name', email.split('@')[0]);
          var slug = (r.data && r.data.slug) || 'demo';
          var tok  = r.data && r.data.token;
          if (tok) sessionStorage.setItem('smartist_token', tok);
          // With a token the demo workspace opens fully; without one fall back
          // to the public songs view.
          window.location.href = tok ? '/' + slug + '/dashboard' : '/' + slug + '/songs';
        } else {
          msg.textContent = (r.data && r.data.error) || t('demo.errGeneric');
          btn.disabled = false; btn.textContent = t('demo.nextBtn');
        }
      })
      .catch(function () {
        msg.textContent = t('demo.errNetwork');
        btn.disabled = false; btn.textContent = t('demo.nextBtn');
      });
  });

  document.getElementById('s1-email').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('s1-next').click();
  });

  setTimeout(function () { document.getElementById('s1-email').focus(); }, 50);
}());
