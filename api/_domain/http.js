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

// ── Plain input in, plain result out ──────────────────────────────────────────
// Domain functions take `input` and return a `result`, so they run (and are
// tested) without a request or response object, and scripts can call them:
//
//   input:  { body, query, headers, ip, origin }   — headers lower-cased
//   result: { status, body }                       — JSON reply
//           { status, redirect, headers? }         — redirect (OAuth), headers
//                                                    such as Set-Cookie
//
// toInput/send are the only places that touch req and res.

const { clientIp } = require('../_ratelimit');

function toInput(req) {
  return {
    body:    req.body ?? {},
    query:   req.query ?? {},
    headers: req.headers ?? {},
    ip:      clientIp({ headers: req.headers ?? {} }),
    origin:  origin({ headers: req.headers ?? {} }),
  };
}

function send(res, result) {
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  if (result.redirect) return res.redirect(result.status || 302, result.redirect);
  return res.status(result.status || 200).json(result.body ?? {});
}

// (req, res) handler for a domain function.
const handle = fn => async (req, res) => send(res, await fn(toInput(req)));

// Error bodies: { error: <message for people>, code?: <machine code> }. A
// client that branches on a failure reads `code` (song_limit, upgrade_required,
// demo_readonly, …), never the message. The messages every route shares:
const MSG = {
  unauthorized:     'Unauthorized',
  forbidden:        'Forbidden',
  artistNotFound:   'Artist not found',
  notFound:         'Not found',
  methodNotAllowed: 'Method not allowed',
  signIn:           'Sign in to view this',
};

const reply = (status, body) => ({ status, body });
const ok = body => ({ status: 200, body });
const fail = (status, error, extra) => ({ status, body: { error, ...extra } });

module.exports = { toInput, send, handle, reply, ok, fail, MSG };
