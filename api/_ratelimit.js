'use strict';
const { getDb } = require('./_db');
const logger = require('./_logger');

// Sliding-window rate limiter backed by the rate_limits table.
// Returns true if the request should be blocked (limit exceeded).
// Fails open on DB errors so missing migrations do not take auth paths down.
async function checkRateLimit(key, maxRequests, windowSecs) {
  try {
    const sql = getDb();
    const windowStart = new Date(Date.now() - windowSecs * 1000).toISOString();
    const [row] = await sql`
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
    `;
    return row.count > maxRequests;
  } catch (err) {
    await logger.error('rate_limit_error', { key, error: err.message });
    return false;
  }
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

module.exports = { checkRateLimit, clientIp };
