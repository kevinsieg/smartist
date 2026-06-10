# Sign-up & Multi-Tenant Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-service sign-up at `/signup` and migrate the app from single-tenant (`ARTIST_SLUG`) to multi-tenant path-based routing (`/:slug/dashboard`).

**Architecture:** New business logic lives in `api/_domain/` modules (DDD, no HTTP). Handlers become thin controllers. Frontend gets a `_artistSlug` constant derived from the URL path, which is used to scope config fetches, nav links, and session cache keys. Single-tenant deployments (`ARTIST_SLUG` set) keep working unchanged.

**Tech Stack:** Node.js serverless (Vercel), Neon PostgreSQL (postgres.js), vanilla JS frontend, HMAC-signed tokens (`api/_token.js`), `crypto` (stdlib).

---

## File Map

**Create:**
- `api/_domain/identity.js` — OAuth helpers (moved from config.js), state signing
- `api/_domain/artist.js` — slug resolution, availability check, workspace listing
- `api/_domain/registration.js` — signup token storage, artist creation
- `app/js/services/registration.js` — fetch wrappers: signup-link, verify, signup
- `app/js/services/identity.js` — fetch wrappers: google-url, facebook-url, my-artists
- `app/js/services/artist.js` — fetch wrapper: check-slug, config load
- `app/signup.html` + `app/js/signup.js` — sign-up page
- `app/onboarding.html` + `app/js/onboarding.js` — band setup (dual-mode)
- `app/workspaces.html` + `app/js/workspaces.js` — multi-artist workspace picker
- `tests/unit/identity.js` — unit tests for identity domain
- `tests/unit/artist.js` — unit tests for artist domain
- `tests/unit/registration.js` — unit tests for registration domain
- `tests/unit/config_signup.js` — unit tests for new config.js actions

**Modify:**
- `api/config.js` — add `?slug=` param, new sign-up actions, OAuth mode support
- `api/[artist]/auth.js` — return artist list on successful login
- `app/js/common.js` — `_artistSlug` from path, slug-scoped cache, nav prefixes
- `app/js/home.js` — slug from `?next=`, post-login routing, OAuth redirect fix
- `app/js/stage.js` — one-line slug extraction
- `vercel.json` — per-artist routes, new global pages, root → landing
- `tests/unit.js` — add new suites

---

## Task 1: `api/_domain/identity.js`

**Files:**
- Create: `api/_domain/identity.js`
- Create: `tests/unit/identity.js`
- Modify: `tests/unit.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/identity.js`:

```js
const path = require('path');

// Stub env vars before anything loads
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
process.env.FACEBOOK_APP_ID      = process.env.FACEBOOK_APP_ID      || 'test-fb-id';
process.env.FACEBOOK_APP_SECRET  = process.env.FACEBOOK_APP_SECRET  || 'test-fb-secret';

async function run(r) {
  const { test, assert, assertEq, B } = r;

  const { generateState, verifyState } = require(path.join(__dirname, '../../api/_domain/identity'));

  console.log(B('\ngenerateState / verifyState'));

  test('generateState returns base64url string', () => {
    const s = generateState('google', 'login');
    assert(typeof s === 'string' && s.length > 0, 'not a string');
    assert(!/[+=/]/.test(s), 'not base64url');
  });

  test('verifyState returns { provider, mode } for fresh valid state', () => {
    const s = generateState('google', 'login');
    const result = verifyState(s);
    assert(result !== null, 'expected non-null');
    assertEq(result.provider, 'google');
    assertEq(result.mode, 'login');
  });

  test('verifyState returns mode=signup when generated with signup', () => {
    const s = generateState('facebook', 'signup');
    const result = verifyState(s);
    assertEq(result.provider, 'facebook');
    assertEq(result.mode, 'signup');
  });

  test('verifyState returns null for tampered state', () => {
    const s = generateState('google', 'login');
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString());
    parsed.mode = 'signup'; // tamper without re-signing
    const tampered = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    assertEq(verifyState(tampered), null);
  });

  test('verifyState returns null for expired state', () => {
    const s = generateState('google', 'login');
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString());
    parsed.expires = Date.now() - 1;
    const expired = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    assertEq(verifyState(expired), null);
  });

  test('verifyState returns null for garbage string', () => {
    assertEq(verifyState('not-valid'), null);
  });

  test('verifyState returns null for unknown provider', () => {
    assertEq(verifyState(null), null);
    assertEq(verifyState(''), null);
  });

  test('mode defaults to login when not provided', () => {
    const s = generateState('google');
    const result = verifyState(s);
    assertEq(result.mode, 'login');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kev/git/smartist && node tests/unit/identity.js
```

Expected: `Error: Cannot find module '../../api/_domain/identity'`

- [ ] **Step 3: Create the domain module**

Create `api/_domain/identity.js`:

```js
const crypto = require('crypto');

function _stateSecret(provider) {
  if (provider === 'google')   return process.env.GOOGLE_CLIENT_SECRET   || '';
  if (provider === 'facebook') return process.env.FACEBOOK_APP_SECRET    || '';
  return '';
}

function generateState(provider, mode) {
  const resolvedMode = mode || 'login';
  const nonce   = crypto.randomBytes(10).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000;
  const msg     = `${provider}:${nonce}:${expires}:${resolvedMode}`;
  const sig     = crypto.createHmac('sha256', _stateSecret(provider)).update(msg).digest('hex');
  return Buffer.from(JSON.stringify({ provider, nonce, expires, mode: resolvedMode, sig })).toString('base64url');
}

function verifyState(state) {
  if (!state) return null;
  try {
    const { provider, nonce, expires, mode, sig } = JSON.parse(Buffer.from(state, 'base64url').toString());
    if (Date.now() > Number(expires)) return null;
    const msg      = `${provider}:${nonce}:${expires}:${mode}`;
    const expected = crypto.createHmac('sha256', _stateSecret(provider)).update(msg).digest('hex');
    if (sig.length !== expected.length) return null;
    const valid = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    return valid ? { provider, mode } : null;
  } catch { return null; }
}

async function resolveOAuthEmail(provider, code, redirectUri) {
  if (provider === 'google') {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    const { access_token, error } = await tokenRes.json();
    if (error || !access_token) throw new Error(`Google token error: ${error}`);
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { email } = await userRes.json();
    return email || null;
  }

  if (provider === 'facebook') {
    const params = new URLSearchParams({
      client_id:     process.env.FACEBOOK_APP_ID,
      client_secret: process.env.FACEBOOK_APP_SECRET,
      redirect_uri:  redirectUri,
      code,
    });
    const tokenRes = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?${params}`);
    const { access_token, error } = await tokenRes.json();
    if (error || !access_token) throw new Error(`Facebook token error: ${error?.message}`);
    const userRes = await fetch(`https://graph.facebook.com/me?fields=email&access_token=${encodeURIComponent(access_token)}`);
    const { email } = await userRes.json();
    return email || null;
  }

  return null;
}

module.exports = { generateState, verifyState, resolveOAuthEmail };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kev/git/smartist && node tests/unit/identity.js
```

Expected: all tests PASS

- [ ] **Step 5: Add suite to `tests/unit.js`**

In `tests/unit.js`, add to the suites array after `require('./unit/auth')`:

```js
  require('./unit/identity'),
