const TOKEN = sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token') || '';

async function load() {
  const r = await fetch('/api/config?action=admin-overview', {
    headers: { Authorization: 'Bearer ' + TOKEN }
  });
  if (!r.ok) { document.body.textContent = 'Not authorised'; return; }
  const { totals, bands } = await r.json();

  document.getElementById('totals').textContent =
    totals.bands + ' bands · ' +
    (totals.storageUsedBytes / 1048576).toFixed(1) + ' MB · ' +
    totals.pro + ' pro / ' + totals.free + ' free · ' +
    totals.upgraded + ' upgraded';

  const tb = document.getElementById('bands');
  tb.innerHTML = '';
  bands.forEach(function (b) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = b.name;
    tr.appendChild(tdName);

    const tdStorage = document.createElement('td');
    tdStorage.textContent = (b.storage_used_bytes / 1048576).toFixed(1) + ' MB';
    tr.appendChild(tdStorage);

    const tdSongs = document.createElement('td');
    tdSongs.textContent = b.songs;
    tr.appendChild(tdSongs);

    const tdUsers = document.createElement('td');
    tdUsers.textContent = b.users;
    tr.appendChild(tdUsers);

    const tdPlan = document.createElement('td');
    const sel = document.createElement('select');
    ['free', 'pro'].forEach(function (p) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      if (b.plan === p) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = async function () {
      sel.disabled = true;
      await fetch('/api/config', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action: 'admin-set-plan', slug: b.slug, plan: sel.value })
      });
      load();
    };
    tdPlan.appendChild(sel);
    tr.appendChild(tdPlan);

    tb.appendChild(tr);
  });
}

load();
