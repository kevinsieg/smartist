'use strict';
const { getDb } = require('./_db');
const logger = require('./_logger');

// Keys carry an IP, an address or a song id, so most are used once and never
// again: their rows would pile up forever. About one call in SWEEP_EVERY also
// clears rows idle for longer than any window used here (the longest is a
// day; login-ok rows are kept LOGIN_OK_DAYS). A failed sweep never fails the
// request.
const SWEEP_EVERY = 200;

// Sliding-window rate limiter backed by the rate_limits table.
// Returns true if the request should be blocked (limit exceeded).
// Each key gets one row; the window resets automatically when it expires.
async function checkRateLimit(key, maxRequests, windowSecs) {
  return (await countInWindow(key, windowSecs)) > maxRequests;
}

// This request's number within the key's current window.
async function countInWindow(key, windowSecs) {
  const sql = getDb();
  const windowStart = new Date(Date.now() - windowSecs * 1000).toISOString();
  const sweep = Math.random() < 1 / SWEEP_EVERY
    ? Promise.resolve(sql`
        DELETE FROM rate_limits
        WHERE window_start < now() - interval '1 day'
          AND (NOT starts_with(key, 'login-ok:') OR window_start < now() - ${`${LOGIN_OK_DAYS} days`}::interval)`).catch(() => null)
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
  return row.count;
}

// A deployment-wide daily count that raises an alarm instead of refusing:
// as a hard stop, a few free sign-ups could use it up and block every band
// for the day. The per-band and per-person caps are the stops.
async function dailyAlarm(key, threshold) {
  const n = await countInWindow(key, 86400);
  if (n === threshold + 1) await logger.error('daily_cap_alarm', { key, threshold });
}

// Failed sign-ins per account. The per-IP limit alone let a botnet try one
// address from many machines; a lock per address alone let anyone lock a
// person out by typing ten wrong passwords for them. So failures count twice:
// per address and IP, where ten lock that pair for fifteen minutes, and per
// address overall, where a hundred (ten IPs' worth) lock the address
// everywhere except on the IPs it signed in from lately (loginOkKey). Only
// failures count, so a person who signs in correctly is never slowed down,
// and the owner on their own network stays out of a stranger's lock.
// Password reset and emailed links are not affected by either. The lock
// is read in passwordLogin's first statement (api/_domain/login.js); a failure
// is counted here.
const LOGIN_FAIL_MAX = 10;
const LOGIN_FAIL_ADDRESS_MAX = 100;
const LOGIN_FAIL_WINDOW = 15 * 60;
const loginFailKey = email => `login-fail:${String(email || '').trim().toLowerCase()}`;
const loginFailPairKey = (email, ip) => `${loginFailKey(email)}|${ip || 'unknown'}`;
// An IP this address signed in from lately is the owner's own network: the
// address-wide lock (LOGIN_FAIL_ADDRESS_MAX) does not apply to it, so a
// stranger with ten IPs cannot keep the owner out. Only the pair lock does.
// Kept LOGIN_OK_DAYS after the last sign-in; the sweep above clears it later.
const LOGIN_OK_DAYS = 30;
const loginOkPrefix = email => `login-ok:${String(email || '').trim().toLowerCase()}|`;
const loginOkKey = (email, ip) => `${loginOkPrefix(email)}${ip || 'unknown'}`;
async function countLoginFailure(email, ip) {
  const windowStart = new Date(Date.now() - LOGIN_FAIL_WINDOW * 1000).toISOString();
  // Both counters in one statement, with checkRateLimit's window reset.
  await getDb()`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${loginFailPairKey(email, ip)}, NOW(), 1), (${loginFailKey(email)}, NOW(), 1)
    ON CONFLICT (key) DO UPDATE SET
      window_start = CASE WHEN rate_limits.window_start < ${windowStart} THEN NOW() ELSE rate_limits.window_start END,
      count        = CASE WHEN rate_limits.window_start < ${windowStart} THEN 1 ELSE rate_limits.count + 1 END
  `;
}

// Mail a session sends to an address of its choosing (invites, setlist
// shares). The per-band and per-IP limits at each call site stop one band;
// the per-person cap stops one person spread over many bands from turning
// the app's sender into a relay. `who` is the sender's address. The
// deployment-wide count only alarms (dailyAlarm).
const MAIL_OUT_PERSON_DAILY = 50;
const MAIL_OUT_DAILY = 500;
async function outboundMailLimited(who) {
  if (await checkRateLimit(`mail-out:${String(who || '').toLowerCase()}`, MAIL_OUT_PERSON_DAILY, 86400)) return true;
  await dailyAlarm('mail-out-day', MAIL_OUT_DAILY);
  return false;
}

// Presigned upload URLs. Storage is counted when an upload is confirmed, so an
// upload that is never confirmed costs bucket space nobody is charged for; this
// bounds how much of it one band can park: an hourly and a daily cap per band,
// and an alarm when all bands together pass PRESIGN_DAILY.
const PRESIGN_PER_HOUR = 60;
const PRESIGN_BAND_DAILY = 200;
const PRESIGN_DAILY = 2000;
async function presignLimited(bandId) {
  if (await checkRateLimit(`presign:${bandId}`, PRESIGN_PER_HOUR, 3600)) return true;
  if (await checkRateLimit(`presign-day:${bandId}`, PRESIGN_BAND_DAILY, 86400)) return true;
  await dailyAlarm('presign-day', PRESIGN_DAILY);
  return false;
}

function clientIp(req) {
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'].trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

module.exports = {
  checkRateLimit, clientIp, countLoginFailure,
  loginFailKey, loginFailPairKey, loginOkKey, loginOkPrefix, LOGIN_OK_DAYS, LOGIN_FAIL_MAX, LOGIN_FAIL_ADDRESS_MAX, LOGIN_FAIL_WINDOW,
  outboundMailLimited, MAIL_OUT_PERSON_DAILY, MAIL_OUT_DAILY,
  presignLimited, PRESIGN_PER_HOUR, PRESIGN_BAND_DAILY, PRESIGN_DAILY,
};