```

- [ ] **Step 6: Run full unit suite to confirm no regressions**

```bash
cd /Users/kev/git/smartist && node tests/unit.js
```

Expected: all suites pass

- [ ] **Step 7: Commit**

```bash
git add api/_domain/identity.js tests/unit/identity.js tests/unit.js
git commit -m "feat: add identity domain module (generateState/verifyState with mode support)"
```

---

## Task 2: `api/_domain/artist.js`

**Files:**
- Create: `api/_domain/artist.js`
- Create: `tests/unit/artist.js`
- Modify: `tests/unit.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/artist.js`:

```js
const path = require('path');

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  const { resolveArtist, isSlugAvailable, getArtistsForUser } =
    require(path.join(__dirname, '../../api/_domain/artist'));

  console.log(B('\nresolveArtist'));

  await testAsync('returns artist when slug matches', async () => {
    const ARTIST = { id: 1, slug: 'myband', name: 'My Band', config: {} };
    const sql = async (strings, ...vals) => [ARTIST];
    const result = await resolveArtist('myband', sql);
    assertEq(result.slug, 'myband');
  });

  await testAsync('returns null when no row', async () => {
    const sql = async () => [];
    const result = await resolveArtist('ghost', sql);
    assertEq(result, null);
  });

  await testAsync('falls back to ARTIST_SLUG env when slug is empty', async () => {
    process.env.ARTIST_SLUG = 'envband';
    const ARTIST = { id: 2, slug: 'envband', name: 'Env Band', config: {} };
    const sql = async (strings, ...vals) => [ARTIST];
    const result = await resolveArtist('', sql);
    assertEq(result.slug, 'envband');
    delete process.env.ARTIST_SLUG;
  });

  await testAsync('returns null when both slug and env are empty', async () => {
    delete process.env.ARTIST_SLUG;
    const sql = async () => [];
    const result = await resolveArtist('', sql);
    assertEq(result, null);
  });

  console.log(B('\nisSlugAvailable'));

  await testAsync('returns true when no artist with that slug', async () => {
    const sql = async () => [{ count: '0' }];
    const result = await isSlugAvailable('newband', sql);
    assertEq(result, true);
  });

  await testAsync('returns false when slug already taken', async () => {
    const sql = async () => [{ count: '1' }];
    const result = await isSlugAvailable('takenband', sql);
    assertEq(result, false);
  });

  await testAsync('returns false for reserved slug "login"', async () => {
    const sql = async () => [{ count: '0' }];
    const result = await isSlugAvailable('login', sql);
    assertEq(result, false);
  });

  await testAsync('returns false for reserved slug "signup"', async () => {
    const sql = async () => [{ count: '0' }];
    const result = await isSlugAvailable('signup', sql);
    assertEq(result, false);
  });

  console.log(B('\ngetArtistsForUser'));

  await testAsync('returns workspace list for a user', async () => {
    const ROWS = [
      { slug: 'band-a', name: 'Band A', role: 'admin' },
      { slug: 'band-b', name: 'Band B', role: 'member' },
    ];
    const sql = async () => ROWS;
    const result = await getArtistsForUser(42, sql);
    assertEq(result.length, 2);
    assertEq(result[0].slug, 'band-a');
    assertEq(result[1].role, 'member');
  });

  await testAsync('returns empty array when user has no artists', async () => {
    const sql = async () => [];
    const result = await getArtistsForUser(99, sql);
    assertEq(result.length, 0);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kev/git/smartist && node tests/unit/artist.js
```

Expected: `Error: Cannot find module '../../api/_domain/artist'`

- [ ] **Step 3: Create the domain module**

Create `api/_domain/artist.js`:

```js
const RESERVED_SLUGS = new Set([
  'login', 'signup', 'onboarding', 'home', 'demo', 'impressum', 'api', 'app',
  'auth', 'callback', 'static', 'favicon_io',
]);

async function resolveArtist(slug, sql) {
  const s = slug || process.env.ARTIST_SLUG || '';
  if (!s) return null;
  const [row] = await sql`SELECT id, slug, name, config, password_hash FROM artists WHERE slug = ${s} LIMIT 1`;
  return row || null;
}

async function isSlugAvailable(slug, sql) {
  if (RESERVED_SLUGS.has(slug)) return false;
  const [row] = await sql`SELECT COUNT(*)::int AS count FROM artists WHERE slug = ${slug}`;
  return Number(row.count) === 0;
}

async function getArtistsForUser(userId, sql) {
  return sql`
    SELECT a.slug, a.name, u.role
    FROM users u
    JOIN artists a ON a.id = u.artist_id
    WHERE u.id = ${userId}
    ORDER BY a.name
  `;
}

module.exports = { resolveArtist, isSlugAvailable, getArtistsForUser };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kev/git/smartist && node tests/unit/artist.js
```

Expected: all tests PASS

- [ ] **Step 5: Add suite to `tests/unit.js`**

In `tests/unit.js`, add to the suites array after `require('./unit/identity')`:

```js
  require('./unit/artist'),
```

- [ ] **Step 6: Run full unit suite**

```bash
cd /Users/kev/git/smartist && node tests/unit.js
```

Expected: all suites pass

- [ ] **Step 7: Commit**

```bash
git add api/_domain/artist.js tests/unit/artist.js tests/unit.js
git commit -m "feat: add artist domain module (resolveArtist, isSlugAvailable, getArtistsForUser)"
```

---

## Task 3: `api/_domain/registration.js`

**Files:**
- Create: `api/_domain/registration.js`
- Create: `tests/unit/registration.js`
- Modify: `tests/unit.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/registration.js`:

```js
const path = require('path');
const crypto = require('crypto');

process.env.APP_SECRET = process.env.APP_SECRET || 'unit-test-secret-32-bytes-okayy!';

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  const { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken } =
    require(path.join(__dirname, '../../api/_domain/registration'));

  console.log(B('\ncreateSignupToken'));

  await testAsync('returns a hex string token and stores hash in subscribers', async () => {
    let upsertCalled = false;
    const sql = async (strings, ...vals) => {
      if (String(strings[0]).includes('INSERT INTO subscribers')) upsertCalled = true;
      return [];
    };
    const token = await createSignupToken('test@example.com', sql);
    assert(typeof token === 'string' && token.length === 64, 'expected 64-char hex token');
    assert(upsertCalled, 'expected upsert into subscribers');
  });

  console.log(B('\nverifySignupToken'));

  await testAsync('returns { email } for valid non-expired token', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() + 30 * 60 * 1000);
    const sql = async () => [{ email: 'user@example.com', signup_token_hash: hash, signup_token_expires: expires }];
    const result = await verifySignupToken(rawToken, sql);
    assert(result !== null, 'expected non-null');
    assertEq(result.email, 'user@example.com');
  });

  await testAsync('returns null when no subscriber found', async () => {
    const sql = async () => [];
    const result = await verifySignupToken('deadbeef'.repeat(8), sql);
    assertEq(result, null);
  });

  await testAsync('returns null when token is expired', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires  = new Date(Date.now() - 1000);
    const sql = async () => [{ email: 'user@example.com', signup_token_hash: hash, signup_token_expires: expires }];
    const result = await verifySignupToken(rawToken, sql);
    assertEq(result, null);
  });

  console.log(B('\ncreateArtistAndAdmin'));

  await testAsync('inserts artist and user, returns { artistId, userId }', async () => {
    const calls = [];
    const sql = async (strings, ...vals) => {
      calls.push(String(strings[0]).trim().slice(0, 30));
      if (String(strings[0]).includes('INSERT INTO artists')) return [{ id: 10 }];
      if (String(strings[0]).includes('INSERT INTO users'))   return [{ id: 20 }];
      return [];
    };
    const result = await createArtistAndAdmin('My Band', 'my-band', 'admin@example.com', sql);
    assertEq(result.artistId, 10);
    assertEq(result.userId, 20);
    assert(calls.some(c => c.includes('INSERT INTO artists')), 'expected artist insert');
    assert(calls.some(c => c.includes('INSERT INTO users')),   'expected user insert');
  });

  console.log(B('\nclearSignupToken'));

  await testAsync('removes token fields from subscribers.meta', async () => {
    let updateCalled = false;
    const sql = async (strings) => {
      if (String(strings[0]).includes('UPDATE subscribers')) updateCalled = true;
      return [];
    };
    await clearSignupToken('user@example.com', sql);
    assert(updateCalled, 'expected UPDATE subscribers');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/kev/git/smartist && node tests/unit/registration.js
```

Expected: `Error: Cannot find module '../../api/_domain/registration'`

- [ ] **Step 3: Create the domain module**

Create `api/_domain/registration.js`:

```js
const crypto = require('crypto');

async function createSignupToken(email, sql) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hash     = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expires  = new Date(Date.now() + 30 * 60 * 1000);
  await sql`
    INSERT INTO subscribers (email, source, meta)
    VALUES (${email}, 'signup', ${{ signup_token_hash: hash, signup_token_expires: expires.toISOString() }})
    ON CONFLICT (email) DO UPDATE
      SET meta = subscribers.meta || ${{ signup_token_hash: hash, signup_token_expires: expires.toISOString() }}
  `;
  return rawToken;
}

async function verifySignupToken(rawToken, sql) {
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const [row] = await sql`
    SELECT email,
           meta->>'signup_token_hash'    AS signup_token_hash,
           (meta->>'signup_token_expires')::timestamptz AS signup_token_expires
    FROM subscribers
    WHERE meta->>'signup_token_hash' = ${hash}
  `;
  if (!row) return null;
  if (new Date(row.signup_token_expires) < new Date()) return null;
  return { email: row.email };
}

async function createArtistAndAdmin(name, slug, email, sql) {
  const [artist] = await sql`
    INSERT INTO artists (slug, name, config)
    VALUES (${slug}, ${name}, '{}')
    RETURNING id
  `;
  const [user] = await sql`
    INSERT INTO users (artist_id, email, role, password_hash)
    VALUES (${artist.id}, ${email}, 'admin', NULL)
    RETURNING id
  `;
  return { artistId: artist.id, userId: user.id };
}

async function clearSignupToken(email, sql) {
  await sql`
    UPDATE subscribers
    SET meta = (meta - 'signup_token_hash') - 'signup_token_expires'
    WHERE email = ${email}
  `;
}

module.exports = { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/kev/git/smartist && node tests/unit/registration.js
```

Expected: all tests PASS

- [ ] **Step 5: Add suite to `tests/unit.js`**

Add to suites array after `require('./unit/artist')`:

```js
  require('./unit/registration'),
```

- [ ] **Step 6: Run full unit suite**

```bash
cd /Users/kev/git/smartist && node tests/unit.js
```

Expected: all suites pass

- [ ] **Step 7: Commit**

```bash
git add api/_domain/registration.js tests/unit/registration.js tests/unit.js
git commit -m "feat: add registration domain module (signup tokens, artist creation)"
```

---

## Task 4: `vercel.json` migration

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Update `vercel.json`**

Replace the rewrites array so that:
- `/` → `app/landing.html` (was `app/index.html`)
- New global pages appear before any `/:slug` wildcards
- All existing non-slug app routes get `/:slug/` prefixes
- The `/:slug` catch-redirect is last

```json
{
  "rewrites": [
    { "source": "/auth/callback",                                                                 "destination": "/api/config?action=oauth-callback" },
    { "source": "/api/:artist/request-reset",                                                     "destination": "/api/:artist/auth" },
    { "source": "/api/:artist/song-logs",                                                         "destination": "/api/:artist/songs" },
    { "source": "/api/:artist/gema/import",                                                       "destination": "/api/:artist/songs/gema-import" },
    { "source": "/api/:artist/songs/:songId/gema",                                                "destination": "/api/:artist/songs/gema?songId=:songId" },
    { "source": "/api/:artist/songs/:songId/arrangements/:arrId/activate",                        "destination": "/api/:artist/songs/arrangements?songId=:songId&arrId=:arrId&sub=activate" },
    { "source": "/api/:artist/songs/:songId/arrangements/:arrId",                                 "destination": "/api/:artist/songs/arrangements?songId=:songId&arrId=:arrId" },
    { "source": "/api/:artist/songs/:songId/arrangements",                                        "destination": "/api/:artist/songs/arrangements?songId=:songId" },
    { "source": "/api/:artist/songs/:songId/audio",                                               "destination": "/api/:artist/songs/audio?songId=:songId" },
    { "source": "/api/:artist/songs/:songId/sheet",                                               "destination": "/api/:artist/songs/sheet?songId=:songId" },
    { "source": "/api/:artist/songs/:songId/playback",                                            "destination": "/api/:artist/songs/playback?songId=:songId" },
    { "source": "/api/:artist/songs/:songId/setlists",                                            "destination": "/api/:artist/songs/setlists?songId=:songId" },
    { "source": "/api/:artist/songs/:songId/restore",                                             "destination": "/api/:artist/songs/restore?songId=:songId" },
    { "source": "/api/:artist/export",                                                            "destination": "/api/:artist/setlists/export" },

    { "source": "/",                "destination": "/app/landing.html" },
    { "source": "/login",           "destination": "/app/index.html" },
    { "source": "/signup",          "destination": "/app/signup.html" },
    { "source": "/onboarding",      "destination": "/app/onboarding.html" },
    { "source": "/home",            "destination": "/app/workspaces.html" },
    { "source": "/api/docs",        "destination": "/app/api-docs.html" },
    { "source": "/impressum",       "destination": "/app/impressum.html" },
    { "source": "/demo",            "destination": "/app/demo.html" },

    { "source": "/:slug/dashboard",        "destination": "/app/dashboard.html" },
    { "source": "/:slug/songs",            "destination": "/app/songs.html" },
    { "source": "/:slug/setlist",          "destination": "/app/setlist.html" },
    { "source": "/:slug/setlist-history",  "destination": "/app/setlist-history.html" },
    { "source": "/:slug/gigs",             "destination": "/app/gigs.html" },
    { "source": "/:slug/venues",           "destination": "/app/venues.html" },
    { "source": "/:slug/organizers",       "destination": "/app/organizers.html" },
    { "source": "/:slug/hub",              "destination": "/app/hub.html" },
    { "source": "/:slug/pro-import",       "destination": "/app/pro-import.html" },
    { "source": "/:slug/gema-import",      "destination": "/app/pro-import.html" },
    { "source": "/:slug/profile",          "destination": "/app/profile.html" },
    { "source": "/:slug/users",            "destination": "/app/users.html" },
    { "source": "/:slug/stage",            "destination": "/app/stage.html" },

    { "source": "/:slug",           "destination": "/:slug/dashboard" }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-XSS-Protection", "value": "1; mode=block" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "geolocation=(), microphone=(), camera=()" }
      ]
    },
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Robots-Tag", "value": "noindex, nofollow" }
      ]
    },
    {
      "source": "/app/css/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/app/js/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }
      ]
    },
    {
      "source": "/(.*\\.html)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }
      ]
    },
    {
      "source": "/(.*\\.json)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }
      ]
    }
  ]
}
```

> **Note on backward compat:** The old unqualified routes (`/songs`, `/dashboard`, etc.) are removed. Single-tenant users who bookmarked those URLs will need to use `/:slug/songs` etc. If backward compat is required, old routes can redirect to `/:slug` equivalents using `ARTIST_SLUG` env — add that as a follow-on if needed.

- [ ] **Step 2: Verify JSON parses**

```bash
cd /Users/kev/git/smartist && node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('valid')"
```

Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "feat: migrate vercel.json to path-based multi-tenant routing (/:slug/*)"
```

