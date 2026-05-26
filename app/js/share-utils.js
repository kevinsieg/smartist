// Sends a setlist PDF to an email via the share API.
// Returns { ok: true } on success, or { ok: false, unauthorized: bool, error: string }.
async function sendSetlistEmail(slug, setlistId, email, token) {
  try {
    var r = await fetch('/api/' + slug + '/setlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ share_id: setlistId, email: email })
    });
    if (r.status === 401) {
      sessionStorage.removeItem('smartist_token');
      return { ok: false, unauthorized: true, error: 'Wrong password.' };
    }
    if (r.ok) {
      sessionStorage.setItem('smartist_token', token);
      return { ok: true };
    }
    var err = await r.json().catch(function() { return {}; });
    return { ok: false, error: err.error || 'Failed to send.' };
  } catch {
    return { ok: false, error: 'Network error. Please try again.' };
  }
}
