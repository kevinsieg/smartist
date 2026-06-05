'use strict';

const crypto = require('crypto');
const path = require('path');

const { makeRunner } = require('./_runner');

const ARTIST = { id: 7, slug: 'testband', name: 'Test Band', password_hash: '$2b$12$fake' };

function makeRes() {
  const res = { statusCode: 200, headersSent: false, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.headersSent = true; return res; };
  return res;
}

function makeReq(method, url, body = {}) {
  return {
    method,
    url,
    query: { artist: ARTIST.slug },
    headers: { host: 'example.test', authorization: 'Bearer admin-token' },
    body,
  };
}

function installAuthHandler({ sqlFn, emailFn, requireRoleFn } = {}) {
  const dbPath       = require.resolve(path.join(__dirname, '../../api/_db'));
  const authPath     = require.resolve(path.join(__dirname, '../../api/_auth'));
  const tokenPath    = require.resolve(path.join(__dirname, '../../api/_token'));
  const emailPath    = require.resolve(path.join(__dirname, '../../api/_email'));
  const rlPath       = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const loggerPath   = require.resolve(path.join(__dirname, '../../api/_logger'));
  const handlerPath  = require.resolve(path.join(__dirname, '../../api/_handler'));
  const endpointPath = require.resolve(path.join(__dirname, '../../api/[artist]/auth'));

  for (const p of [dbPath, authPath, tokenPath, emailPath, rlPath, loggerPath, handlerPath, endpointPath]) {
    delete require.cache[p];
  }

  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { info: async () => {}, warn: async () => {}, error: async () => {} },
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      getDb: () => sqlFn || (async () => []),
      getArtist: async () => ARTIST,
      getSlug: req => req.query.artist,
    },
  };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      checkCredentials: async () => false,
      requireAuth: async (req) => {
        req.user = { id: 101, role: 'admin' };
        return ARTIST;
      },
      requireRole: requireRoleFn || (() => true),
    },
  };
  require.cache[tokenPath] = {
    id: tokenPath,
    filename: tokenPath,
    loaded: true,
    exports: {
      generateUserToken: () => 'session-token',
      generateMagicToken: () => 'magic-token',
      verifyMagicToken: () => false,
      TTL_8H: 8 * 60 * 60 * 1000,
      TTL_30D: 30 * 24 * 60 * 60 * 1000,
    },
  };
  require.cache[emailPath] = {
    id: emailPath,
    filename: emailPath,
    loaded: true,
    exports: { sendEmail: emailFn || (async () => {}) },
  };
  require.cache[rlPath] = {
    id: rlPath,
    filename: rlPath,
    loaded: true,
    exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
  };

  return require(endpointPath);
}

function sqlText(strings) {
  return Array.from(strings).join('?').replace(/\s+/g, ' ').trim();
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nauth handler invite flows'));

  await testAsync('POST invite rejects malformed email before touching users or email', async () => {
    const sqlCalls = [];
    let sent = false;
    const handler = installAuthHandler({
      sqlFn: async (strings, ...values) => {
        sqlCalls.push({ text: sqlText(strings), values });
        return [];
      },
      emailFn: async () => { sent = true; },
    });
    const res = makeRes();

    await handler(makeReq('POST', '/api/testband/auth?action=invite', {
      email: 'not-an-email',
      role: 'member',
    }), res);

    assertEq(res.statusCode, 400);
    assertEq(res.body, { error: 'Invalid email address' });
    assertEq(sqlCalls.length, 0, 'invalid invite should not query or insert users');
    assertEq(sent, false, 'invalid invite should not send email');
  });

  await testAsync('GET users exposes expired pending invites for admin cleanup', async () => {
    let selectText = '';
    const expiredUser = {
      id: 55,
      email: 'expired@example.com',
      role: 'viewer',
      accepted: false,
      invite_pending: false,
      invite_expired: true,
    };
    const handler = installAuthHandler({
      sqlFn: async (strings) => {
        selectText = sqlText(strings);
        return [expiredUser];
      },
    });
    const res = makeRes();

    await handler(makeReq('GET', '/api/testband/auth'), res);

    assertEq(res.statusCode, 200);
    assert(selectText.includes('invite_expired'), 'users query must include invite_expired projection');
    assertEq(res.body, { users: [expiredUser] });
  });

  await testAsync('POST resend-invite rotates stored token before sending the new link', async () => {
    const events = [];
    let updatedTokenHash = null;
    let sent = null;
    const pendingUser = {
      id: 22,
      email: 'pending@example.com',
      role: 'member',
      password_hash: null,
      invite_token_hash: 'old-token-hash',
    };
    const handler = installAuthHandler({
      sqlFn: async (strings, ...values) => {
        const text = sqlText(strings);
        if (text.startsWith('SELECT * FROM users')) {
          events.push('select-pending-user');
          return [pendingUser];
        }
        if (text.startsWith('UPDATE users SET invite_token_hash')) {
          events.push('update-invite-token');
          updatedTokenHash = values[0];
          assert(values[1] instanceof Date, 'invite expiry should be a Date');
          assertEq(values[2], pendingUser.id);
          return [];
        }
        throw new Error(`unexpected SQL: ${text}`);
      },
      emailFn: async (opts) => {
        events.push('send-email');
        sent = opts;
      },
    });
    const res = makeRes();

    await handler(makeReq('POST', '/api/testband/auth?action=resend-invite', { userId: pendingUser.id }), res);

    assertEq(res.statusCode, 200);
    assertEq(res.body, { ok: true });
    assertEq(events, ['select-pending-user', 'update-invite-token', 'send-email']);
    assert(updatedTokenHash && updatedTokenHash !== pendingUser.invite_token_hash, 'token hash should be rotated');

    const rawToken = new URL(sent.html.match(/href="([^"]+)"/)[1]).searchParams.get('invite');
    const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    assertEq(updatedTokenHash, expectedHash, 'stored invite hash must match emailed link token');
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