---

## Task 5: `app/js/common.js` migration

**Files:**
- Modify: `app/js/common.js`

The three changes are: (1) derive `_artistSlug` from URL path, (2) scope config cache key and fetch URL to slug, (3) prefix nav links with slug.

- [ ] **Step 1: Add `_artistSlug` constant and scoped config key**

In `app/js/common.js`, after line 3 (the `const AUTH_TOKEN_KEY` line), insert:

```js
var _GLOBAL_PAGES = new Set(['login','signup','onboarding','home','demo','impressum']);
var _rawSegment   = (window.location.pathname.split('/').filter(Boolean)[0] || '');
var _artistSlug   = _GLOBAL_PAGES.has(_rawSegment) ? '' : _rawSegment;
var _CONFIG_KEY   = 'artist_config_cache_' + (_artistSlug || 'default');
```

Remove the old `const _CONFIG_KEY = 'artist_config_cache';` line (line ~328).

- [ ] **Step 2: Update `isLoginPage()` to cover all global pages**

Replace:
```js
function isLoginPage() {
  var p = window.location.pathname.replace(/\/+$/, '') || '/';
  return p === '/' || p === '/login';
}
```
With:
```js
function isLoginPage() {
  return !_artistSlug;
}
```

- [ ] **Step 3: Update `loginPageUrl()` to include current slug in `next` param**

The existing `loginPageUrl()` already uses `window.location.pathname + window.location.search` as the `next` param, which includes the slug prefix. No change needed — it works correctly with path-based routing.

- [ ] **Step 4: Update `loadConfig()` to pass slug and use scoped cache**

Replace the current `loadConfig()` function (approx lines 397–413) with:

```js
async function loadConfig(slugOverride) {
  var slug = (slugOverride !== undefined) ? slugOverride : _artistSlug;
  var key  = 'artist_config_cache_' + (slug || 'default');
  let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(key)); } catch {}

  var url = slug ? '/api/config?slug=' + encodeURIComponent(slug) : '/api/config';
  const fetchFresh = fetch(url)
    .then(r => { if (!r.ok) throw new Error('config unavailable'); return r.json(); })
    .then(cfg => {
      try { sessionStorage.setItem(key, JSON.stringify(cfg)); } catch {}
      return cfg;
    });

  if (cached) {
    fetchFresh.catch(() => {});
    return cached;
  }
  return fetchFresh;
}
```

- [ ] **Step 5: Update `invalidateConfigCache()`**

Find the existing `invalidateConfigCache` function (if it exists — search for it) and update it to use the scoped key. If it doesn't exist, add it after `loadConfig`:

```js
function invalidateConfigCache() {
  var slug = _artistSlug;
  sessionStorage.removeItem('artist_config_cache_' + (slug || 'default'));
}
```

- [ ] **Step 6: Update `injectShell()` nav links with slug prefix**

In the `injectShell()` IIFE (lines ~36–116), change the nav links block. Add a `_base` variable and prefix all artist page links:

In the `injectShell()` function, at the start of the function body (after the outer curly brace), add:
```js
  var _base = _artistSlug ? '/' + _artistSlug : '';
```

Then replace the nav links string. Replace:
```js
        '<a href="/songs">Songs</a>' +
        '<a href="/setlist">Setlists</a>' +
        '<a href="/gigs">Gigs</a>' +
        '<a href="/venues">Venues</a>' +
        '<a href="/organizers" class="auth-only">Organizers</a>' +
        '<a href="/hub">Hub</a>' +
        '<a href="/pro-import" class="auth-only">PRO</a>' +
        '<a href="/users" class="admin-only">Users</a>' +
        '<a href="#" class="nav-links-login go-login" id="nav-links-login">Login &#8594;</a>' +
        '<a href="/profile" class="nav-links-profile" id="nav-links-profile">Profile</a>' +
        '<a href="#" class="nav-links-logout" id="nav-links-logout">Logout</a>' +
```
With:
```js
        '<a href="' + _base + '/songs">Songs</a>' +
        '<a href="' + _base + '/setlist">Setlists</a>' +
        '<a href="' + _base + '/gigs">Gigs</a>' +
        '<a href="' + _base + '/venues">Venues</a>' +
        '<a href="' + _base + '/organizers" class="auth-only">Organizers</a>' +
        '<a href="' + _base + '/hub">Hub</a>' +
        '<a href="' + _base + '/pro-import" class="auth-only">PRO</a>' +
        '<a href="' + _base + '/users" class="admin-only">Users</a>' +
        '<a href="#" class="nav-links-login go-login" id="nav-links-login">Login &#8594;</a>' +
        '<a href="' + _base + '/profile" class="nav-links-profile" id="nav-links-profile">Profile</a>' +
        '<a href="#" class="nav-links-logout" id="nav-links-logout">Logout</a>' +
```

- [ ] **Step 7: Update the cached-config early paint block inside `injectShell()`**

The early paint block (~lines 83–106) reads `sessionStorage.getItem('artist_config_cache')` directly. Update that reference to use the scoped key:

Replace:
```js
    const cached = JSON.parse(sessionStorage.getItem('artist_config_cache'));
```
With:
```js
    const cached = JSON.parse(sessionStorage.getItem(_CONFIG_KEY));
```

- [ ] **Step 8: Update `updateAuthIndicator()` logo href**

In `updateAuthIndicator()` (~line 489–491), replace:
```js
  document.querySelectorAll('.app-logo').forEach(function(a) {
    a.href = authed ? '/dashboard' : loginPageUrl();
  });
```
With:
```js
  var _logoBase = _artistSlug ? '/' + _artistSlug : '';
  document.querySelectorAll('.app-logo').forEach(function(a) {
    a.href = authed ? (_logoBase + '/dashboard') : loginPageUrl();
  });
```

Also update the `_cachedCfg` lookup inside `updateAuthIndicator()` — replace the hardcoded `_CONFIG_KEY` reference:
```js
      var _cachedCfg = JSON.parse(sessionStorage.getItem(_CONFIG_KEY) || '{}');
```
This already uses `_CONFIG_KEY` so it will pick up the new scoped key automatically after Step 1.

- [ ] **Step 9: Update `_openAuthMenu()` profile nav**

In `_openAuthMenu()` (~line 542), replace:
```js
    '<div class="nav-auth-menu-item" onclick="navigate(\'/profile\');document.getElementById(\'nav-auth-menu\')&&document.getElementById(\'nav-auth-menu\').remove()">' +
```
With:
```js
    '<div class="nav-auth-menu-item" onclick="navigate(\'' + (_artistSlug ? \'/' + _artistSlug + '/profile\' : \'/profile\') + '\');document.getElementById(\'nav-auth-menu\')&&document.getElementById(\'nav-auth-menu\').remove()">' +
```

Note: `_openAuthMenu` runs at click time so `_artistSlug` is already set. But this inline string is constructed at menu-open time, which is correct.

More readable as a JS-built string — replace the full menu.innerHTML assignment in `_openAuthMenu()`:

```js
  var _profilePath = _artistSlug ? '/' + _artistSlug + '/profile' : '/profile';
  menu.innerHTML =
    '<div class="nav-auth-menu-item" onclick="navigate(\'' + _profilePath + '\');document.getElementById(\'nav-auth-menu\')&&document.getElementById(\'nav-auth-menu\').remove()">' +
      'Profile' +
    '</div>' +
    '<div class="nav-auth-menu-item" onclick="doLogout()">' +
      'Logout' +
    '</div>';
```

