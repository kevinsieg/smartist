async function getGoogleUrl(mode) {
  const r = await fetch('/api/config?action=google-url&mode=' + (mode || 'login'));
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Google login unavailable');
  return data.url;
}

async function getFacebookUrl(mode) {
  const r = await fetch('/api/config?action=facebook-url&mode=' + (mode || 'login'));
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Facebook login unavailable');
  return data.url;
}

async function getMyArtists(token) {
  const r = await fetch('/api/config?action=my-artists', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (r.status === 401) return [];
  const data = await r.json();
  return data.artists || [];
}
