// Request origin for links in emails (reset, invite, signup, deletion) and the
// OAuth redirect URI. APP_ORIGIN is authoritative and should be set on every
// deployment. The fallback uses the Host header only — never X-Forwarded-Host,
// which a client can set, and which would let anyone point a password-reset
// link at their own server.
function origin(req) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/+$/, '');
  const h = String(req.headers.host || 'localhost:3000');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(h)) return 'http://localhost:3000';
  return `${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h) ? 'http' : 'https'}://${h}`;
}

module.exports = { origin };
