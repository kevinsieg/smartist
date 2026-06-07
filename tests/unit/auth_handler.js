const crypto = require('crypto');
const path = require('path');

const ARTIST = { id: 7, slug: 'testband', name: 'Test Band', password_hash: 'hash' };

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
}

function normalizeSql(strings) {
  return strings.join('?').replace(/\s+/g, ' ').trim();
}

function inviteHash(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function extractInviteToken(html) {
  const match = String(html).match(/invite=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

function makeSql({ users = [], events = [] } = {}) {
  const state = {
    users: users.map(user => ({ ...user })),
    queries: [],
    events,
    nextId: Math.max(0, ...users.map(user => user.id || 0)) + 1,
  };

  async function sql(strings, ...values) {
    const text = normalizeSql(strings);
    state.queries.push({ text, values });

    if (text.startsWith('SELECT id FROM users WHERE artist_id')) {
      state.events.push({ type: 'select-existing-user' });
      const [artistId, email] = values;
      const existing = state.users.find(user => user.artist_id === artistId && user.email === email);
      return existing ? [{ id: existing.id }] : [];
    }

    if (text.startsWith('INSERT INTO users')) {
      state.events.push({ type: 'insert-user' });
      const [artistId, email, role, tokenHash, inviteExpiresAt, invitedBy] = values;
      const user = {
        id: state.nextId++,
        artist_id: artistId,
        email,
        role,
        invite_token_hash: tokenHash,
        invite_expires_at: inviteExpiresAt,
        invited_by: invitedBy,
        password_hash: null,
      };
      state.users.push(user);
      return [{ id: user.id, email: user.email, role: user.role }];
    }

    if (text.startsWith('DELETE FROM users WHERE id')) {
      state.events.push({ type: 'delete-user' });
      const [id] = values;
      const index = state.users.findIndex(user => user.id === id);
      if (index === -1) return [];
      const [deleted] = state.users.splice(index, 1);
      return [{ id: deleted.id }];
    }

    if (text.startsWith('SELECT * FROM users WHERE id')) {
      state.events.push({ type: 'select-pending-invite' });
      const [id, artistId] = values;
      const user = state.users.find(row =>
        row.id === id && row.artist_id === artistId && row.password_hash == null);
      return user ? [{ ...user }] : [];
    }

    if (text.startsWith('UPDATE users SET invite_token_hash')) {
      state.events.push({ type: 'update-invite' });
      const [tokenHash, inviteExpiresAt, id] = values;
      const user = state.users.find(row => row.id === id);
      if (user) {
        user.invite_token_hash = tokenHash;
        user.invite_expires_at = inviteExpiresAt;
      }
      return [];
    }

    if (text.startsWith('SELECT id, email, role, created_at, invite_expires_at')) {
      state.events.push({ type: 'list-users' });
      if (!text.includes('invite_expired') || !text.includes('<= now()')) {
        throw new Error('list users query must expose expired invites');
      }
      const now = Date.now();
      return state.users.map(user => {
        const hasPassword = user.password_hash != null;
        const hasInvite = user.invite_token_hash != null;
        const expiresAt = user.invite_expires_at ? new Date(user.invite_expires_at).getTime() : null;
        return {
          id: user.id,
          email: user.email,
          role: user.role,
          created_at: user.created_at,
          invite_expires_at: user.invite_expires_at,
          accepted: hasPassword,
          invite_pending: hasInvite && !hasPassword && expiresAt > now,
          invite_expired: hasInvite && !hasPassword && expiresAt <= now,
        };
      });
    }

    throw new Error(`Unexpected SQL in auth handler test: ${text}`);
  }

  sql.state = state;
  return sql;
}

async function withAuthHandler({ sql, sendEmail = async () => {}, requireRole = () => true }, fn) {
  const authHandlerPath = require.resolve(path.join(__dirname, '../../api/[artist]/auth'));
  const handlerPath = require.resolve(path.join(__dirname, '../../api/_handler'));
  const dbPath = require.resolve(path.join(__dirname, '../../api/_db'));
  const authPath = require.resolve(path.join(__dirname, '../../api/_auth'));
  const emailPath = require.resolve(path.join(__dirname, '../../api/_email'));
  const rateLimitPath = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const tokenPath = require.resolve(path.join(__dirname, '../../api/_token'));
  const loggerPath = require.resolve(path.join(__dirname, '../../api/_logger'));
  const paths = [authHandlerPath, handlerPath, dbPath, authPath, emailPath, rateLimitPath, tokenPath, loggerPath];
  const originals = new Map(paths.map(p => [p, require.cache[p]]));

  for (const p of paths) delete require.cache[p];

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async slug => (slug === ARTIST.slug ? ARTIST : null),
      getSlug: req => req.query?.artist || req.url.split('?')[0].split('/')[2],
    },
  };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      checkCredentials: async () => false,
      requireAuth: async req => {
        req.user = { id: 99, role: 'admin' };
        return ARTIST;
      },
      requireRole,
    },
  };
  require.cache[emailPath] = {
    id: emailPath,
    filename: emailPath,
    loaded: true,
    exports: { sendEmail },
  };
  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
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
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { info: async () => {}, warn: async () => {}, error: async () => {} },
  };

  try {
    const handler = require(authHandlerPath);
    await fn(handler);
  } finally {
    for (const p of paths) {
      delete require.cache[p];
      const original = originals.get(p);
      if (original) require.cache[p] = original;
    }
  }
}

