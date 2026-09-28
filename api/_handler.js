const crypto = require('crypto');
const logger = require('./_logger');

// Every handler runs inside wrap(): one request log line, a 500 for anything
// thrown, and a short request id — on every log entry of the request, in the
// X-Request-Id header, and in the 500 body — so a user's report can be matched
// to its log lines.
function wrap(handler) {
  return async function (req, res) {
    const start = Date.now();
    const { method, url } = req;
    const requestId = crypto.randomUUID().slice(0, 8);
    const inContext = logger.withContext || ((_ctx, fn) => fn());
    if (typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);
    await inContext({ requestId }, async () => {
      try {
        await handler(req, res);
        await logger.info('request', { method, url, ms: Date.now() - start, status: res.statusCode });
      } catch (err) {
        await logger.error('unhandled_error', { method, url, ms: Date.now() - start, error: err?.message, stack: err?.stack });
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error', requestId });
      }
    });
    // After the response: send what this request logged in one go.
    if (logger.flush) await logger.flush();
  };
}

module.exports = { wrap };
