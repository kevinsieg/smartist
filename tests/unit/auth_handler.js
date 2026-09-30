'use strict';
const crypto = require('crypto');
const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

const ROLE_ORDER = ['viewer', 'member', 'admin'];
const ARTIST = { id: 7, slug: 'test', name: 'Test Band', password_hash: 'artist-hash' };

// Last mail the stubbed _email captured; reset per makeHandler so it cannot leak
// between tests.
let sentMail = null;

function roleAllowed(userRole, minRole) {
  return ROLE_ORDER.indexOf(userRole || 'viewer') >= ROLE_ORDER.indexOf(minRole);
}

function makeSqlStub(responders = []) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    const responder = responders.find(({ match }) => match(text, values));
    return responder ? responder.rows(text, values) : [];
  };
  sql.calls = calls;
  return sql;
}

// `tokens` overrides individual _token exports. The defaults below are what
// every pre-existing test in this file expects; the password-reset tests need
// real verification behaviour, so they pass their own.
function makeHandler({ sql, user = { id: 1, role: 'admin' }, artist = ARTIST, authFails = false, tokens = {} } = {}) {
  const dbPath       = require.resolve(path.join(__dirname, '../../api/_db'));
  const authPath     = require.resolve(path.join(__dirname, '../../api/_auth'));
  const tokenPath    = require.resolve(path.join(__dirname, '../../api/_token'));
  const emailPath    = require.resolve(path.join(__dirname, '../../api/_email'));
  const rlPath       = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const bcryptPath   = require.resolve('bcryptjs');
  const handlerPath  = require.resolve(path.join(__dirname, '../../api/_handler'));
  const apiAuthPath  = require.resolve(path.join(__dirname, '../../api/_band/auth'));

  delete require.cache[apiAuthPath];
  delete require.cache[handlerPath];

  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql || makeSqlStub(),
      getArtist: async () => artist,
      getSlug: req => req.query?.artist || req.url.split('?')[0].split('/')[2],
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { refuseDemo: (req, res) => { if (req.user && req.user.id === null) { res.status(403).json({ error: 'demo' }); return true; } return false; },
      requireAuth: async (req, res) => {
        // authFails mirrors the real helper: it writes 401 and returns null, so any branch
        // placed after the gate becomes unreachable without a session.
        if (authFails) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        req.user = user;
        return artist;
      },
      requireRole: (req, res, minRole) => {
        if (roleAllowed(req.user?.role, minRole)) return true;
        res.status(403).json({ error: 'Forbidden' });
        return false;
      },
    },
  };
  require.cache[tokenPath] = {
    id: tokenPath, filename: tokenPath, loaded: true,
    exports: Object.assign({
      generateMagicToken: () => 'magic-token',
      verifyMagicToken: () => false,
      generateUserToken: (userId, role, ttl) => `session:${userId}:${role}:${ttl}`,
      verifyUserToken: () => null,
      passwordlessSeed: (id) => `passwordless-seed-for-${id}`,
      TTL_8H: 28800000,
      TTL_30D: 2592000000,
    }, tokens),
  };
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendEmail: async (mail) => { sentMail = mail; } },
  };
  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { loginLocked: async () => false, countLoginFailure: async () => {}, checkRateLimit: async () => false, clientIp: () => '127.0.0.1', isMissingRateLimitTable: () => false },
  };
  require.cache[bcryptPath] = {
    id: bcryptPath, filename: bcryptPath, loaded: true,
    exports: {
      hash: async (password, cost) => `hashed:${password}:${cost}`,
      compare: async (plain) => plain === 'correct-password',
    },
  };

  sentMail = null;
  return require(path.join(__dirname, '../../api/_band/auth'));
}

function mockRes() {
  const r = { statusCode: 200, headersSent: false };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (b) => { r._body = b; r.headersSent = true; return r; };
  return r;
}