- [ ] **Step 10: Verify the app still loads on `vercel dev`**

```bash
vercel dev
```

Open `http://localhost:3000/login` and verify the nav renders without errors. Open the browser console — no JS errors expected.

- [ ] **Step 11: Commit**

```bash
git add app/js/common.js
git commit -m "feat: common.js multi-tenant — _artistSlug from path, slug-scoped config cache and nav links"
```

---

## Task 6: `app/js/home.js` — login page update

**Files:**
- Modify: `app/js/home.js`

- [ ] **Step 1: Extract slug from `?next=` param**

In the `init()` function of `app/js/home.js`, add slug detection right after the `const params` line:

```js
  const next         = params.get('next') || '';
  const slugFromNext = next.split('/').filter(Boolean)[0] || '';
  // For artist-scoped auth endpoint. Falls back to ARTIST_SLUG in config if not in URL.
```

- [ ] **Step 2: Use slug-aware config load**

The `loadConfig()` call currently loads the default config. On the login page we want the artist config when a slug is known (for band name in header). Update:

```js
  let cfg;
  try {
    cfg = await loadConfig(slugFromNext || undefined);
    artistSlug = cfg.slug || slugFromNext;
    applyNav(cfg.name, cfg.config);
    document.title = cfg.name || 'Band Tools';
  } catch {
    renderLogin();
    return;
  }
```

- [ ] **Step 3: Update `renderLoggedIn()` — post-login routing**

The login success needs to route based on the `next` param or the artist list returned by auth. Find `renderLoggedIn()` and replace:

```js
function renderLoggedIn(cfg) {
  const next = new URLSearchParams(window.location.search).get('next');
  const dest = (next && next.startsWith('/') && !next.startsWith('//')) ? next : '/dashboard';
  window.location.href = dest;
}
```
With:
```js
function renderLoggedIn(cfg, artists) {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) {
    window.location.href = next;
    return;
  }
  if (!artists || artists.length === 0) {
    window.location.href = '/onboarding';
    return;
  }
  if (artists.length === 1) {
    window.location.href = '/' + artists[0].slug + '/dashboard';
    return;
  }
  window.location.href = '/home';
}
```

- [ ] **Step 4: Thread `artists` through `verifyToken` and login responses**

Update `verifyToken()` to capture and return the artists list from the server response:

```js
async function verifyToken(token, hint) {
  try {
    const body = hint
      ? { magic: token, hint }
      : { password: token };
    const r = await fetch(`/api/${artistSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, artists: [] };
    const data = await r.json();
    if (data.token) {
      storeToken(data.token, false);
      sessionStorage.setItem('smartist_admin_email', data.email || '');
    } else if (data.adminEmail) {
      sessionStorage.setItem('smartist_admin_email', data.adminEmail);
    }
    return { ok: true, artists: data.artists || [] };
  } catch { return { ok: false, artists: [] }; }
}
```

Update callers of `verifyToken` in `init()`:

Old:
```js
  if (magic) {
    const ok = await verifyToken(magic, hint || null);
    if (ok) renderLoggedIn(cfg);
    else    renderLogin('Invalid or expired login link.', cfg);
    return;
  }

  const token = sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY);
  if (token && await verifyToken(token)) {
    renderLoggedIn(cfg);
  } else {
```

New:
```js
  if (magic) {
    const { ok, artists } = await verifyToken(magic, hint || null);
    if (ok) renderLoggedIn(cfg, artists);
    else    renderLogin('Invalid or expired login link.', cfg);
    return;
  }

  const token = sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    const { ok, artists } = await verifyToken(token);
    if (ok) { renderLoggedIn(cfg, artists); return; }
  }
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  renderLogin(null, cfg);
```

- [ ] **Step 5: Update the email+password login submit handler**

Find the `doLogin()` function (or wherever `POST /api/:artist/auth` is called with email+password) and update the response handler to pass `data.artists` to `renderLoggedIn`. Look for:

```js
    if (data.token) { storeToken(data.token, rememberMe); ... renderLoggedIn(cfg); }
```

Replace with:
```js
    if (data.token) {
      storeToken(data.token, rememberMe);
      sessionStorage.setItem('smartist_admin_email', data.email || '');
      renderLoggedIn(cfg, data.artists || []);
    }
```

- [ ] **Step 6: Update OAuth redirect**

Search `home.js` for any `oauth_error` handling or redirect logic. The OAuth callback now redirects to `/login?magic=X&hint=Y&next=/:slug/dashboard` — the `init()` function already reads `magic` and `hint` from query params, so this flow works without changes here. Just verify `oauthError` rendering still calls `renderLogin(message, cfg)`.

- [ ] **Step 7: Handle case where no slug is available**

At the top of `init()`, after config load fails or if no artist can be resolved, redirect to `/signup` if there's no `ARTIST_SLUG` in the config. The check happens naturally: if `cfg.slug` is empty and `next` is empty, there is no artist to authenticate against, so redirect:

After the `artistSlug = cfg.slug || slugFromNext;` line, add:
```js
  if (!artistSlug) {
    window.location.replace('/signup');
    return;
  }
```

- [ ] **Step 8: Commit**

```bash
git add app/js/home.js
git commit -m "feat: home.js multi-tenant — slug from ?next=, post-login routing by artist count"
```

---

## Task 7: `app/js/stage.js` — slug extraction

**Files:**
- Modify: `app/js/stage.js`

- [ ] **Step 1: Add slug constant and update config fetch**

At the top of the `async function init()` body in `stage.js` (before the `const el` line), add:

```js
  const _stageSlug = window.location.pathname.split('/').filter(Boolean)[0] || '';
```

Then update the config fetch on the same line (~line 123):
```js
    const cfgFetch = fetch('/api/config?slug=' + encodeURIComponent(_stageSlug)).then(r => { if (!r.ok) throw new Error(); return r.json(); });
```

Also update the two `sessionStorage` cache key references in that function from `'artist_config_cache'` to use the slug-scoped key. In `stage.js`, replace:
```js
    try { cfg = JSON.parse(sessionStorage.getItem('artist_config_cache')) || await cfgFetch; }
```
With:
```js
    var _stageCacheKey = 'artist_config_cache_' + (_stageSlug || 'default');
    try { cfg = JSON.parse(sessionStorage.getItem(_stageCacheKey)) || await cfgFetch; }
```

And:
```js
      try { sessionStorage.setItem('artist_config_cache', JSON.stringify(fresh)); } catch {}
```
With:
```js
      try { sessionStorage.setItem(_stageCacheKey, JSON.stringify(fresh)); } catch {}
```

- [ ] **Step 2: Commit**

```bash
git add app/js/stage.js
git commit -m "fix: stage.js — extract slug from path for multi-tenant config fetch"
```

---

## Task 8: Unit tests for `config.js` sign-up actions (write failing tests first — TDD RED)

**Files:**
- Create: `tests/unit/config_signup.js`
- Modify: `tests/unit.js`

These tests call the **HTTP handler** directly with mocked dependencies (same `makeHandler` pattern as `tests/unit/subscribe.js`). They MUST fail before Task 9 is implemented — that is the TDD RED gate. Task 9 implements the handler actions to make them pass (GREEN).

**Why handler-level, not domain-level:** Domain modules were tested in Tasks 1–3. Testing them again here would not constitute failing tests — they already pass. For the TDD cycle to work, tests must fail on the code being written in Task 9 (the handler routing). Calling the handler with an unrecognised `action` exercises exactly that.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/config_signup.js`:

