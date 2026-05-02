const logger = require('./_logger');

function wrap(handler) {
  return async function (req, res) {
    const start = Date.now();
    const { method, url } = req;
    try {
      await handler(req, res);
      await logger.info('request', { method, url, ms: Date.now() - start, status: res.statusCode });
    } catch (err) {
      await logger.error('unhandled_error', { method, url, ms: Date.now() - start, error: err?.message, stack: err?.stack });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };
}

module.exports = { wrap };
