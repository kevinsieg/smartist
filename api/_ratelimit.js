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
  return (await countInWindows([{ key, windowSecs }])).get(key);
}

const sweepIdle = sql => sql`
  DELETE FROM rate_limits
  WHERE window_start < now() - interval '1 day'
    AND (NOT starts_with(key, 'login-ok:') OR window_start < now() - ${`${LOGIN_OK_DAYS} days`}::interval)`;

// Several counters in one statement: [{ key, windowSecs }] → Map of key →
// this request's number within that key's window. Each statement costs two
// round-trips (prepare: false, api/_db.js), and a presign counted three keys
// one after another. Keys must be distinct.
async function countInWindows(counters) {
  const sql = getDb();
  const rows = counters.map(c => ({ key: c.key, since: new Date(Date.now() - c.windowSecs * 1000).toISOString() }));
  const sweep = Math.random() < 1 / SWEEP_EVERY ? Promise.resolve(sweepIdle(sql)).catch(() => null) : null;
  const [counted] = await Promise.all([sql`
    WITH i AS (SELECT * FROM jsonb_to_recordset(${sql.json(rows)}) AS i(key text, since timestamptz))
    INSERT INTO rate_limits (key, window_start, count)
    SELECT key, NOW(), 1 FROM i
    ON CONFLICT (key) DO UPDATE SET
      window_start = CASE
        WHEN rate_limits.window_start < (SELECT since FROM i WHERE i.key = rate_limits.key) THEN NOW()
        ELSE rate_limits.window_start
      END,
      count = CASE
        WHEN rate_limits.window_start < (SELECT since FROM i WHERE i.key = rate_limits.key) THEN 1
        ELSE rate_limits.count + 1
      END
    RETURNING key, count
  `, sweep]);
  return new Map(counted.map(r => [r.key, r.count]));
}

// A deployment-wide daily count that raises an alarm instead of refusing:
// as a hard stop, a few free sign-ups could use it up and block every band
// for the day. The per-band and per-person caps are the stops.
async function dailyAlarm(key, threshold) {
  await alarmAt(await countInWindow(key, 86400), key, threshold);
}
async function alarmAt(n, key, threshold) {
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
//
// The address and the IP are joined by a space, which no address passwordLogin
// accepts (validateEmail): with `|` an "address" like `x@y.z|<ip>` was the
// owner's own pair key, so ten strangers could trip the lock meant for the
// owner's own network.
const LOGIN_FAIL_MAX = 10;
const LOGIN_FAIL_ADDRESS_MAX = 100;
const LOGIN_FAIL_WINDOW = 15 * 60;
const loginFailKey = email => `login-fail:${String(email || '').trim().toLowerCase()}`;
const loginFailPairKey = (email, ip) => `${loginFailKey(email)} ${ip || 'unknown'}`;
// An IP this address signed in from lately is the owner's own network: the
// address-wide lock (LOGIN_FAIL_ADDRESS_MAX) does not apply to it, so a
// stranger with ten IPs cannot keep the owner out. Only the pair lock does.
// Kept LOGIN_OK_DAYS after the last sign-in; the sweep above clears it later.
// Forgotten (password change, reset, sign-out everywhere) with
// `key >= prefix AND key < prefix || chr(1114111)`: a range the primary key
// answers, where starts_with() or LIKE 'p%' read the whole table.
const LOGIN_OK_DAYS = 30;
const loginOkPrefix = email => `login-ok:${String(email || '').trim().toLowerCase()} `;
const loginOkKey = (email, ip) => `${loginOkPrefix(email)}${ip || 'unknown'}`;
// Both counters in one statement.
async function countLoginFailure(email, ip) {
  await countInWindows([
    { key: loginFailPairKey(email, ip), windowSecs: LOGIN_FAIL_WINDOW },
    { key: loginFailKey(email), windowSecs: LOGIN_FAIL_WINDOW },
  ]);
}


// Mail a session sends to an address of its choosing (invites, setlist
// shares). The per-band and per-IP limits at each call site stop one band;
// the per-person cap stops one person spread over many bands from turning
// the app's sender into a relay. `who` is the sender's address. The
// deployment-wide count only alarms (dailyAlarm).
const MAIL_OUT_PERSON_DAILY = 50;
const MAIL_OUT_DAILY = 500;
const personKey = (prefix, who) => `${prefix}:${String(who || '').trim().toLowerCase()}`;
async function outboundMailLimited(who) {
  const key = personKey('mail-out', who);
  const n = await countInWindows([{ key, windowSecs: 86400 }, { key: 'mail-out-day', windowSecs: 86400 }]);
  await alarmAt(n.get('mail-out-day'), 'mail-out-day', MAIL_OUT_DAILY);
  return n.get(key) > MAIL_OUT_PERSON_DAILY;
}

// Presigned upload URLs. Storage is counted when an upload is confirmed, so an
// upload that is never confirmed costs bucket space nobody is charged for; this
// bounds how much of it can be parked: an hourly and a daily cap per band, a
// daily cap per person across all their bands (a workspace costs one click, so
// a cap per band alone let one account multiply it), and an alarm when
// everyone together passes PRESIGN_DAILY. `who` is the session's address.
// One statement for all four counters.
const PRESIGN_PER_HOUR = 60;
const PRESIGN_BAND_DAILY = 200;
const PRESIGN_PERSON_DAILY = 300;
const PRESIGN_DAILY = 2000;
async function presignLimited(bandId, who) {
  const hour = `presign:${bandId}`, day = `presign-day:${bandId}`;
  const person = who ? personKey('presign-person', who) : null;
  const n = await countInWindows([
    { key: hour, windowSecs: 3600 },
    { key: day, windowSecs: 86400 },
    ...(person ? [{ key: person, windowSecs: 86400 }] : []),
    { key: 'presign-day', windowSecs: 86400 },
  ]);
  await alarmAt(n.get('presign-day'), 'presign-day', PRESIGN_DAILY);
  return n.get(hour) > PRESIGN_PER_HOUR || n.get(day) > PRESIGN_BAND_DAILY
    || (person !== null && n.get(person) > PRESIGN_PERSON_DAILY);
}

function clientIp(req) {
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'].trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

module.exports = {
  checkRateLimit, countInWindows, dailyAlarm, alarmAt, personKey, clientIp, countLoginFailure,
  loginFailKey, loginFailPairKey, loginOkKey, loginOkPrefix, LOGIN_OK_DAYS, LOGIN_FAIL_MAX, LOGIN_FAIL_ADDRESS_MAX, LOGIN_FAIL_WINDOW,
  outboundMailLimited, MAIL_OUT_PERSON_DAILY, MAIL_OUT_DAILY,
  presignLimited, PRESIGN_PER_HOUR, PRESIGN_BAND_DAILY, PRESIGN_PERSON_DAILY, PRESIGN_DAILY,
};
