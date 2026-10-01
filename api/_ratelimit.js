'use strict';
const { getDb } = require('./_db');

// Keys carry an IP, an address or a song id, so most are used once and never
// again: their rows would pile up forever. About one call in SWEEP_EVERY also
// clears rows idle for longer than any window used here (the longest is an
// hour). A failed sweep never fails the request.
const SWEEP_EVERY = 200;

// Sliding-window rate limiter backed by the rate_limits table.
// Returns true if the request should be blocked (limit exceeded).
// Each key gets one row; the window resets automatically when it expires.
async function checkRateLimit(key, maxRequests, windowSecs) {
  const sql = getDb();
  const windowStart = new Date(Date.now() - windowSecs * 1000).toISOString();
  const sweep = Math.random() < 1 / SWEEP_EVERY
    ? Promise.resolve(sql`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`).catch(() => null)
    : null;
  const [[row]] = await Promise.all([sql`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${key}, NOW(), 1)
    ON CONFLICT (key) DO UPDATE SET
      window_start = CASE
        WHEN rate_limits.window_start < ${windowStart} THEN NOW()
        ELSE rate_limits.window_start
      END,
      count = CASE
        WHEN rate_limits.window_start < ${windowStart} THEN 1
        ELSE rate_limits.count + 1
      END
    RETURNING count
  `, sweep]);
  return row.count > maxRequests;
}

// Read-only: is this key already over its limit? Does not count a hit — for
// callers that only want to count failures (failed logins per account, see
// loginLocked), paired with checkRateLimit on the failure path.
async function isRateLimited(key, maxRequests, windowSecs) {
  const sql = getDb();
  const windowStart = new Date(Date.now() - windowSecs * 1000).toISOString();
  const [row] = await sql`
    SELECT count FROM rate_limits WHERE key = ${key} AND window_start >= ${windowStart}
  `;
  return !!row && row.count >= maxRequests;
}

// Failed sign-ins per account. The per-IP limit alone let a botnet try one
// address from many machines. Only failures count, so a person who signs in
// correctly is never slowed down; ten wrong passwords lock that address for
// fifteen minutes.
const LOGIN_FAIL_MAX = 10;
const LOGIN_FAIL_WINDOW = 15 * 60;
const loginFailKey = email => `login-fail:${String(email || '').trim().toLowerCase()}`;
async function loginLocked(email) {
  return isRateLimited(loginFailKey(email), LOGIN_FAIL_MAX, LOGIN_FAIL_WINDOW);
}
async function countLoginFailure(email) {
  await checkRateLimit(loginFailKey(email), LOGIN_FAIL_MAX, LOGIN_FAIL_WINDOW);
}

// Mail a session sends to an address of its choosing (invites, setlist
// shares). The per-band and per-IP limits at each call site stop one band;
// these stop one person spread over many bands, and everyone together, from
// turning the app's sender into a relay. `who` is the sender's address.
const MAIL_OUT_PERSON_DAILY = 50;
const MAIL_OUT_DAILY = 500;
async function outboundMailLimited(who) {
  return (await checkRateLimit(`mail-out:${String(who || '').toLowerCase()}`, MAIL_OUT_PERSON_DAILY, 86400))
      || (await checkRateLimit('mail-out-day', MAIL_OUT_DAILY, 86400));
}

// Presigned upload URLs. Storage is counted when an upload is confirmed, so an
// upload that is never confirmed costs bucket space nobody is charged for; this
// bounds how much of it one band can park.
const PRESIGN_PER_HOUR = 60;
async function presignLimited(bandId) {
  return checkRateLimit(`presign:${bandId}`, PRESIGN_PER_HOUR, 3600);
}

function clientIp(req) {
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'].trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

module.exports = {
  checkRateLimit, isRateLimited, clientIp, loginLocked, countLoginFailure,
  outboundMailLimited, MAIL_OUT_PERSON_DAILY, MAIL_OUT_DAILY, presignLimited, PRESIGN_PER_HOUR,
};
