'use strict';

// The account modules in api/_domain take plain input and return a result;
// api/_domain/http.js is the only code that reads a request or writes a reply.

const path = require('path');
const { makeRunner } = require('./_runner');

function mockRes() {
  const r = { headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status    = c => { r.code = c; return r; };
  r.json      = b => { r.body = b; return r; };
  r.redirect  = (c, u) => { r.code = c; r.location = u; return r; };
  return r;
}

async function run(r) {
  const { testAsync, test, assertEq, B } = r;
  const httpPath = path.join(__dirname, '../../api/_domain/http');
  // Earlier suites stub _ratelimit (and its clientIp); load the real ones.
  delete require.cache[require.resolve(httpPath)];
  delete require.cache[require.resolve(path.join(__dirname, '../../api/_ratelimit'))];
  const { toInput, send, handle, ok, fail } = require(httpPath);

  console.log(B('\ndomain http adapter'));

  test('toInput carries body, query, headers, the client ip and the origin', () => {
    const saved = process.env.APP_ORIGIN;
    delete process.env.APP_ORIGIN;
    try {
      const input = toInput({ body: { a: 1 }, query: { q: 'x' },
        headers: { host: 'band.example.test', 'x-real-ip': '10.0.0.1' } });
      assertEq(input.body, { a: 1 });
      assertEq(input.query, { q: 'x' });
      assertEq(input.ip, '10.0.0.1');
      assertEq(input.origin, 'https://band.example.test');
    } finally { if (saved !== undefined) process.env.APP_ORIGIN = saved; }
  });

  test('a missing body or query arrives as an empty object', () => {
    const input = toInput({ headers: {} });
    assertEq(input.body, {});
    assertEq(input.query, {});
  });

  test('send writes a JSON result with its status', () => {
    const res = mockRes();
    send(res, fail(429, 'slow down', { retry: 1 }));
    assertEq(res.code, 429);
    assertEq(res.body, { error: 'slow down', retry: 1 });
  });

  test('send writes headers, then redirects', () => {
    const res = mockRes();
    send(res, { status: 302, redirect: 'https://x.test/login', headers: { 'Set-Cookie': 'n=; Max-Age=0' } });
    assertEq(res.code, 302);
    assertEq(res.location, 'https://x.test/login');
    assertEq(res.headers['Set-Cookie'], 'n=; Max-Age=0');
  });

  await testAsync('handle turns a domain function into a (req, res) handler', async () => {
    const res = mockRes();
    await handle(async ({ body }) => ok({ echo: body.v }))({ body: { v: 7 }, headers: {} }, res);
    assertEq(res.code, 200);
    assertEq(res.body, { echo: 7 });
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
