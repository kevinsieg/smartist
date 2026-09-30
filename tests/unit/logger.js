'use strict';

// api/_logger.js: email addresses are redacted before an entry leaves the
// process, and production entries are sent in one batch per request.

const path = require('path');
const { makeRunner } = require('./_runner');

const LOGGER = path.join(__dirname, '../../api/_logger');

function freshLogger(env) {
  const saved = process.env.VERCEL_ENV;
  if (env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = env;
  delete require.cache[require.resolve(LOGGER)];
  const logger = require(LOGGER);
  if (saved === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved;
  return logger;
}

async function run(r) {
  const { test, testAsync, assert, assertEq, B } = r;
  console.log(B('\nlogger'));

  test('email addresses are replaced by a hash and the domain', () => {
    const { redact } = freshLogger('preview');
    const out = redact({ to: 'Jane.Doe@example.org', note: 'mail a@b.co and c@d.de', n: 3 });
    assert(!JSON.stringify(out).includes('Jane.Doe'), 'address leaked');
    assert(/^[0-9a-f]{12}@example\.org$/.test(out.to), `got ${out.to}`);
    assert(/^mail [0-9a-f]{12}@b\.co and [0-9a-f]{12}@d\.de$/.test(out.note), `got ${out.note}`);
    assertEq(out.n, 3);
    assertEq(redact({ to: 'JANE.DOE@example.org' }).to, out.to, 'case-insensitive, so it can be matched');
  });

  await testAsync('production: entries are buffered and sent in one request on flush', async () => {
    const logger = freshLogger('production');
    const sent = [];
    const realFetch = global.fetch, realLog = console.log, token = process.env.BETTERSTACK_TOKEN;
    global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { status: 202 }; };
    console.log = () => {};
    process.env.BETTERSTACK_TOKEN = 't';
    try {
      await logger.withContext({ requestId: 'abc12345' }, async () => {
        await logger.info('one', { to: 'x@y.com' });
        await logger.warn('two');
        assertEq(sent.length, 0, 'nothing sent before flush');
        await logger.flush();
        assertEq(sent.length, 1);
        assertEq(sent[0].map(e => e.event), ['one', 'two']);
        assert(sent[0].every(e => e.requestId === 'abc12345'), 'request id on every entry');
        assert(!JSON.stringify(sent).includes('x@y.com'), 'address leaked');
        await logger.flush();
        assertEq(sent.length, 1, 'an empty buffer sends nothing');
      });
    } finally {
      global.fetch = realFetch; console.log = realLog;
      if (token === undefined) delete process.env.BETTERSTACK_TOKEN; else process.env.BETTERSTACK_TOKEN = token;
      delete require.cache[require.resolve(LOGGER)];
    }
  });

  await testAsync('production: requests in flight together each send only their own lines', async () => {
    const logger = freshLogger('production');
    const sent = [];
    const realFetch = global.fetch, realLog = console.log, token = process.env.BETTERSTACK_TOKEN;
    global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { status: 202 }; };
    console.log = () => {};
    process.env.BETTERSTACK_TOKEN = 't';
    try {
      let releaseA;
      const aWaits = new Promise(r => { releaseA = r; });
      const a = logger.withContext({ requestId: 'aaaaaaaa' }, async () => {
        await logger.info('a1');
        await aWaits;
        await logger.flush();
      });
      await logger.withContext({ requestId: 'bbbbbbbb' }, async () => {
        await logger.info('b1');
        await logger.flush();
      });
      releaseA();
      await a;
      assertEq(sent.length, 2);
      assertEq(sent[0].map(e => e.requestId), ['bbbbbbbb']);
      assertEq(sent[1].map(e => e.requestId), ['aaaaaaaa']);
    } finally {
      global.fetch = realFetch; console.log = realLog;
      if (token === undefined) delete process.env.BETTERSTACK_TOKEN; else process.env.BETTERSTACK_TOKEN = token;
      delete require.cache[require.resolve(LOGGER)];
    }
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