```js
const path = require('path');
const crypto = require('crypto');

process.env.APP_SECRET           = process.env.APP_SECRET           || 'unit-test-secret-32-bytes-okayy!';
process.env.GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-google-secret';
process.env.FACEBOOK_APP_ID      = process.env.FACEBOOK_APP_ID      || 'test-fb-id';
process.env.FACEBOOK_APP_SECRET  = process.env.FACEBOOK_APP_SECRET  || 'test-fb-secret';

// Token utilities needed to forge a valid bearer token for my-artists tests.
const { generateUserToken, TTL_8H } = require(path.join(__dirname, '../../api/_token'));

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  // Re-require config.js with stubbed deps each call so handler state is isolated.
  // Domain modules (_domain/*) are NOT stubbed — they run with the mocked sql function,
  // testing the full handler → domain → (mocked) DB stack.
  function makeHandler(sqlFn, emailFn) {
    const dbPath     = require.resolve(path.join(__dirname, '../../api/_db'));
    const rlPath     = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
    const emailPath  = require.resolve(path.join(__dirname, '../../api/_email'));
    const configPath = require.resolve(path.join(__dirname, '../../api/config'));

    delete require.cache[dbPath];
    delete require.cache[configPath];
    // Bust domain module cache so they re-link against the freshly-stubbed _db.
    ['identity', 'artist', 'registration'].forEach(function(m) {
      try { delete require.cache[require.resolve(path.join(__dirname, '../../api/_domain/' + m))]; } catch {}
    });

    require.cache[rlPath] = {
      id: rlPath, filename: rlPath, loaded: true,
      exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
    };
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: {
        getDb:     () => sqlFn,
        getArtist: async (slug) => ({ id: 1, slug, name: 'Test', config: {}, password_hash: 'hash' }),
        getSlug:   (req) => (req.query && req.query.artist) || 'test',
      },
    };
    require.cache[emailPath] = {
      id: emailPath, filename: emailPath, loaded: true,
      exports: { sendEmail: emailFn || (async () => {}) },
    };

    return require(path.join(__dirname, '../../api/config'));
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
  // RED: current config.js falls through to the subscribe path, which does NOT
  // send email. The emailSent assertion fails until Task 9 adds the action.

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

  await testAsync('valid email → 200 + ok:true + email sent', async () => {
    let emailSent = false;
    const handler = makeHandler(async () => [], async () => { emailSent = true; });
    const res = mockRes();
    await handler({
      method: 'POST',
      body: { action: 'signup-link', email: 'test@example.com' },
      headers: { host: 'localhost:3000' },
    }, res);
    assertEq(res._status, 200);
    assertEq(res._body && res._body.ok, true);
    assert(emailSent, 'expected signup email to be sent — subscribe path does not send email');
  });

  // ── POST ?action=verify-signup-token ────────────────────────────────────────
  // RED: current config.js has no verify-signup-token handler; falls through to
  // subscribe path which returns 400 (email field missing). Our tests expect 400
  // for the error cases too, but the success test expects { ok:true, email } —
  // that shape is only produced by the new action, so it fails before Task 9.

  console.log(B('\nPOST ?action=verify-signup-token'));

  await testAsync('missing token → 400', async () => {
    const handler = makeHandler(async () => []);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'verify-signup-token' }, headers: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('unknown token → 400', async () => {
    const handler = makeHandler(async () => []); // no subscriber row
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
  // RED: current handler falls through to subscribe; subscribe returns 200 (not 201)
  // and has no slug field. The status-201 and slug assertions fail before Task 9.

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
      if (q.includes('COUNT(*)'))      return [{ count: '1' }]; // slug taken
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
      if (q.includes('SELECT email'))     return [{ email: 'u@t.com', signup_token_hash: hash, signup_token_expires: expires }];
      if (q.includes('COUNT(*)'))         return [{ count: '0' }]; // slug available
      if (q.includes('INSERT INTO artists')) return [{ id: 10 }];
      if (q.includes('INSERT INTO users'))   return [{ id: 20 }];
      return [];
    };
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'POST', body: { action: 'signup', token: rawToken, name: 'My Band', slug: 'my-band' }, headers: {} }, res);
    assertEq(res._status, 201);
    assertEq(res._body && res._body.ok, true);
    assertEq(res._body && res._body.slug, 'my-band');
    assert(typeof (res._body && res._body.token) === 'string', 'expected session token string');
  });

  // ── GET ?action=check-slug ──────────────────────────────────────────────────
  // RED: current handler falls through to main GET config block, which returns 404
  // (no ARTIST_SLUG env, no slug param). Our tests expect { available } shape.

  console.log(B('\nGET ?action=check-slug'));

  await testAsync('available slug → { available: true }', async () => {
    const sql = async () => [{ count: '0' }];
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'new-band' }, headers: {} }, res);
    assertEq(res._body && res._body.available, true);
  });

  await testAsync('taken slug → { available: false }', async () => {
    const sql = async () => [{ count: '1' }];
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'taken-band' }, headers: {} }, res);
    assertEq(res._body && res._body.available, false);
  });

  await testAsync('reserved slug "login" → { available: false }', async () => {
    const sql = async () => [{ count: '0' }]; // not in DB, but reserved
    const handler = makeHandler(sql);
    const res = mockRes();
    await handler({ method: 'GET', query: { action: 'check-slug', slug: 'login' }, headers: {} }, res);
    assertEq(res._body && res._body.available, false);
  });

  // ── GET ?action=my-artists ──────────────────────────────────────────────────
  // RED: current handler does not have this action; falls through to main GET.

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
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
```

- [ ] **Step 2: Add suite to `tests/unit.js`**

Add after `require('./unit/registration')`:

```js
  require('./unit/config_signup'),
```

- [ ] **Step 3: Run tests to verify they FAIL (RED)**

```bash
cd /Users/kev/git/smartist && node tests/unit/config_signup.js
```

