const path = require('path');
const crypto = require('crypto');

process.env.APP_SECRET           = process.env.APP_SECRET           || 'unit-test-secret-32-bytes-okayy!';
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
process.env.FACEBOOK_APP_ID      = process.env.FACEBOOK_APP_ID      || 'test-fb-id';
process.env.FACEBOOK_APP_SECRET  = process.env.FACEBOOK_APP_SECRET  || 'test-fb-secret';

const { generateUserToken, TTL_8H } = require(path.join(__dirname, '../../api/_token'));

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  function makeHandler(sqlFn, emailFn, artistConfig = {}) {
    const dbPath     = require.resolve(path.join(__dirname, '../../api/_db'));
    const rlPath     = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
    const emailPath  = require.resolve(path.join(__dirname, '../../api/_email'));
    const configPath = require.resolve(path.join(__dirname, '../../api/_config'));

    const tokenPath = require.resolve(path.join(__dirname, '../../api/_token'));
    const authPath  = require.resolve(path.join(__dirname, '../../api/_auth'));
    delete require.cache[dbPath];
    // _auth destructures _db at load time (and other suites stub it outright),
    // so rebuild it against the _db stub below.
    delete require.cache[authPath];
    delete require.cache[configPath];
    delete require.cache[tokenPath];
    // config.js delegates to every module under api/_domain — bust them all so a
    // re-require rebuilds the whole chain against the stubs set below.
    const domainDir = path.join(__dirname, '../../api/_domain');
    require('fs').readdirSync(domainDir).filter(f => f.endsWith('.js')).forEach(function(f) {
      try { delete require.cache[require.resolve(path.join(domainDir, f))]; } catch {}
    });

    require.cache[rlPath] = {
      id: rlPath, filename: rlPath, loaded: true,
      exports: { loginLocked: async () => false, countLoginFailure: async () => {}, checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
    };
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: {
        getDb:     () => sqlFn,
        getArtist: async (slug) => ({ id: 1, slug, name: 'Test', config: artistConfig, password_hash: 'hash' }),
        getSlug:   (req) => (req.query && req.query.artist) || 'test',
      },
    };
    require.cache[emailPath] = {
      id: emailPath, filename: emailPath, loaded: true,
      exports: { sendEmail: emailFn || (async () => {}) },
    };

    return require(path.join(__dirname, '../../api/_config'));
  }

  function mockRes() {
    const res = { _status: 200, _redirected: null };
    res.status    = (s) => { res._status = s; return res; };
    res.json      = (b) => { res._body = b; return res; };
    res.setHeader = () => res;
    res.redirect  = (code, url) => { res._status = code; res._redirected = url; return res; };
    return res;
  }

  // ── POST ?action=signup-link ────────────────────────────────────────────────
  console.log(B('\nPOST ?action=signup-link'));

  await testAsync('missing email → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup-link' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('invalid email → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup-link', email: 'notvalid' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  // gmail.com: real MX lookup passes online; DNS failure fails open offline.
  // (example.com would be rejected — it publishes a null MX.)
  await testAsync('valid email → 200 + ok:true + email sent', async () => {
    let emailSent = false;
    const handler = makeHandler(async () => [], async () => { emailSent = true; });
    const res = mockRes();
    await handler({
      method: 'POST',
      body: { action: 'signup-link', email: 'test@gmail.com' },
      headers: { host: 'localhost:3000' },
    }, res);
    assertEq(res._status, 200);
    assertEq(res._body && res._body.ok, true);
    assert(emailSent, 'expected signup email to be sent');
  });

  await testAsync('disposable email domain → 400 + no email', async () => {
    let emailSent = false;
    const handler = makeHandler(async () => [], async () => { emailSent = true; });
    const res = mockRes();
    await handler({
      method: 'POST',
      body: { action: 'signup-link', email: 'bot@mailinator.com' },
      headers: { host: 'localhost:3000' },
    }, res);
    assertEq(res._status, 400);
    assert(!emailSent, 'expected NO email for disposable domain');
  });

  await testAsync('existing account → 200 + login email instead of setup link', async () => {
    let sentMail = null;
    let signupTokenStored = false;
    const sql = async function(strings) {
      const q = String(strings[0]);
      if (q.includes('FROM users')) return [{ id: 7, email: 'old@gmail.com', password_hash: '$2b$12$hash', slug: 'old-band' }];
      if (q.includes('INSERT INTO subscribers')) signupTokenStored = true;
      return [];
    };
    const handler = makeHandler(sql, async (mail) => { sentMail = mail; });
    const res = mockRes();
    await handler({
      method: 'POST',
      body: { action: 'signup-link', email: 'old@gmail.com' },
      headers: { host: 'localhost:3000' },
    }, res);
    assertEq(res._status, 200);
    assertEq(res._body && res._body.ok, true);
    assert(sentMail, 'expected an email to be sent');
    assert(/already/i.test(sentMail.subject || '') || /already/i.test(sentMail.html || ''), 'expected already-have-account email');
    assert(!/onboarding/.test(sentMail.html || ''), 'must NOT contain a workspace-setup link');
    assert(/\/login/.test(sentMail.html || ''), 'expected a login link');
    // The login page finds the workspace to redeem the link at from `next`.
    assert(/next=%2Fold-band%2Fdashboard/.test(sentMail.html || ''), 'expected the link to name the workspace');
    assert(!signupTokenStored, 'must not store a signup token for existing accounts');
  });

  await testAsync('honeypot field filled → fake 200, no email sent', async () => {
    let emailSent = false;
    const handler = makeHandler(async () => [], async () => { emailSent = true; });
    const res = mockRes();
    await handler({
      method: 'POST',
      body: { action: 'signup-link', email: 'bot@gmail.com', website: 'http://spam.example' },
      headers: { host: 'localhost:3000' },
    }, res);
    assertEq(res._status, 200);
    assertEq(res._body && res._body.ok, true);
    assert(!emailSent, 'expected NO email when honeypot is filled');
  });

  // ── POST ?action=verify-signup-token ────────────────────────────────────────
  console.log(B('\nPOST ?action=verify-signup-token'));

  await testAsync('missing token → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'verify-signup-token' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('unknown token → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'verify-signup-token', token: 'deadbeef' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('valid token → 200 + { ok:true, email }', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sql = async function(strings) {
      if (String(strings[0]).includes('SELECT email')) {
        return [{ email: 'user@test.com', signup_token_hash: hash, signup_token_expires: expires }];
      }
      return [];
    };
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'verify-signup-token', token: rawToken }, headers: {} }, res);
    assertEq(res._status, 200);
    assertEq(res._body && res._body.ok, true);
    assertEq(res._body && res._body.email, 'user@test.com');
  });

  // ── POST ?action=signup ─────────────────────────────────────────────────────
  console.log(B('\nPOST ?action=signup'));

  await testAsync('missing token → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', name: 'My Band', slug: 'my-band' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('invalid slug format → 400', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sql = async function(strings) {
      if (String(strings[0]).includes('SELECT email')) {
        return [{ email: 'u@t.com', signup_token_hash: hash, signup_token_expires: expires }];
      }
      return [];
    };
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', token: rawToken, name: 'My Band', slug: 'MY BAND!!' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('taken slug → 409', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sql = async function(strings) {
      const q = String(strings[0]);
      if (q.includes('SELECT email'))  return [{ email: 'u@t.com', signup_token_hash: hash, signup_token_expires: expires }];
      if (q.includes('EXISTS'))        return [{ exists: true }];  // slug taken
      return [];
    };
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', token: rawToken, name: 'My Band', slug: 'taken-slug' }, headers: {} }, res);
    assertEq(res._status, 409);
  });

  await testAsync('valid signup → 201 + { ok, token, slug }', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sql = async function(strings) {
      const q = String(strings[0]);
      if (q.includes('SELECT email'))       return [{ email: 'u@t.com', signup_token_hash: hash, signup_token_expires: expires }];
      if (q.includes('EXISTS'))             return [{ exists: false }];  // slug available
      if (q.includes('INSERT INTO artists')) return [{ id: 10 }];
      if (q.includes('INSERT INTO users'))   return [{ id: 20 }];
      return [];
    };
    sql.begin = async fn => fn(sql);
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', token: rawToken, name: 'My Band', slug: 'my-band' }, headers: {} }, res);
    assertEq(res._status, 201);
    assertEq(res._body && res._body.ok, true);
    assertEq(res._body && res._body.slug, 'my-band');
    assert(typeof (res._body && res._body.token) === 'string', 'expected session token string');
  });

  // ── GET ?action=check-slug ──────────────────────────────────────────────────
  console.log(B('\nGET ?action=check-slug'));

  await testAsync('available slug → { available: true }', async () => {
    const sql = async () => [{ exists: false }];
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'new-band' }, headers: {} }, res);
    assertEq(res._body && res._body.available, true);
  });

  await testAsync('taken slug → { available: false }', async () => {
    const sql = async () => [{ exists: true }];
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'taken-band' }, headers: {} }, res);
    assertEq(res._body && res._body.available, false);
  });

  await testAsync('reserved slug "login" → { available: false }', async () => {
    const sql = async () => [{ exists: false }];
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'login' }, headers: {} }, res);
    assertEq(res._body && res._body.available, false);
  });

  // ── GET ?action=my-artists ──────────────────────────────────────────────────
  console.log(B('\nGET ?action=my-artists'));

  await testAsync('no token → 401', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'my-artists' }, headers: {} }, res);
    assertEq(res._status, 401);
  });

  await testAsync('valid token → 200 + artists array', async () => {
    const token   = generateUserToken(42, 'admin', TTL_8H);
    const artists = [{ slug: 'my-band', name: 'My Band', role: 'admin' }];
    const handler = makeHandler(async () => artists);
    const res = mockRes();
    await handler({
      method: 'GET',
      query:  { action: 'my-artists' },
      headers: { authorization: 'Bearer ' + token },
    }, res);
    assertEq(res._status, 200);
    assert(Array.isArray(res._body && res._body.artists), 'expected artists array');
  });

  await testAsync('valid token whose user was deleted → 401, not an empty list', async () => {
    const token   = generateUserToken(42, 'admin', TTL_8H);
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({
      method: 'GET',
      query:  { action: 'my-artists' },
      headers: { authorization: 'Bearer ' + token },
    }, res);
    assertEq(res._status, 401);
  });

  // ── OAuth GET endpoints must not require a slug ──────────────────────────────
  // They resolve the user by email, never by slug. In a multi-tenant deployment
  // (ARTIST_SLUG unset) the client calls them with no ?slug, so they must be
  // reachable without one — regression guard for the slug-guard ordering bug.
  console.log(B('\nGET OAuth endpoints (slug-independent)'));

  await testAsync('google-url → 200 + provider url (no slug, ARTIST_SLUG unset)', async () => {
    delete process.env.ARTIST_SLUG;
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'google-url' }, headers: {} }, res);
    assertEq(res._status, 200);
    assert(res._body && /accounts\.google\.com/.test(res._body.url), 'expected a Google auth url');
  });

  await testAsync('oauth-callback with no code → 302 redirect, not 404 (no slug)', async () => {
    delete process.env.ARTIST_SLUG;
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'oauth-callback' }, headers: {} }, res);
    assertEq(res._status, 302);
    assert(/oauth_error=1/.test(res._redirected || ''), 'expected redirect to login with oauth_error');
  });

  // ── Plan changes go only through dedicated actions ──────────────────────────
  console.log(B('\nplan actions'));

  // resolveUser takes the role from the users row, not the token.
  function memberSql(role, onQuery) {
    return async function(strings, ...values) {
      const q = strings.join('?');
      // requireAuth: band and membership in one row.
      if (q.includes('JOIN users u2')) {
        const slug = values.find(v => typeof v === 'string');
        return [{ id: 1, slug, name: 'Test', config: {}, password_hash: 'hash', member_id: 42, member_role: role, member_password_hash: null }];
      }
      return (onQuery && onQuery(q, values)) || [];
    };
  }
  const bearer = () => 'Bearer ' + generateUserToken(42, 'admin', TTL_8H);

  await testAsync('PATCH config drops plan and upgradedAt but keeps other keys', async () => {
    let merged = null;
    const handler = makeHandler(memberSql('admin', (q, values) => {
      if (q.includes('UPDATE artists SET config')) { merged = values[0]; return [{ id: 1 }]; }
    }));
    const res = mockRes();
    await handler({
      method: 'PATCH', query: { slug: 'test' },
      body: { config: { plan: 'pro', upgradedAt: '2026-01-01T00:00:00.000Z', private: true } },
      headers: { authorization: bearer() },
    }, res);
    assertEq(res._status, 200);
    assertEq(merged, { private: true });
  });

  await testAsync('PATCH config past the size cap → 413, the merge is guarded in SQL', async () => {
    let guarded = false;
    const handler = makeHandler(memberSql('admin', (q) => {
      // The row matches only while the merged config stays under the cap; a
      // database that refuses it returns no row.
      if (q.includes('UPDATE artists SET config')) { guarded = /octet_length/.test(q); return []; }
    }));
    const res = mockRes();
    await handler({
      method: 'PATCH', query: { slug: 'test' },
      body: { config: { displayFields: 'x'.repeat(70000) } },
      headers: { authorization: bearer() },
    }, res);
    assert(guarded, 'expected the size check in the UPDATE');
    assertEq(res._status, 413);
  });

  await testAsync('anonymous config carries only the public keys', async () => {
    const handler = makeHandler(async () => [], null, {
      logoUrl: 'https://x.test/l.png', publicStage: true, gemaIpNameNumber: '123', upgradedAt: 'x', someFutureKey: 1,
    });
    const res = mockRes();
    await handler({ method: 'GET', query: { slug: 'test' }, headers: {} }, res);
    assertEq(res._status, 200);
    assertEq(res._body.config, { logoUrl: 'https://x.test/l.png', publicStage: true });
  });

  await testAsync('POST action=downgrade sets plan free and leaves upgradedAt alone', async () => {
    let merged = null;
    const handler = makeHandler(memberSql('admin', (q, values) => {
      if (q.includes('UPDATE artists SET config')) merged = values[0];
    }));
    const res = mockRes();
    await handler({
      method: 'POST', query: { slug: 'test' }, body: { action: 'downgrade' },
      headers: { authorization: bearer() },
    }, res);
    assertEq(res._status, 200);
    assertEq(merged, { plan: 'free' });
  });

  await testAsync('POST action=downgrade by a member → 403, plan untouched', async () => {
    let updated = false;
    const handler = makeHandler(memberSql('member', (q) => {
      if (q.includes('UPDATE artists')) updated = true;
    }));
    const res = mockRes();
    await handler({
      method: 'POST', query: { slug: 'test' }, body: { action: 'downgrade' },
      headers: { authorization: bearer() },
    }, res);
    assertEq(res._status, 403);
    assert(!updated, 'member must not change the plan');
  });

  await testAsync('POST action=upgrade sets plan pro with an ISO upgradedAt', async () => {
    let merged = null;
    const handler = makeHandler(memberSql('admin', (q, values) => {
      if (q.includes('UPDATE artists SET config')) merged = values[0];
    }));
    const res = mockRes();
    await handler({
      method: 'POST', query: { slug: 'test' }, body: { action: 'upgrade' },
      headers: { authorization: bearer() },
    }, res);
    assertEq(res._status, 200);
    assertEq(merged && merged.plan, 'pro');
    assert(merged && !isNaN(Date.parse(merged.upgradedAt)), 'expected ISO upgradedAt');
  });

  // ── Super-admin gate (SUPER_ADMIN_EMAILS, email read from the DB) ───────────
  console.log(B('\nsuper-admin actions'));

  function superAdminSql(email, onQuery) {
    return async function(strings, ...values) {
      const q = strings.join('?');
      if (/SELECT email(, password_hash)? FROM users/.test(q)) return email ? [{ email }] : [];
      return (onQuery && onQuery(q, values)) || [];
    };
  }
  const overviewReq = (headers) => ({ method: 'GET', query: { action: 'admin-overview' }, headers });

  await testAsync('admin-overview without token → 401', async () => {
    process.env.SUPER_ADMIN_EMAILS = 'boss@example.com';
    const handler = makeHandler(superAdminSql('boss@example.com'));
    const res = mockRes();
    await handler(overviewReq({}), res);
    assertEq(res._status, 401);
  });

  await testAsync('admin-overview for an email not on the allowlist → 403', async () => {
    process.env.SUPER_ADMIN_EMAILS = 'boss@example.com';
    const handler = makeHandler(superAdminSql('someone@example.com'));
    const res = mockRes();
    await handler(overviewReq({ authorization: bearer() }), res);
    assertEq(res._status, 403);
  });

  await testAsync('admin-overview with an empty allowlist → 403', async () => {
    process.env.SUPER_ADMIN_EMAILS = '';
    const handler = makeHandler(superAdminSql('boss@example.com'));
    const res = mockRes();
    await handler(overviewReq({ authorization: bearer() }), res);
    assertEq(res._status, 403);
  });

  await testAsync('admin-overview for an allowlisted email (case/space-insensitive) → 200 + totals', async () => {
    process.env.SUPER_ADMIN_EMAILS = ' Boss@Example.com ,other@example.com';
    const bands = [
      { slug: 'a', name: 'A', plan: 'pro',  upgraded_at: '2026-06-27T10:00:00.000Z', storage_used_bytes: '100', songs: 3, users: 1 },
      { slug: 'b', name: 'B', plan: 'free', upgraded_at: null,                        storage_used_bytes: '50',  songs: 1, users: 2 },
    ];
    const handler = makeHandler(superAdminSql('boss@example.com', (q) => (q.includes('FROM artists a') ? bands : null)));
    const res = mockRes();
    await handler(overviewReq({ authorization: bearer() }), res);
    assertEq(res._status, 200);
    assertEq(res._body && res._body.totals, { bands: 2, storageUsedBytes: 150, pro: 1, free: 1, upgraded: 1 });
  });

  await testAsync('admin-set-plan by a user not on the allowlist → 403, nothing written', async () => {
    process.env.SUPER_ADMIN_EMAILS = 'boss@example.com';
    let updated = false;
    const handler = makeHandler(superAdminSql('someone@example.com', (q) => { if (q.includes('UPDATE artists')) updated = true; }));
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'admin-set-plan', slug: 'a', plan: 'pro' }, headers: { authorization: bearer() } }, res);
    assertEq(res._status, 403);
    assert(!updated, 'non-super-admin must not change plans');
  });

  await testAsync('admin-set-plan with an unknown plan → 400, nothing written', async () => {
    process.env.SUPER_ADMIN_EMAILS = 'boss@example.com';
    let updated = false;
    const handler = makeHandler(superAdminSql('boss@example.com', (q) => { if (q.includes('UPDATE artists')) updated = true; }));
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'admin-set-plan', slug: 'a', plan: 'gold' }, headers: { authorization: bearer() } }, res);
    assertEq(res._status, 400);
    assert(!updated, 'invalid plan must not be written');
  });

  delete process.env.SUPER_ADMIN_EMAILS;
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
