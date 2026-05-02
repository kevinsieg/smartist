// Stage view — full-screen setlist for on-stage use

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatLength(min) {
  if (!min) return '';
  const m = Math.floor(min);
  const s = Math.round((min - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function init() {
  const params   = new URLSearchParams(window.location.search);
  const setlistId = Number(params.get('id'));
  const el       = document.getElementById('stage-content');

  if (!setlistId) {
    el.innerHTML = '<p class="stage-message">No setlist ID provided.</p>';
    return;
  }

  try {
    const cfg  = await loadConfig();
    const data = await fetch(`/api/${cfg.slug}/setlists/${setlistId}`).then(r => {
      if (!r.ok) throw new Error('not found');
      return r.json();
    });

    const songs = data.songs ?? [];

    // Build header text
    const gigParts = [data.gig_name, data.gig_date ? String(data.gig_date).slice(0, 10) : null, data.gig_venue]
      .filter(Boolean);
    const gigLine  = gigParts.join(' — ');
    const setTitle = data.title ? `“${escHtml(data.title)}”` : '';
    const mainTitle = gigLine ? escHtml(gigLine) : (setTitle || `Setlist #${setlistId}`);

    document.title = `${data.title || data.gig_name || 'Stage'} — ${cfg.name}`;

    let totalMin = 0;
    const items = songs.map((song, i) => {
      totalMin += song.length_min || 0;
      return `<li class="stage-song">
        <span class="stage-num">${i + 1}.</span>
        <span class="stage-song-title">${escHtml(song.title)}</span>
        ${song.key ? `<span class="stage-key">${escHtml(song.key)}</span>` : ''}
      </li>`;
    }).join('');

    el.innerHTML = `
      <div class="stage-header">
        <div class="stage-band">${escHtml(cfg.name)}</div>
        <h1 class="stage-title">${mainTitle}</h1>
        ${gigLine && setTitle ? `<p class="stage-sub">${setTitle}</p>` : ''}
        ${data.comment ? `<p class="stage-sub" style="font-style:italic;">${escHtml(data.comment)}</p>` : ''}
      </div>
      <ul class="stage-list">${items}</ul>
      ${totalMin ? `<p class="stage-total">${songs.length} song${songs.length !== 1 ? 's' : ''} &middot; ${formatLength(totalMin)}</p>` : ''}`;

  } catch {
    el.innerHTML = '<p class="stage-message">Setlist not found.</p>';
  }
}

init();
