async function sendSignupLink(email, website) {
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'signup-link', email, website: website || undefined }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || t('auth.failedToSendLink'));
  return data;
}

async function verifySignupToken(token) {
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'verify-signup-token', token }),
  });
  const data = await r.json();
  if (!r.ok) return { ok: false, error: data.error };
  return { ok: true, email: data.email };
}

async function signup({ token, name, slug }) {
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'signup', token, name, slug }),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error || t('auth.signUpFailed')), { status: r.status });
  return data;
}