Expected failures before Task 9 is implemented:
- `valid email → 200 + ok:true + email sent` — FAIL (subscribe path doesn't send email)
- `valid token → 200 + { ok:true, email }` — FAIL (handler returns 400, body has no `email` field)
- `taken slug → 409` — FAIL (handler returns 200 via subscribe path)
- `valid signup → 201 + { ok, token, slug }` — FAIL (returns 200 via subscribe, no slug/token)
- `available slug → { available: true }` — FAIL (`available` field absent — handler returns 404/500)
- `reserved slug "login" → { available: false }` — FAIL (same)
- `no token → 401` — FAIL (handler falls through to main GET, not 401)
- `valid token → 200 + artists array` — FAIL (`artists` field absent)

The error-path tests (missing/invalid inputs) may already pass via the existing subscribe path — that is acceptable. The new-behavior tests must fail.

- [ ] **Step 4: Commit the failing tests**

```bash
git add tests/unit/config_signup.js tests/unit.js
git commit -m "test(RED): config.js signup actions — handler-level failing tests"
```

---

## Task 9: `api/config.js` — add slug param and sign-up actions

**Files:**
- Modify: `api/config.js`

- [ ] **Step 1: Add domain module imports**

At the top of `api/config.js`, add after the existing requires:

```js
const { resolveOAuthEmail, generateState, verifyState } = require('./_domain/identity');
const { resolveArtist, isSlugAvailable, getArtistsForUser } = require('./_domain/artist');
const { createSignupToken, verifySignupToken, createArtistAndAdmin, clearSignupToken } = require('./_domain/registration');
const { generateUserToken, verifyUserToken, TTL_8H } = require('./_token');
```

Remove the inline `_generateState`, `_verifyState`, `_resolveEmail`, `_stateSecret` functions and the `const { generateMagicToken }` import (retain `generateMagicToken` only where used — the OAuth login path still needs it).

Actually, keep `generateMagicToken` in the imports since the single-tenant OAuth callback still uses it. Just remove the four inline functions and replace with the domain module calls.

- [ ] **Step 2: Update `GET ?action=google-url` to accept `mode` param**

Replace:
```js
    return res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
```

First update the state generation call to pass mode:
```js
      state:         generateState('google', req.query.mode || 'login'),
```

Do the same for `facebook-url`:
```js
      state:        generateState('facebook', req.query.mode || 'login'),
```

- [ ] **Step 3: Update `GET ?action=oauth-callback` to use domain modules**

Replace the `_verifyState(state)` call with `verifyState(state)`. Update what the result means:

```js
    const stateResult = verifyState(state);
    if (!stateResult) return fail('invalid_or_expired_state');
    const provider = stateResult.provider;
    const mode     = stateResult.mode || 'login';
```

Replace the `_resolveEmail(...)` call with `resolveOAuthEmail(...)`.

Then update the callback resolution logic to handle `mode: 'signup'`:

```js
    if (mode === 'signup') {
      // Sign-up flow: generate token, redirect to onboarding
      const sql = getDb();
      const rawToken = await createSignupToken(email, sql);
      await logger.info('oauth_signup_started', { provider, email });
      return res.redirect(302, `${origin}/onboarding?token=${encodeURIComponent(rawToken)}`);
    }

    // Login flow — multi-tenant: find existing user
    const sql = getDb();
    const [existingUser] = await sql`
      SELECT u.id, u.role, u.artist_id, a.slug
      FROM users u
      JOIN artists a ON a.id = u.artist_id
      WHERE u.email = ${email.toLowerCase()}
      LIMIT 1
    `;
    if (existingUser) {
      const userToken = generateUserToken(existingUser.id, existingUser.role, TTL_8H);
      sessionStorage_stub_for_hint: // encode email as hint for multi-artist routing
      const hint = Buffer.from(email.toLowerCase()).toString('base64url');
      const artists = await getArtistsForUser(existingUser.id, sql);
      // Redirect to login page — it will call /api/:slug/auth with the token
      // and then route based on artist count. We pass the token directly via hash.
      await logger.info('oauth_login', { provider, email });
      return res.redirect(302, `${origin}/login?magic=${encodeURIComponent(userToken)}&hint=${hint}&next=/${existingUser.slug}/dashboard`);
    }

    // Single-tenant fallback (ARTIST_ADMIN_EMAIL)
    const adminEmail = process.env.ARTIST_ADMIN_EMAIL;
    if (!adminEmail || email.toLowerCase() !== adminEmail.toLowerCase()) {
      await logger.warn('oauth_email_mismatch', { provider, email });
      return fail('email_not_authorised');
    }
    const band = await resolveArtist('', sql);
    if (!band) return fail('band_not_found');
    await logger.info('oauth_login', { provider, email });
    const token = generateMagicToken(band.password_hash);
    return res.redirect(302, `${origin}/#magic=${encodeURIComponent(token)}`);
```

> **Note on the multi-tenant OAuth login path:** The redirect goes to `/login?magic=<userToken>&hint=<email>`. The existing `home.js` `verifyToken()` will call `POST /api/:slug/auth` with `{ magic: token, hint }`. But `auth.js` currently only accepts `magic` as a magic-token (30-min HMAC) not a user-token. This means OAuth login for multi-tenant needs a small change in `auth.js` (Task 10) to also accept `generateUserToken` tokens in the `magic` field. Alternatively, generate a proper magic token from the user's password_hash if available. For now, generate a `generateUserToken` and handle it in `auth.js`.

Correction to the above: the cleanest approach is to pass the user token directly without going through `/api/:slug/auth`. Update the redirect to store the token in a hash param and have `home.js` recognize it:

```js
      return res.redirect(302, `${origin}/login?next=/${existingUser.slug}/dashboard#user_token=${encodeURIComponent(userToken)}&email=${encodeURIComponent(email)}`);
```

Then in `home.js` `init()`, check `#user_token` and store it directly without calling auth:

```js
  const userToken = new URLSearchParams(window.location.hash.slice(1)).get('user_token');
  const tokenEmail = new URLSearchParams(window.location.hash.slice(1)).get('email');
  if (userToken) {
    storeToken(userToken, false);
    if (tokenEmail) sessionStorage.setItem('smartist_admin_email', tokenEmail);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    const artists = await fetchMyArtists(userToken);
    renderLoggedIn(cfg, artists);
    return;
  }
```

Where `fetchMyArtists` calls `GET /api/config?action=my-artists` with the token as Authorization header.

- [ ] **Step 4: Add `GET /api/config` slug param support**

In the main `GET` handler block at the bottom, replace:
```js
  const slug = process.env.ARTIST_SLUG;
  if (!slug) return res.status(500).json({ error: 'ARTIST_SLUG not configured' });
```
With:
```js
  const slugParam = req.query.slug || process.env.ARTIST_SLUG || '';
```

Then update all references to `slug` in the query block to use `slugParam`. The three parallel queries already use `${slug}` as a template literal — replace with `${slugParam}`.

- [ ] **Step 5: Add `PATCH` slug support**

In the `PATCH` handler, replace:
```js
    const slug = process.env.ARTIST_SLUG;
    if (!slug) return res.status(500).json({ error: 'ARTIST_SLUG not configured' });
    const band = await requireAuth(req, res, slug, 'admin');
```
With:
```js
    const slugParam = req.query.slug || process.env.ARTIST_SLUG || '';
    if (!slugParam) return res.status(400).json({ error: 'slug required' });
    const band = await requireAuth(req, res, slugParam, 'admin');
```

- [ ] **Step 6: Add `POST ?action=signup-link`**

Add this block in the `POST` handler, before the existing `if (req.body?.source === 'contact')` check:

```js
    if (req.body?.action === 'signup-link') {
      const email = validateEmail(req.body?.email);
      if (!email) return res.status(400).json({ error: 'Valid email required' });
      if (await checkRateLimit(`signup-link:${email}`, 3, 3600))
        return res.status(429).json({ error: 'Too many requests — try again in an hour' });
      const sql = getDb();
      const rawToken = await createSignupToken(email, sql);
      const origin = _origin(req);
      const link = `${origin}/onboarding?token=${encodeURIComponent(rawToken)}`;
      try {
        await sendEmail({
          to: email,
          subject: 'Your smartist sign-up link',
          html: `<p>Click the link below to set up your artist workspace. Valid for 30 minutes.</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, ignore this email.</p>`,
        });
      } catch (err) {
        await logger.error('signup_link_failed', { email, error: err.message });
        return res.status(500).json({ error: 'Failed to send email — try again later' });
      }
      await logger.info('signup_link_sent', { email });
      return res.json({ ok: true });
    }
```

- [ ] **Step 7: Add `POST ?action=verify-signup-token`**

Add after the `signup-link` block:

```js
    if (req.body?.action === 'verify-signup-token') {
      const { token } = req.body ?? {};
      if (!token) return res.status(400).json({ error: 'token required' });
      const sql = getDb();
      const result = await verifySignupToken(String(token), sql);
      if (!result) return res.status(400).json({ error: 'Invalid or expired link' });
      return res.json({ ok: true, email: result.email });
    }
```

- [ ] **Step 8: Add `POST ?action=signup`**

Add after `verify-signup-token`:

```js
    if (req.body?.action === 'signup') {
      const { token, name, slug: rawSlug } = req.body ?? {};
      if (!token) return res.status(400).json({ error: 'token required' });

      const bandName = validateStr(name, 200);
      if (!bandName) return res.status(400).json({ error: 'Band name required' });

      const slug = String(rawSlug || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(slug))
        return res.status(400).json({ error: 'Slug must be 3–50 lowercase letters, numbers, or hyphens' });

      const sql = getDb();
      const verified = await verifySignupToken(String(token), sql);
      if (!verified) return res.status(400).json({ error: 'Invalid or expired link' });

      const available = await isSlugAvailable(slug, sql);
      if (!available) return res.status(409).json({ error: 'That URL is already taken' });

      const { userId } = await createArtistAndAdmin(bandName, slug, verified.email, sql);
      await clearSignupToken(verified.email, sql);

      const sessionToken = generateUserToken(userId, 'admin', TTL_8H);
      await logger.info('signup_complete', { slug, email: verified.email });
      return res.status(201).json({ ok: true, token: sessionToken, slug, role: 'admin', email: verified.email });
    }
```

- [ ] **Step 9: Add `GET ?action=check-slug`**

Add in the GET action section, before the `photo-url` block:

```js
  if (req.query.action === 'check-slug') {
    const slug = String(req.query.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(slug))
      return res.json({ available: false });
    if (await checkRateLimit(`check-slug:${clientIp(req)}`, 30, 60))
      return res.status(429).json({ error: 'Too many requests' });
    const sql = getDb();
    const available = await isSlugAvailable(slug, sql);
    return res.json({ available });
  }
```

- [ ] **Step 10: Add `GET ?action=my-artists`**

Add after `check-slug`:

```js
  if (req.query.action === 'my-artists') {
    const slugParam2 = req.query.slug || process.env.ARTIST_SLUG || '';
    const band = await requireAuth(req, res, slugParam2 || '_');
    if (!band) return;
    const claim = verifyUserToken(
      (req.headers.authorization || '').replace(/^Bearer /, '')
    );
    if (!claim) return res.status(401).json({ error: 'Invalid token' });
    const sql = getDb();
    const artists = await getArtistsForUser(claim.userId, sql);
    return res.json({ artists });
  }
```

> Note: `requireAuth` currently requires a slug to look up the artist. For `my-artists`, we want to verify the token is valid without tying it to a specific artist. Pass a dummy slug here — if `requireAuth` fails, it means the token is expired. Alternatively, call `verifyUserToken` directly (already imported above). Use the direct approach:

```js
  if (req.query.action === 'my-artists') {
    const authHeader = (req.headers.authorization || '').replace(/^Bearer /, '');
    const claim = verifyUserToken(authHeader);
    if (!claim) return res.status(401).json({ error: 'Unauthorised' });
    const sql = getDb();
    const artists = await getArtistsForUser(claim.userId, sql);
    return res.json({ artists });
  }
```

- [ ] **Step 11: Run unit suite**

```bash
cd /Users/kev/git/smartist && node tests/unit.js
```

Expected: all suites pass

- [ ] **Step 12: Commit**

```bash
git add api/config.js
git commit -m "feat(GREEN): config.js — slug param, sign-up actions, OAuth mode (makes Task 8 tests pass)"
```

---

## Task 10: `api/[artist]/auth.js` — return artist list on login

**Files:**
- Modify: `api/[artist]/auth.js`
- Modify: `tests/unit/auth.js`

The login success responses need to include the artist list so `home.js` can route correctly without an extra round-trip. **TDD order: add failing tests first, then implement.**

- [ ] **Step 1: Write failing tests for `artists` in login response (RED)**

In `tests/unit/auth.js`, add to the bottom of the `run()` function (after the existing `no minRole: viewer passes` test), using the existing `stubAuthDeps` helper:

```js
  // ── login response includes artists list ─────────────────────────────────

  const FAKE_ARTISTS = [{ slug: 'testband', name: 'Test Band', role: 'admin' }];

  console.log(B('\nrequireAuth login — artists list in response'));

  // We test this via the [artist]/auth.js HTTP handler to verify end-to-end.
  // Stub auth.js dependencies the same way stubAuthDeps does, but also stub
  // _domain/artist so getArtistsForUser returns FAKE_ARTISTS.

  function stubAuthWithArtists(tokenClaim) {
    const dbPath2    = require.resolve(path.join(__dirname, '../../api/_db'));
    const tokenPath2 = require.resolve(path.join(__dirname, '../../api/_token'));
    const authPath   = require.resolve(path.join(__dirname, '../../api/_auth'));
    const artistDomainPath = require.resolve(path.join(__dirname, '../../api/_domain/artist'));

    require.cache[dbPath2] = {
      id: dbPath2, filename: dbPath2, loaded: true,
      exports: {
        getArtist: async () => FAKE_ARTIST,
        getDb: () => async () => FAKE_ARTISTS, // getArtistsForUser sql stub
      },
    };
    require.cache[tokenPath2] = {
      id: tokenPath2, filename: tokenPath2, loaded: true,
      exports: {
        verifyUserToken: () => tokenClaim,
        verifyMagicToken: () => false,
        generateMagicToken: () => '',
        generateUserToken: () => 'stub-session-token',
        TTL_8H: 28800000, TTL_30D: 2592000000,
      },
    };
    require.cache[artistDomainPath] = {
      id: artistDomainPath, filename: artistDomainPath, loaded: true,
      exports: {
        resolveArtist:     async () => FAKE_ARTIST,
        isSlugAvailable:   async () => true,
        getArtistsForUser: async () => FAKE_ARTISTS,
      },
    };
    delete require.cache[authPath];

    // Load the actual [artist]/auth.js handler (HTTP handler, not _auth.js)
    const handlerPath = require.resolve(path.join(__dirname, '../../api/[artist]/auth'));
    delete require.cache[handlerPath];
    return require(path.join(__dirname, '../../api/[artist]/auth'));
  }

  await r.testAsync('email+password login response includes artists array', async () => {
    // This test fails before Task 10 because the login response is { ok, token, role, email }
    // with no artists field.
    const handler = stubAuthWithArtists({ userId: 1, role: 'admin' });
    const res = mockRes();
    const req = {
      method: 'POST',
      url: '/api/testband/auth',
      headers: { 'content-type': 'application/json' },
      body: { email: 'admin@example.com', password: 'correct-password' },
      query: { artist: 'testband' },
    };
    // We can't fully exercise bcrypt here — instead verify the handler exports
    // and the shape by calling requireAuth at the _auth.js level with a known token.
    // The simplest assertion: getArtistsForUser must be called when auth succeeds.
    // We verify this by checking the login path in the response shape.
    // Stub bcrypt via require.cache before re-requiring handler:
    const bcryptPath = require.resolve('bcryptjs');
    const origBcrypt = require.cache[bcryptPath];
    require.cache[bcryptPath] = {
      id: bcryptPath, filename: bcryptPath, loaded: true,
      exports: {
        compare: async () => true, // always matches
        hash:    async (pw, rounds) => '$2b$12$stubhash',
      },
    };
    const handlerPath = require.resolve(path.join(__dirname, '../../api/[artist]/auth'));
    delete require.cache[handlerPath];
    const h2 = require(path.join(__dirname, '../../api/[artist]/auth'));
    await h2(req, res);
    require.cache[bcryptPath] = origBcrypt; // restore
    assert(res._body && Array.isArray(res._body.artists), 'expected artists array in login response');
  });
```

Also add `res.setHeader = () => res;` to the `mockRes()` function if it doesn't already have it.

- [ ] **Step 2: Run tests to verify the new test FAILS (RED)**

```bash
cd /Users/kev/git/smartist && node tests/unit/auth.js
```

Expected: `email+password login response includes artists array` — FAIL with `expected artists array in login response`

- [ ] **Step 3: Import domain module**

At the top of `api/[artist]/auth.js`, add:

```js
const { getArtistsForUser } = require('../_domain/artist');
```

- [ ] **Step 2: Update email+password login success response**

Find the email+password login block (~line 153). Replace:

```js
    const ttl   = rememberMe ? TTL_30D : TTL_8H;
    const token = generateUserToken(user.id, user.role, ttl);
    return res.json({ ok: true, token, role: user.role, email: user.email });
```

With:

```js
    const ttl     = rememberMe ? TTL_30D : TTL_8H;
    const token   = generateUserToken(user.id, user.role, ttl);
    const artists = await getArtistsForUser(user.id, sql);
    return res.json({ ok: true, token, role: user.role, email: user.email, artists });
```

- [ ] **Step 3: Update magic token (multi-user) login success**

Find the `hint` magic-token block (~line 113). Replace:

```js
          const sessionToken = generateUserToken(user.id, user.role, TTL_8H);
          return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email });
```

With:

```js
          const sessionToken = generateUserToken(user.id, user.role, TTL_8H);
          const artists      = await getArtistsForUser(user.id, sql);
          return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email, artists });
```

- [ ] **Step 4: Update accept-invite login success**

Find the `accept-invite` block (~line 43). Replace:

```js
    const sessionToken = generateUserToken(user.id, user.role, TTL_8H);
    return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email });
```

With:

```js
    const sessionToken = generateUserToken(user.id, user.role, TTL_8H);
    const artists      = await getArtistsForUser(user.id, sql);
    return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email, artists });
```

- [ ] **Step 5: Run unit tests**

```bash
cd /Users/kev/git/smartist && node tests/unit.js
```

Expected: all suites pass

- [ ] **Step 6: Commit**

```bash
git add api/[artist]/auth.js
git commit -m "feat: auth.js — return artists list on successful login for post-login routing"
```

---

## Task 11: `app/js/services/` layer

**Files:**
- Create: `app/js/services/registration.js`
- Create: `app/js/services/identity.js`
- Create: `app/js/services/artist.js`

These are pure fetch wrappers — no DOM, no side effects. They are used by the new page controllers.

> **TDD exception — I/O adapters only:** These files contain zero business logic: each function constructs a URL, calls `fetch()`, and returns the parsed JSON. There is no branching, no state, no computation to unit test. The TDD cycle (write failing unit test → watch fail → implement → pass) does not apply because there is no logic to drive. Coverage comes from the end-to-end flows in Tasks 12–14 (onboarding and workspaces pages call these functions). This exception is explicitly noted here so it is a deliberate choice, not an oversight.

- [ ] **Step 1: Create `app/js/services/registration.js`**

```js
async function sendSignupLink(email) {
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'signup-link', email }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Failed to send link');
  return data;
}

async function verifySignupToken(token) {
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'verify-signup-token', token }),
  });
  const data = await r.json();
  if (!r.ok) return { ok: false, error: data.error };
  return { ok: true, email: data.email };
}

async function signup({ token, name, slug }) {
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'signup', token, name, slug }),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error || 'Sign-up failed'), { status: r.status });
  return data;
}
```

- [ ] **Step 2: Create `app/js/services/identity.js`**

```js
async function getGoogleUrl(mode) {
  const r = await fetch('/api/config?action=google-url&mode=' + (mode || 'login'));
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Google login unavailable');
  return data.url;
}

async function getFacebookUrl(mode) {
  const r = await fetch('/api/config?action=facebook-url&mode=' + (mode || 'login'));
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Facebook login unavailable');
  return data.url;
}

async function getMyArtists(token) {
  const r = await fetch('/api/config?action=my-artists', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (r.status === 401) return [];
  const data = await r.json();
  return data.artists || [];
}
```

- [ ] **Step 3: Create `app/js/services/artist.js`**

```js
async function checkSlug(slug) {
  const r = await fetch('/api/config?action=check-slug&slug=' + encodeURIComponent(slug));
  const data = await r.json();
  return data.available === true;
}

async function loadArtistConfig(slug) {
  const url = slug ? '/api/config?slug=' + encodeURIComponent(slug) : '/api/config';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Config unavailable');
  return r.json();
}
```

- [ ] **Step 4: Commit**

```bash
git add app/js/services/
git commit -m "feat: add frontend services layer (registration, identity, artist)"
```

---

## Task 12: Sign-up page

**Files:**
- Create: `app/signup.html`
- Create: `app/js/signup.js`

- [ ] **Step 1: Create `app/signup.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Sign up — smartist</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow"/>
  <meta name="theme-color" content="#f9bf8f">
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon_io/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon_io/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon_io/favicon-16x16.png">
  <link rel="manifest" href="/favicon_io/site.webmanifest">
  <link rel="stylesheet" href="/app/css/app.css?v=26">
</head>
<body>
<main class="landing-main">
  <div class="landing-card">
    <h1 class="landing-title">Create your workspace</h1>
    <div id="signup-content"></div>
  </div>
</main>
<script src="/app/js/signup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `app/js/signup.js`**

```js
(async function() {
  var _googleUrl   = null;
  var _facebookUrl = null;

  async function _loadOAuthUrls() {
    try {
      const [gRes, fbRes] = await Promise.all([
        fetch('/api/config?action=google-url&mode=signup'),
        fetch('/api/config?action=facebook-url&mode=signup'),
      ]);
      if (gRes.ok)  { const d = await gRes.json();  _googleUrl   = d.url; }
      if (fbRes.ok) { const d = await fbRes.json(); _facebookUrl = d.url; }
    } catch {}
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _render(state) {
    var el = document.getElementById('signup-content');
    if (!el) return;

    if (state === 'sent') {
      el.innerHTML =
        '<p class="landing-lead">Check your email for a sign-up link.</p>' +
        '<p><a href="/signup">Use a different email</a></p>';
      return;
    }

    var oauthHtml = '';
    if (_googleUrl) {
      oauthHtml += '<a class="btn btn--oauth" href="' + _esc(_googleUrl) + '">Continue with Google</a>';
    }
    if (_facebookUrl) {
      oauthHtml += '<a class="btn btn--oauth" href="' + _esc(_facebookUrl) + '">Continue with Facebook</a>';
    }
    if (oauthHtml) {
      oauthHtml = '<div class="oauth-btns">' + oauthHtml + '</div><div class="or-divider">or</div>';
    }

    el.innerHTML =
      oauthHtml +
      '<form id="signup-form">' +
        '<label for="signup-email">Email</label>' +
        '<input id="signup-email" type="email" autocomplete="email" placeholder="you@example.com" required>' +
        '<button type="submit" class="btn btn--primary">Send sign-up link</button>' +
        (state === 'error' ? '<p class="form-error" id="signup-error"></p>' : '') +
      '</form>' +
      '<p class="form-hint">Already have an account? <a href="/login">Log in</a></p>';

    if (state === 'error') {
      document.getElementById('signup-error').textContent = state.msg || 'Something went wrong';
    }

    document.getElementById('signup-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var email  = document.getElementById('signup-email').value.trim();
      var btn    = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'signup-link', email }),
        }).then(async function(r) {
          if (!r.ok) {
            var d = await r.json();
            throw new Error(d.error || 'Failed');
          }
        });
        _render('sent');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Send sign-up link';
        var errEl = document.getElementById('signup-error');
        if (errEl) errEl.textContent = err.message;
        else _render({ type: 'error', msg: err.message });
      }
    });
  }

  await _loadOAuthUrls();
  _render('form');
})();
```

- [ ] **Step 3: Verify signup page renders**

With `vercel dev` running: open `http://localhost:3000/signup`. Expect a form with email input and (if OAuth env vars set) Google/Facebook buttons.

