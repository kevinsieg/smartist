async function checkSlug(slug) {
  const r = await fetch('/api/config?action=check-slug&slug=' + encodeURIComponent(slug));
  const data = await r.json();
  return data.available === true;
}

async function loadArtistConfig(slug) {
  const url = slug ? '/api/config?slug=' + encodeURIComponent(slug) : '/api/config';
  const r = await fetch(url);
  if (!r.ok) throw new Error(t('auth.configUnavailable'));
  return r.json();
}