function authReq(method, url, body, headers = {}) {
  return { method, url, query: { artist: 'test' }, body, headers };
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nauth handler'));

  await testAsync('POST accept-invite succeeds, hashes password, and consumes invite token', async () => {
    const rawToken = 'invite-token';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const inviteUser = { id: 42, email: 'new@example.com', role: 'member' };
    let updated = null;
    const sql = makeSqlStub([
      {
        match: text => text.includes('SELECT * FROM users') && text.includes('invite_token_hash'),
        rows: (_text, values) => {
          assertEq(values[0], ARTIST.id, 'artist id scoped in invite lookup');
          assertEq(values[1], tokenHash, 'raw invite token is hashed before lookup');
          return [inviteUser];
        },
      },
      {
        match: text => text.includes('UPDATE users') && text.includes('SET password_hash'),
        rows: (_text, values) => {
          updated = { passwordHash: values[0], userId: values[1] };
          return [];
        },
      },
    ]);
    const handler = makeHandler({ sql });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=accept-invite', {
      token: rawToken,
      password: 'long-enough',
    }), res);

    assertEq(res.statusCode, 200);
    assertEq(res._body, {
      ok: true,
      token: 'session:42:member:28800000',
      role: 'member',
      email: 'new@example.com',
      artists: [],
    });
    assertEq(updated, { passwordHash: 'hashed:long-enough:12', userId: 42 });
    assert(sql.calls.some(call => call.text.includes('invite_expires_at > now()')), 'invite lookup must reject expired tokens');
    assert(sql.calls.some(call => call.text.includes('password_hash IS NULL')), 'invite lookup must only accept unused invites');
  });

  await testAsync('POST accept-invite rejects expired or already-used invite without updating user', async () => {
    const sql = makeSqlStub([
      {
        match: text => text.includes('SELECT * FROM users') && text.includes('invite_token_hash'),
        rows: () => [],
      },
      {
        match: text => text.includes('UPDATE users') && text.includes('SET password_hash'),
        rows: () => { throw new Error('password update should not run for invalid invite'); },
      },
    ]);
    const handler = makeHandler({ sql });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=accept-invite', {
      token: 'expired-token',
      password: 'long-enough',
    }), res);

    assertEq(res.statusCode, 400);
    assertEq(res._body, { error: 'Invalid or expired invite' });
    assertEq(sql.calls.filter(call => call.text.includes('UPDATE users')).length, 0);
  });

  await testAsync('GET /auth requires admin role before listing users', async () => {
    const sql = makeSqlStub([
      {
        match: text => text.includes('FROM users WHERE artist_id'),
        rows: () => { throw new Error('member must not reach user listing query'); },
      },
    ]);
    const handler = makeHandler({ sql, user: { id: 2, role: 'member' } });
    const res = mockRes();

    await handler(authReq('GET', '/api/test/auth', undefined, { authorization: 'Bearer member' }), res);

    assertEq(res.statusCode, 403);
    assertEq(res._body, { error: 'Forbidden' });
    assertEq(sql.calls.length, 0);
  });

  await testAsync('PUT /auth refuses to change the current admin role', async () => {
    const sql = makeSqlStub([
      {
        match: text => text.includes('UPDATE users SET role'),
        rows: () => { throw new Error('self role update should not run'); },
      },
    ]);
    const handler = makeHandler({ sql, user: { id: 42, role: 'admin' } });
    const res = mockRes();

    await handler(authReq('PUT', '/api/test/auth', { userId: 42, role: 'viewer' }, {
      authorization: 'Bearer admin',
    }), res);

    assertEq(res.statusCode, 400);
    assertEq(res._body, { error: 'Cannot change your own role' });
    assertEq(sql.calls.length, 0);
  });

  // Email is the cross-workspace identity (resolveUser joins users on email), so
  // an admin setting a member's email to someone else's would hijack that account.
  await testAsync('PUT /auth rejects an email change without updating the user', async () => {
    const sql = makeSqlStub();
    const handler = makeHandler({ sql, user: { id: 1, role: 'admin' } });
    const res = mockRes();

    await handler(authReq('PUT', '/api/test/auth', { userId: 42, email: 'victim@example.com' }, {
      authorization: 'Bearer admin',
    }), res);

    assertEq(res.statusCode, 400);
    assertEq(sql.calls.filter(call => call.text.includes('UPDATE users')).length, 0);
  });

  await testAsync('PUT /auth rejects an email smuggled alongside a role change', async () => {
    const sql = makeSqlStub();
    const handler = makeHandler({ sql, user: { id: 1, role: 'admin' } });
    const res = mockRes();

    await handler(authReq('PUT', '/api/test/auth', { userId: 42, role: 'member', email: 'victim@example.com' }, {
      authorization: 'Bearer admin',
    }), res);

    assertEq(res.statusCode, 400);
    assertEq(sql.calls.filter(call => call.text.includes('UPDATE users')).length, 0);
  });

  await testAsync('DELETE /auth refuses to remove the current admin user', async () => {
    const sql = makeSqlStub([
      {
        match: text => text.includes('DELETE FROM users'),
        rows: () => { throw new Error('self delete should not run'); },
      },
    ]);
    const handler = makeHandler({ sql, user: { id: 42, role: 'admin' } });
    const res = mockRes();

    await handler(authReq('DELETE', '/api/test/auth', { userId: 42 }, {
      authorization: 'Bearer admin',
    }), res);

    assertEq(res.statusCode, 400);
    assertEq(res._body, { error: 'Cannot remove yourself' });
    assertEq(sql.calls.length, 0);
  });

  // The confirmation link is clicked from an inbox, so there is no session. The branch
  // must sit before the requireAuth gate or the whole email change is unreachable.
  await testAsync('POST confirm-email-change answers without a session', async () => {
    const sql = makeSqlStub();
    const handler = makeHandler({ sql, authFails: true });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=confirm-email-change', {}), res);

    assertEq(res.statusCode, 400);
    assertEq(res._body, { error: 'token required' });
  });

  await testAsync('POST confirm-email-change rejects an unknown token without a session', async () => {
    const sql = makeSqlStub([
      { match: text => text.includes('SELECT id, email, pending_email FROM users'), rows: () => [] },
    ]);
    const handler = makeHandler({ sql, authFails: true });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=confirm-email-change', { token: 'e'.repeat(64) }), res);

    assertEq(res.statusCode, 400);
    assertEq(res._body, { error: 'Invalid or expired link' });
  });

  await testAsync('POST request-email-change rejects a wrong current password', async () => {
    const sql = makeSqlStub([
      { match: text => text.includes('SELECT * FROM users'), rows: () => [{ id: 7, email: 'old@example.com', password_hash: 'stored-hash' }] },
      { match: text => text.includes('UPDATE users'), rows: () => { throw new Error('must not write on a bad password'); } },
    ]);
    const handler = makeHandler({ sql, user: { id: 7, role: 'member' } });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=request-email-change', {
      currentPassword: 'wrong-password', newEmail: 'new@example.com',
    }, { authorization: 'Bearer member' }), res);

    assertEq(res.statusCode, 401);
    assertEq(sql.calls.filter(c => c.text.includes('UPDATE users')).length, 0);
  });

  await testAsync('POST request-email-change rejects a bootstrap login', async () => {
    const sql = makeSqlStub();
    const handler = makeHandler({ sql, user: { id: null, role: 'admin' } });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=request-email-change', {
      currentPassword: 'whatever', newEmail: 'new@example.com',
    }, { authorization: 'Bearer band' }), res);

    assertEq(res.statusCode, 400);
    assertEq(sql.calls.filter(c => c.text.includes('UPDATE users')).length, 0);
  });

  await testAsync('POST request-email-change rejects an invalid address', async () => {
    const sql = makeSqlStub();
    const handler = makeHandler({ sql, user: { id: 7, role: 'member' } });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=request-email-change', {
      currentPassword: 'correct-password', newEmail: 'not-an-email',
    }, { authorization: 'Bearer member' }), res);

    assertEq(res.statusCode, 400);
  });

  await testAsync('POST request-email-change stores a token hash, never the raw token, and mails the new address', async () => {
    let written = null;
    const sql = makeSqlStub([
      { match: text => text.includes('SELECT * FROM users'), rows: () => [{ id: 7, email: 'old@example.com', password_hash: 'stored-hash' }] },
      {
        match: text => text.includes('UPDATE users') && text.includes('pending_email'),
        rows: (_text, values) => { written = values; return []; },
      },
    ]);
    const handler = makeHandler({ sql, user: { id: 7, role: 'member' } });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=request-email-change', {
      currentPassword: 'correct-password', newEmail: 'New@Example.com',
    }, { authorization: 'Bearer member' }), res);

    assertEq(res.statusCode, 200);
    assertEq(res._body, { ok: true });
    assertEq(written[0], 'new@example.com');
    assert(/^[0-9a-f]{64}$/.test(written[1]), 'must store a sha256 hex hash');
    assert(new Date(written[2]).getTime() > Date.now(), 'expiry must be in the future');
    assert(sentMail && sentMail.to === 'new@example.com', 'confirmation mail goes to the NEW address');
    assert(!sentMail.html.includes(written[1]), 'the mail must carry the raw token, not the stored hash');
  });

  await testAsync('POST confirm-email-change previews the affected bands without writing', async () => {
    const rawToken  = 'a'.repeat(64);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const sql = makeSqlStub([
      {
        match: text => text.includes('email_change_token_hash'),
        rows: (_text, values) => {
          assertEq(values[0], tokenHash, 'lookup must hash the raw token');
          return [{ id: 7, email: 'old@example.com', pending_email: 'new@example.com' }];
        },
      },
      {
        match: text => text.includes('JOIN artists a'),
        rows: () => [
          { slug: 'band-a', name: 'Band A', role: 'admin' },
          { slug: 'band-b', name: 'Band B', role: 'member' },
        ],
      },
      { match: text => text.includes('UPDATE users'), rows: () => { throw new Error('preview must not write'); } },
    ]);
    const handler = makeHandler({ sql });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=confirm-email-change', { token: rawToken }), res);

    assertEq(res.statusCode, 200);
    assertEq(res._body, {
      newEmail: 'new@example.com',
      bands: [
        { slug: 'band-a', name: 'Band A', role: 'admin' },
        { slug: 'band-b', name: 'Band B', role: 'member' },
      ],
    });
    assertEq(sql.calls.filter(c => c.text.includes('UPDATE users')).length, 0);
  });

  await testAsync('POST confirm-email-change rejects an unknown or expired token', async () => {
    const sql = makeSqlStub([
      { match: text => text.includes('email_change_token_hash'), rows: () => [] },
    ]);
    const handler = makeHandler({ sql });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=confirm-email-change', { token: 'b'.repeat(64) }), res);

    assertEq(res.statusCode, 400);
    assertEq(res._body, { error: 'Invalid or expired link' });
  });

  await testAsync('POST confirm-email-change applies to every band and clears the token', async () => {
    const rawToken = 'c'.repeat(64);
    const sql = makeSqlStub([
      {
        match: text => text.includes('email_change_token_hash') && text.includes('SELECT'),
        rows: () => [{ id: 7, email: 'old@example.com', pending_email: 'new@example.com' }],
      },
      { match: text => text.includes('JOIN artists a'), rows: () => [{ slug: 'band-a', name: 'Band A', role: 'admin' }] },
      { match: text => text.includes('SELECT 1 FROM users'), rows: () => [] },
    ]);
    sql.begin = async fn => fn(sql);
    const handler = makeHandler({ sql });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=confirm-email-change', { token: rawToken, confirm: true }), res);

    assertEq(res.statusCode, 200);
    assertEq(res._body, { ok: true, email: 'new@example.com' });
    const rewrite = sql.calls.find(c => c.text.includes('SET email'));
    assert(rewrite, 'must rewrite the email');
    assertEq(rewrite.values, ['new@example.com', 'old@example.com']);
    assert(sql.calls.some(c => c.text.includes('email_change_token_hash = NULL')), 'must clear the pending columns');
    assert(sentMail && sentMail.to === 'old@example.com', 'notice goes to the OLD address');
  });

  await testAsync('POST confirm-email-change refuses an address already used in an affected band', async () => {
    const rawToken = 'd'.repeat(64);
    const sql = makeSqlStub([
      {
        match: text => text.includes('email_change_token_hash') && text.includes('SELECT'),
        rows: () => [{ id: 7, email: 'old@example.com', pending_email: 'taken@example.com' }],
      },
      { match: text => text.includes('JOIN artists a'), rows: () => [{ slug: 'band-a', name: 'Band A', role: 'admin' }] },
      { match: text => text.includes('SELECT 1 FROM users'), rows: () => [{ '?column?': 1 }] },
      { match: text => text.includes('SET email'), rows: () => { throw new Error('must not rewrite on collision'); } },
    ]);
    sql.begin = async fn => fn(sql);
    const handler = makeHandler({ sql });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=confirm-email-change', { token: rawToken, confirm: true }), res);

    assertEq(res.statusCode, 409);
    assertEq(sql.calls.filter(c => c.text.includes('SET email')).length, 0);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
