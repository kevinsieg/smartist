const crypto = require('crypto');
const logger = require('./_logger');

// Every handler runs inside wrap(): one request log line, a 500 for anything
// thrown, and a short request id — on every log entry of the request, in the
// X-Request-Id header, and in the 500 body — so a user's report can be matched
// to its log lines.
//
// The request's buffered log lines are sent BEFORE the response ends: Vercel
// can freeze the function the moment the response is out, and a send started
// after that point is lost (production logs stopped reaching the log service
// that way). res.end is held until the send is done — one call per request.
function wrap(handler) {
  return async function (req, res) {
    const start = Date.now();
    const { method, url } = req;
    const requestId = crypto.randomUUID().slice(0, 8);
    const inContext = logger.withContext || ((_ctx, fn) => fn());
    if (typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);

    let failed = false;
    let ending = null;
    const flush = () => (logger.flush ? logger.flush() : undefined);
    if (typeof res.end === 'function') {
      const end = res.end;
      res.end = function (...args) {
        res.end = end;
        ending = (async () => {
          try {
            if (!failed) await logger.info('request', { method, url, ms: Date.now() - start, status: res.statusCode });
            await flush();
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
    });
    // A response that never went through res.end still sends its lines.
    if (ending) await ending;
    else await flush();
  };
}

module.exports = { wrap };
