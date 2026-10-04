const crypto = require('crypto');
const logger = require('./_logger');

// Every handler runs inside wrap(): one request log line, a 500 for anything
// thrown, and a short request id — on every log entry of the request, in the
// X-Request-Id header, and in the 500 body — so a user's report can be matched
// to its log lines.
//
// The request's buffered log lines go out in one call per request. Vercel can
// freeze the function the moment the response is out, and a send started after
// that point is lost (production logs stopped reaching the log service that
// way), so the send is handed to the platform's waitUntil, which keeps the
// function alive for it after the response. Where there is no waitUntil (the
// local stack, tests), res.end is held until the send is done instead.
//
// waitUntil comes from Vercel's request context, the same lookup
// @vercel/functions does; that package pulls in about twenty others for it.
function platformWaitUntil() {
  const ctx = /** @type {any} */ (globalThis)[Symbol.for('@vercel/request-context')]?.get?.();
  return typeof ctx?.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null;
}

// Vercel refuses response bodies over 4.5 MB. List endpoints (songs, setlists)
// and the export are unpaged and grow with a band; a body past this size logs a
// large_response warning, well before the platform limit turns it into an error.
const LARGE_RESPONSE_BYTES = 2 * 1024 * 1024;

function bodyBytes(chunk) {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk);
  if (chunk && typeof chunk.length === 'number') return chunk.length;
  return 0;
}

// The URL as logged. The OAuth provider returns to /auth/callback with the
// authorization code and state in the query: credentials, even if spent ones,
// do not belong in a third-party log.
const SECRET_PARAMS = ['code', 'state'];
function logUrl(raw) {
  if (typeof raw !== 'string' || !raw.includes('?')) return raw;
  try {
    const u = new URL(raw, 'http://x');
    let changed = false;
    for (const k of SECRET_PARAMS) if (u.searchParams.has(k)) { u.searchParams.set(k, 'redacted'); changed = true; }
    return changed ? u.pathname + u.search : raw;
  } catch { return raw; }
}

function wrap(handler) {
  return async function (req, res) {
    const start = Date.now();
    const { method } = req;
    const url = logUrl(req.url);
    const requestId = crypto.randomUUID().slice(0, 8);
    const inContext = logger.withContext || ((_ctx, fn) => fn());
    if (typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);

    let failed = false;
    let ending = null;
    const flush = () => (logger.flush ? logger.flush() : undefined);
    const waitUntil = platformWaitUntil();
    if (typeof res.end === 'function') {
      const end = res.end;
      res.end = function (...args) {
        res.end = end;
        ending = (async () => {
          try {
            const bytes = bodyBytes(args[0]);
            if (bytes > LARGE_RESPONSE_BYTES && logger.warn) await logger.warn('large_response', { method, url, bytes });
            if (!failed) await logger.info('request', { method, url, ms: Date.now() - start, status: res.statusCode, bytes });
            if (waitUntil) {
              waitUntil(Promise.resolve(flush()).catch(() => {}));
            } else {
              await flush();
            }
          } catch {}
          end.apply(res, args);
        })();
        return res;
      };
    }

    await inContext({ requestId }, async () => {
      try {
        await handler(req, res);
        if (!ending) await logger.info('request', { method, url, ms: Date.now() - start, status: res.statusCode });
      } catch (err) {
        failed = true;
        await logger.error('unhandled_error', { method, url, ms: Date.now() - start, error: err?.message, stack: err?.stack });
        if (!res.headersSent && !ending) res.status(500).json({ error: 'Internal server error', requestId });
      }
      // A response that never went through res.end still sends its lines.
      // Inside the context: the lines are kept per request.
      if (ending) await ending;
      else if (waitUntil) waitUntil(Promise.resolve(flush()).catch(() => {}));
      else await flush();
    });
  };
}

module.exports = { wrap, logUrl, LARGE_RESPONSE_BYTES };
