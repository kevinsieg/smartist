const path = require('path');

function makeRes({ headersSent = false } = {}) {
  return {
    headersSent,
    statusCode: 200,
    jsonCalls: 0,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.jsonCalls++; this.headersSent = true; return this; },
  };
}

// Re-requires _handler with a fresh stubbed logger so tests can assert on log calls.
async function withStubbedLogger(fn) {
  const loggerPath = require.resolve(path.join(__dirname, '../../api/_logger'));
  const handlerPath = require.resolve(path.join(__dirname, '../../api/_handler'));
  const originalLogger = require.cache[loggerPath];
  const originalHandler = require.cache[handlerPath];
  const logs = [];

  delete require.cache[handlerPath];
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: {
      info:  async (event, data = {}) => logs.push({ level: 'info',  event, data }),
      warn:  async (event, data = {}) => logs.push({ level: 'warn',  event, data }),
      error: async (event, data = {}) => logs.push({ level: 'error', event, data }),
    },
  };

  try {
    const { wrap } = require(handlerPath);
    return await fn(wrap, logs);
  } finally {
    delete require.cache[handlerPath];
    if (originalHandler) require.cache[handlerPath] = originalHandler;
    if (originalLogger) require.cache[loggerPath] = originalLogger;
    else delete require.cache[loggerPath];
  }
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nhandler wrapper'));

  await testAsync('wrap logs successful requests with response status', async () => {
    await withStubbedLogger(async (wrap, logs) => {
      const res = makeRes();
      const req = { method: 'GET', url: '/ok' };

      await wrap(async (_req, res) => res.status(204).json({ ok: true }))(req, res);

      assertEq(logs.length, 1);
      assertEq(logs[0].level, 'info');
      assertEq(logs[0].event, 'request');
      assertEq(logs[0].data.method, 'GET');
      assertEq(logs[0].data.url, '/ok');
      assertEq(logs[0].data.status, 204);
    });
  });

  await testAsync('wrap converts unhandled errors to sanitized 500 responses', async () => {
    await withStubbedLogger(async (wrap, logs) => {
      const res = makeRes();
      const req = { method: 'POST', url: '/boom' };

      await wrap(async () => { throw new Error('database password leaked'); })(req, res);

      assertEq(res.statusCode, 500);
      assertEq(res.body.error, 'Internal server error');
      assert(/^[0-9a-f]{8}$/.test(res.body.requestId), 'a request id to match the log line');
      assertEq(Object.keys(res.body).sort(), ['error', 'requestId'], 'nothing else leaks');
      assertEq(res.jsonCalls, 1);
      assertEq(logs.length, 1);
      assertEq(logs[0].level, 'error');
      assertEq(logs[0].event, 'unhandled_error');
      assertEq(logs[0].data.error, 'database password leaked');
    });
  });

  await testAsync('wrap does not write a second response after headers were sent', async () => {
    await withStubbedLogger(async (wrap, logs) => {
      const res = makeRes({ headersSent: true });
      const req = { method: 'GET', url: '/late-error' };

      await wrap(async () => { throw new Error('late failure'); })(req, res);

      assertEq(res.statusCode, 200);
      assertEq(res.body, undefined);
      assertEq(res.jsonCalls, 0);
      assertEq(logs.length, 1);
      assertEq(logs[0].level, 'error');
    });
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