function authedReq(method, url, body = {}) {
  return {
    method,
    url,
    query: { artist: ARTIST.slug },
    headers: { host: 'localhost:3000' },
    body,
  };
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nauth handler'));

  await testAsync('invite rejects invalid email before user lookup or email send', async () => {
    const events = [];
    const sql = makeSql({ events });

    await withAuthHandler({
      sql,
      sendEmail: async () => { events.push({ type: 'email' }); },
    }, async handler => {
      const res = makeRes();
      await handler(authedReq('POST', '/api/testband/auth?action=invite', {
        email: 'not-an-email',
        role: 'member',
      }), res);

      assertEq(res.statusCode, 400);
      assertEq(res.body, { error: 'Invalid email address' });
      assertEq(sql.state.queries.length, 0);
      assertEq(events, []);
    });
  });

  await testAsync('invite rolls back inserted pending user when email delivery fails', async () => {
    const events = [];
    const sql = makeSql({ events });

    await withAuthHandler({
      sql,
      sendEmail: async () => {
        events.push({ type: 'email' });
        throw new Error('SMTP unavailable');
      },
    }, async handler => {
      const res = makeRes();
      await handler(authedReq('POST', '/api/testband/auth?action=invite', {
        email: 'new.user@example.com',
        role: 'viewer',
      }), res);

      assertEq(res.statusCode, 500);
      assertEq(res.body, { error: 'Failed to send invite email' });
      assertEq(sql.state.users, []);
      assertEq(events.map(e => e.type), ['select-existing-user', 'insert-user', 'email', 'delete-user']);
    });
  });

  await testAsync('resend-invite stores the new token hash before sending the new link', async () => {
    const events = [];
    const oldHash = inviteHash('old-token');
    const sql = makeSql({
      events,
      users: [{
        id: 42,
        artist_id: ARTIST.id,
        email: 'pending@example.com',
        role: 'member',
        invite_token_hash: oldHash,
        invite_expires_at: new Date(Date.now() + 1000),
        password_hash: null,
      }],
    });

    await withAuthHandler({
      sql,
      sendEmail: async email => { events.push({ type: 'email', email }); },
    }, async handler => {
      const res = makeRes();
      await handler(authedReq('POST', '/api/testband/auth?action=resend-invite', {
        userId: 42,
      }), res);

      const pendingUser = sql.state.users.find(user => user.id === 42);
      const sent = events.find(e => e.type === 'email');
      const rawToken = extractInviteToken(sent?.email?.html);

      assertEq(res.statusCode, 200);
      assertEq(res.body, { ok: true });
      assert(rawToken, 'expected invite token in reminder email');
      assert(pendingUser.invite_token_hash !== oldHash, 'expected token hash to be rotated');
      assertEq(pendingUser.invite_token_hash, inviteHash(rawToken));
      assert(events.findIndex(e => e.type === 'update-invite') < events.findIndex(e => e.type === 'email'),
        'expected DB token update before email send');
    });
  });

  await testAsync('GET auth lists expired pending invites so admins can revoke them', async () => {
    const sql = makeSql({
      users: [
        {
          id: 1,
          artist_id: ARTIST.id,
          email: 'active@example.com',
          role: 'admin',
          password_hash: 'hash',
        },
        {
          id: 2,
          artist_id: ARTIST.id,
          email: 'pending@example.com',
          role: 'member',
          invite_token_hash: inviteHash('pending'),
          invite_expires_at: new Date(Date.now() + 60 * 1000),
          password_hash: null,
        },
        {
          id: 3,
          artist_id: ARTIST.id,
          email: 'expired@example.com',
          role: 'viewer',
          invite_token_hash: inviteHash('expired'),
          invite_expires_at: new Date(Date.now() - 60 * 1000),
          password_hash: null,
        },
      ],
    });

    await withAuthHandler({ sql }, async handler => {
      const res = makeRes();
      await handler(authedReq('GET', '/api/testband/auth'), res);

      assertEq(res.statusCode, 200);
      const expired = res.body.users.find(user => user.email === 'expired@example.com');
      const pending = res.body.users.find(user => user.email === 'pending@example.com');
      assertEq(expired.invite_expired, true);
      assertEq(expired.invite_pending, false);
      assertEq(pending.invite_pending, true);
      assertEq(pending.invite_expired, false);
    });
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
