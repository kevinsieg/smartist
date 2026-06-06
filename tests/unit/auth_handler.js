'use strict';
const crypto = require('crypto');
const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

const ROLE_ORDER = ['viewer', 'member', 'admin'];
const ARTIST = { id: 7, slug: 'test', name: 'Test Band', password_hash: 'artist-hash' };

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

function makeHandler({ sql, user = { id: 1, role: 'admin' }, artist = ARTIST } = {}) {
  const dbPath       = require.resolve(path.join(__dirname, '../../api/_db'));
  const authPath     = require.resolve(path.join(__dirname, '../../api/_auth'));
  const tokenPath    = require.resolve(path.join(__dirname, '../../api/_token'));
  const emailPath    = require.resolve(path.join(__dirname, '../../api/_email'));
  const rlPath       = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const bcryptPath   = require.resolve('bcryptjs');
  const handlerPath  = require.resolve(path.join(__dirname, '../../api/_handler'));
  const apiAuthPath  = require.resolve(path.join(__dirname, '../../api/[artist]/auth'));

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
    exports: {
      checkCredentials: async () => false,
      requireAuth: async (req, res) => {
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
    exports: {
      generateMagicToken: () => 'magic-token',
      verifyMagicToken: () => false,
      generateUserToken: (userId, role, ttl) => `session:${userId}:${role}:${ttl}`,
      verifyUserToken: () => null,
      TTL_8H: 28800000,
      TTL_30D: 2592000000,
    },
  };
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendEmail: async () => {} },
  };
  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1', isMissingRateLimitTable: () => false },
  };
  require.cache[bcryptPath] = {
    id: bcryptPath, filename: bcryptPath, loaded: true,
    exports: {
      hash: async (password, cost) => `hashed:${password}:${cost}`,
      compare: async () => false,
    },
  };

  return require(path.join(__dirname, '../../api/[artist]/auth'));
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
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