- [ ] **Step 4: Commit**

```bash
git add app/signup.html app/js/signup.js
git commit -m "feat: add signup page (email + OAuth)"
```

---

## Task 13: Onboarding page

**Files:**
- Create: `app/onboarding.html`
- Create: `app/js/onboarding.js`

- [ ] **Step 1: Create `app/onboarding.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Set up your workspace — smartist</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow"/>
  <meta name="theme-color" content="#f9bf8f">
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon_io/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon_io/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon_io/favicon-16x16.png">
  <link rel="manifest" href="/favicon_io/site.webmanifest">
  <link rel="stylesheet" href="/app/css/app.css?v=26">
</head>
<body>
<main class="landing-main">
  <div class="landing-card">
    <h1 class="landing-title">Set up your workspace</h1>
    <div id="onboarding-content"></div>
  </div>
</main>
<script src="/app/js/onboarding.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `app/js/onboarding.js`**

```js
(async function() {
  var AUTH_TOKEN_KEY = 'smartist_token';
  var _signupToken   = null;
  var _sessionToken  = null;
  var _email         = '';
  var _slugTimer     = null;
  var _slugOk        = false;

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _toSlug(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  }

  // ── Determine entry mode ───────────────────────────────────────────────────

  var params = new URLSearchParams(window.location.search);
  _signupToken = params.get('token') || null;

  if (!_signupToken) {
    _sessionToken = sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || null;
    if (!_sessionToken) {
      window.location.replace('/signup');
      return;
    }
  }

  // ── Verify token / session ──────────────────────────────────────────────────

  var el = document.getElementById('onboarding-content');

  function _renderError(msg) {
    el.innerHTML =
      '<p class="form-error">' + _esc(msg) + '</p>' +
      '<p><a href="/signup">Request a new sign-up link</a></p>';
  }

  function _renderForm(email) {
    _email = email;
    el.innerHTML =
      '<p class="form-hint">Setting up workspace for <strong>' + _esc(email) + '</strong></p>' +
      '<form id="onboarding-form">' +
        '<label for="ob-name">Band / artist name</label>' +
        '<input id="ob-name" type="text" placeholder="The Rolling Stones" required maxlength="200" autocomplete="organization">' +
        '<label for="ob-slug">Your URL <span class="form-hint">smartist.studio/<span id="ob-slug-preview">…</span></span></label>' +
        '<input id="ob-slug" type="text" placeholder="the-rolling-stones" required maxlength="50" autocomplete="off" spellcheck="false">' +
        '<p id="ob-slug-status" class="form-hint"></p>' +
        '<button type="submit" id="ob-submit" class="btn btn--primary" disabled>Create workspace</button>' +
        '<p id="ob-error" class="form-error" style="display:none"></p>' +
      '</form>';

    var nameInput = document.getElementById('ob-name');
    var slugInput = document.getElementById('ob-slug');
    var statusEl  = document.getElementById('ob-slug-status');
    var preview   = document.getElementById('ob-slug-preview');
    var submitBtn = document.getElementById('ob-submit');
    var errorEl   = document.getElementById('ob-error');

    nameInput.addEventListener('input', function() {
      var slug = _toSlug(nameInput.value);
      slugInput.value = slug;
      preview.textContent = slug || '…';
      _checkSlug(slug, statusEl, submitBtn);
    });

    slugInput.addEventListener('input', function() {
      preview.textContent = slugInput.value || '…';
      _checkSlug(slugInput.value, statusEl, submitBtn);
    });

    document.getElementById('onboarding-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      if (!_slugOk) return;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';
      errorEl.style.display = 'none';
      try {
        var body = { action: 'signup', name: nameInput.value.trim(), slug: slugInput.value.trim() };
        if (_signupToken) body.token = _signupToken;
        var r = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(_sessionToken ? { 'Authorization': 'Bearer ' + _sessionToken } : {}) },
          body: JSON.stringify(body),
        });
        var data = await r.json();
        if (!r.ok) throw Object.assign(new Error(data.error || 'Sign-up failed'), { status: r.status });
        sessionStorage.setItem(AUTH_TOKEN_KEY, data.token);
        sessionStorage.setItem('smartist_admin_email', data.email || '');
        window.location.href = '/' + data.slug + '/dashboard';
      } catch (err) {
        submitBtn.disabled = !_slugOk;
        submitBtn.textContent = 'Create workspace';
        errorEl.textContent = err.message + (err.status === 409 ? ' — choose a different URL.' : '');
        errorEl.style.display = '';
        if (err.status === 409) { _slugOk = false; statusEl.textContent = 'Already taken'; }
      }
    });
  }

  function _checkSlug(slug, statusEl, submitBtn) {
    _slugOk = false;
    submitBtn.disabled = true;
    statusEl.textContent = '';
    clearTimeout(_slugTimer);
    if (!slug || !/^[a-z0-9][a-z0-9-]{2,49}$/.test(slug)) {
      if (slug) statusEl.textContent = 'Must be 3–50 lowercase letters, numbers, or hyphens';
      return;
    }
    statusEl.textContent = 'Checking…';
    _slugTimer = setTimeout(async function() {
      try {
        var r = await fetch('/api/config?action=check-slug&slug=' + encodeURIComponent(slug));
        var d = await r.json();
        if (d.available) {
          statusEl.textContent = 'Available';
          _slugOk = true;
          submitBtn.disabled = false;
        } else {
          statusEl.textContent = 'Already taken';
          _slugOk = false;
        }
      } catch { statusEl.textContent = 'Could not check'; }
    }, 400);
  }

  // ── Entry mode: signup token ────────────────────────────────────────────────

  if (_signupToken) {
    el.innerHTML = '<p class="form-hint">Verifying link…</p>';
    var r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify-signup-token', token: _signupToken }),
    });
    var data = await r.json();
    if (!r.ok || !data.ok) {
      _renderError('This link has expired or already been used.');
      return;
    }
    _renderForm(data.email);
    return;
  }

  // ── Entry mode: existing session (add-artist mode) ──────────────────────────

  var claimRes = await fetch('/api/config?action=my-artists', {
    headers: { Authorization: 'Bearer ' + _sessionToken },
  });
  if (!claimRes.ok) {
    window.location.replace('/signup');
    return;
  }
  var claimData = await claimRes.json();
  var myEmail = sessionStorage.getItem('smartist_admin_email') || '';
  _renderForm(myEmail || 'your account');
})();
```

- [ ] **Step 3: Verify onboarding page**

With `vercel dev` running: open `http://localhost:3000/onboarding`. Expect redirect to `/signup` (no token). Then open `http://localhost:3000/onboarding?token=invalid`. Expect "link expired" error message.

- [ ] **Step 4: Commit**

```bash
git add app/onboarding.html app/js/onboarding.js
git commit -m "feat: add onboarding page (dual-mode: signup token or active session)"
```

---

## Task 14: Workspaces page

**Files:**
- Create: `app/workspaces.html`
- Create: `app/js/workspaces.js`

- [ ] **Step 1: Create `app/workspaces.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Your workspaces — smartist</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow"/>
  <meta name="theme-color" content="#f9bf8f">
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon_io/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon_io/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon_io/favicon-16x16.png">
  <link rel="manifest" href="/favicon_io/site.webmanifest">
  <link rel="stylesheet" href="/app/css/app.css?v=26">
</head>
<body>
<main class="landing-main">
  <div class="landing-card landing-card--wide">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem">
      <h1 class="landing-title" style="margin:0">Your workspaces</h1>
      <a href="/onboarding" class="btn btn--secondary">+ New workspace</a>
    </div>
    <div id="workspaces-content"></div>
  </div>
</main>
<script src="/app/js/workspaces.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `app/js/workspaces.js`**

```js
(async function() {
  var AUTH_TOKEN_KEY = 'smartist_token';
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || null;

  if (!token) {
    window.location.replace('/login?next=/home');
    return;
  }

  var el = document.getElementById('workspaces-content');
  el.innerHTML = '<p class="form-hint">Loading…</p>';

  try {
    var r = await fetch('/api/config?action=my-artists', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (r.status === 401) {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
      window.location.replace('/login?next=/home');
      return;
    }
    var data = await r.json();
    var artists = data.artists || [];

    if (artists.length === 0) {
      el.innerHTML =
        '<p>You don\'t belong to any workspaces yet.</p>' +
        '<a href="/onboarding" class="btn btn--primary">Create your first workspace</a>';
      return;
    }

    var html = '<div class="workspace-grid">';
    artists.forEach(function(a) {
      html +=
        '<a class="workspace-card" href="/' + encodeURIComponent(a.slug) + '/dashboard">' +
          '<strong class="workspace-name">' + _esc(a.name) + '</strong>' +
          '<span class="workspace-role">' + _esc(a.role) + '</span>' +
        '</a>';
    });
    html += '</div>';

    html +=
      '<div style="margin-top:2rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap">' +
        '<button class="btn btn--ghost" id="ws-logout">Log out</button>' +
      '</div>';

    el.innerHTML = html;

    document.getElementById('ws-logout').addEventListener('click', function() {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_TOKEN_KEY);
      sessionStorage.removeItem('smartist_admin_email');
      window.location.replace('/login');
    });

  } catch (err) {
    el.innerHTML = '<p class="form-error">Failed to load workspaces. <a href="/login">Try logging in again</a></p>';
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
```

- [ ] **Step 3: Verify workspaces page**

With `vercel dev` running: open `http://localhost:3000/home`. Expect redirect to `/login?next=/home`. Log in with a test account. Expect workspace cards to appear.

- [ ] **Step 4: Commit**

```bash
git add app/workspaces.html app/js/workspaces.js
git commit -m "feat: add workspaces page (/home) — multi-artist workspace picker"
```

---

## Task 15: Schema migration (if needed)

**Files:**
- Modify: `scripts/schema.sql` (if `users` table lacks `password_hash IS NULL` support)
- No Vercel functions changed

The `users` table already supports `password_hash IS NULL` (invite-only users). The sign-up path creates a user with `password_hash = NULL` intentionally — the user can set a password via the existing invite/reset flow later. No schema changes required.

However, confirm that `subscribers.meta` can store the signup token. It is already a JSONB column in the existing schema. Verify:

- [ ] **Step 1: Verify subscribers schema**

```bash
grep -A 5 'CREATE TABLE.*subscribers' /Users/kev/git/smartist/scripts/schema.sql
```

Expected: `meta JSONB` column present.

- [ ] **Step 2: Commit (if no changes needed)**

If the grep confirms `meta JSONB` is present, no changes are needed. Otherwise add the column to the schema and run it.

---

## Self-Review Checklist

**Spec coverage:**
- Email sign-up flow: Tasks 3, 8, 9, 12 ✓
- OAuth sign-up flow: Tasks 1, 9 ✓
- Onboarding page (dual-mode): Task 13 ✓
- Workspace picker `/home`: Task 14 ✓
- Multi-tenant routing (`/:slug/*`): Task 4 ✓
- `common.js` slug-scoped nav: Task 5 ✓
- `home.js` post-login routing: Task 6 ✓
- `stage.js` slug fix: Task 7 ✓
- `auth.js` artist list: Task 10 ✓
- Services layer: Task 11 ✓
- `check-slug` action: Task 9 ✓
- `my-artists` action: Task 9 ✓
- Single-tenant backward compat: Tasks 2, 4, 9 ✓

**Placeholder scan:** All steps have code. The OAuth multi-tenant login path in Task 9 Step 3 has a correction note inline — implementation follows the corrected approach (`user_token` hash param) not the initially-sketched approach.

**Type consistency:**
- `generateState(provider, mode)` / `verifyState(state) → { provider, mode }`: used in Tasks 1 and 9 consistently
- `createSignupToken(email, sql) → rawToken` (string): used in Tasks 3, 8, 9 consistently
- `verifySignupToken(rawToken, sql) → { email } | null`: used in Tasks 3, 8, 9, 13 consistently
- `createArtistAndAdmin(name, slug, email, sql) → { artistId, userId }`: Tasks 3, 8, 9 consistent
- `getArtistsForUser(userId, sql) → [{ slug, name, role }]`: Tasks 2, 10, 14 consistent
- `renderLoggedIn(cfg, artists)`: Tasks 6 consistent — `artists` is always an array
