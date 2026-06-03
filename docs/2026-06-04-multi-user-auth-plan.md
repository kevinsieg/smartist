# Multi-User Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email+password multi-user login with predefined roles (admin/member/viewer), remember-me, and admin user management with email invites.

**Architecture:** New `users` table keyed to `artist_id`. `api/[artist]/auth.js` issues self-contained HMAC-signed tokens (`{userId, role, exp}`) on login, signed with `APP_SECRET`. Bootstrap fallback: if no users exist for an artist, the old single-password login still works, so existing installs are never locked out. User management folds into the existing auth handler to stay within the 12-function limit.

**Tech Stack:** Node.js `crypto` (built-in, HMAC-SHA256), `bcryptjs` (already in use), Neon PostgreSQL via `_db.js`.

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `scripts/schema.sql` | Modify | Add `users` table |
| `api/_token.js` | Modify | Add `generateUserToken`, `verifyUserToken`, export `TTL_8H`, `TTL_30D` |
| `api/_auth.js` | Rewrite | Update `requireAuth` (user token + bootstrap fallback), add `requireRole` |
| `api/[artist]/auth.js` | Rewrite | Multi-user login, magic token reset, user management actions |
| `app/js/common.js` | Modify | `getToken()`, `isViewMode()`, `requireLogin()`, `updateAuthIndicator()`, `doLogout()`, `apiFetch()` — all now check both sessionStorage and localStorage. Add `getAuthRole()`. Add Users nav link + admin-only CSS class. |
| `app/css/app.css` | Modify | Add `.admin-only` hide rule |
| `app/js/home.js` | Rewrite | Login form with email + remember me; invite acceptance; magic token with hint |
| `app/users.html` | Create | Users management page |
| `app/js/users.js` | Create | Users management logic |
| `vercel.json` | Modify | Add `/users` route |
| `tests/unit.js` | Modify | Unit tests for `generateUserToken` / `verifyUserToken` |

---

## Task 1: DB schema — add users table

**Files:**
- Modify: `scripts/schema.sql`
- Modify: `.env`

- [ ] **Step 1: Append users table to schema.sql**

At the end of `scripts/schema.sql`, after the `subscribers` table block, add:

```sql
-- ── users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  artist_id         INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  password_hash     TEXT,                    -- NULL until invite accepted
  role              TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('admin', 'member', 'viewer')),
  invite_token_hash TEXT,                    -- SHA256(raw token); NULL after accepted
  invite_expires_at TIMESTAMPTZ,
  invited_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artist_id, email)
);
```

- [ ] **Step 2: Generate APP_SECRET and add to .env**

Run this to generate the secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add the output as a new line in `.env`:
```
APP_SECRET=<paste generated value here>
```

- [ ] **Step 3: Apply schema to dev DB**

```bash
node scripts/setup.js
```

Expected: script runs without error and reports the `users` table (creates it or confirms it already exists).

- [ ] **Step 4: Commit**

```bash
git add scripts/schema.sql
git commit -m "feat: add users table to schema"
```

---

## Task 2: Token layer (TDD)

**Files:**
- Modify: `tests/unit.js`
- Modify: `api/_token.js`

- [ ] **Step 1: Write failing unit tests in tests/unit.js**

Append to `tests/unit.js` after the existing token tests:

```js
// ── User token tests ─────────────────────────────────────────────────────────
process.env.APP_SECRET = 'test-secret-exactly-32-bytes-ok!';
delete require.cache[require.resolve('../api/_token')];
const { generateUserToken, verifyUserToken } = require('../api/_token');
console.log('\n── generateUserToken / verifyUserToken ──');

// Round-trip
{
  const tok = generateUserToken(42, 'admin', 8 * 60 * 60 * 1000);
  assert(typeof tok === 'string' && tok.length > 10, 'produces a string');
  const claim = verifyUserToken(tok);
  assert(claim !== null, 'valid token verifies');
  assert.strictEqual(claim.userId, 42, 'userId preserved');
  assert.strictEqual(claim.role, 'admin', 'role preserved');
  console.log('  ✓ round-trip');
}

// Expired
{
  const tok = generateUserToken(1, 'member', -1000);
  assert.strictEqual(verifyUserToken(tok), null, 'expired rejected');
  console.log('  ✓ expired token rejected');
}

// Tampered
{
  const tok = generateUserToken(1, 'viewer', 8 * 60 * 60 * 1000);
  assert.strictEqual(verifyUserToken(tok.slice(0, -4) + 'ZZZZ'), null, 'tamper rejected');
  console.log('  ✓ tampered token rejected');
}

// Null / garbage
{
  assert.strictEqual(verifyUserToken(null), null, 'null rejected');
  assert.strictEqual(verifyUserToken('notatoken'), null, 'garbage rejected');
  console.log('  ✓ null/garbage rejected');
}

// Wrong secret
{
  const tok = generateUserToken(1, 'admin', 8 * 60 * 60 * 1000);
  process.env.APP_SECRET = 'different-secret-32-bytes-here!!';
  delete require.cache[require.resolve('../api/_token')];
  const { verifyUserToken: verifyWrong } = require('../api/_token');
  assert.strictEqual(verifyWrong(tok), null, 'wrong secret rejected');
  process.env.APP_SECRET = 'test-secret-exactly-32-bytes-ok!';
  console.log('  ✓ wrong secret rejected');
}
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
node tests/unit.js
```

Expected: error like `ReferenceError: generateUserToken is not defined`.

- [ ] **Step 3: Implement in api/_token.js**

Add after the existing `verifyMagicToken` function, before `module.exports`:

```js
const TTL_8H  =  8 * 60 * 60 * 1000;
const TTL_30D = 30 * 24 * 60 * 60 * 1000;

function generateUserToken(userId, role, ttlMs) {
  const exp     = Date.now() + ttlMs;
  const payload = JSON.stringify({ userId, role, exp });
  const sig     = crypto.createHmac('sha256', process.env.APP_SECRET)
    .update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

function verifyUserToken(token) {
  try {
    if (!token) return null;
    const { payload, sig } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expected = crypto.createHmac('sha256', process.env.APP_SECRET)
      .update(payload).digest('hex');
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const { userId, role, exp } = JSON.parse(payload);
    if (Date.now() > Number(exp)) return null;
    return { userId, role };
  } catch { return null; }
}
```

Update `module.exports` to:
```js
module.exports = { generateMagicToken, verifyMagicToken, generateUserToken, verifyUserToken, TTL_8H, TTL_30D };
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
node tests/unit.js
```

Expected: all `✓` lines print, no errors.

- [ ] **Step 5: Commit**

```bash
git add api/_token.js tests/unit.js
git commit -m "feat: generateUserToken and verifyUserToken with unit tests"
```

---

## Task 3: Auth middleware — requireAuth + requireRole

**Files:**
- Rewrite: `api/_auth.js`

- [ ] **Step 1: Replace entire api/_auth.js**

```js
const bcrypt = require('bcryptjs');
const { getArtist, getDb } = require('./_db');
const { verifyMagicToken, verifyUserToken } = require('./_token');

const ROLE_ORDER = ['viewer', 'member', 'admin'];

async function checkCredentials(token, artist) {
  return verifyMagicToken(token, artist.password_hash) ||
         await bcrypt.compare(token, artist.password_hash);
}

async function requireAuth(req, res, slug) {
  const header = req.headers.authorization ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }

  const artist = await getArtist(slug);
  if (!artist) { res.status(404).json({ error: 'Artist not found' }); return null; }

  // New user token
  const claim = verifyUserToken(token);
  if (claim) {
    req.user = { id: claim.userId, role: claim.role };
    return artist;
  }

  // Bootstrap fallback: accept old credentials only when no users exist yet
  const sql = getDb();
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE artist_id = ${artist.id}`;
  if (count === 0 && await checkCredentials(token, artist)) {
    req.user = { id: null, role: 'admin' };
    return artist;
  }

  res.status(401).json({ error: 'Unauthorized' });
  return null;
}

function requireRole(req, res, minRole) {
  const userRole = req.user?.role || 'admin';
  if (ROLE_ORDER.indexOf(userRole) < ROLE_ORDER.indexOf(minRole)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

module.exports = { requireAuth, requireRole, checkCredentials };
```

- [ ] **Step 2: Run unit tests to confirm nothing broke**

```bash
node tests/unit.js
```

Expected: all pass (unit tests don't exercise `_auth.js` directly).

- [ ] **Step 3: Commit**

```bash
git add api/_auth.js
git commit -m "feat: requireAuth supports user tokens with bootstrap fallback; add requireRole"
```

---

## Task 4: Auth API rewrite

**Files:**
- Rewrite: `api/[artist]/auth.js`

- [ ] **Step 1: Replace entire api/[artist]/auth.js**

```js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getArtist, getDb, getSlug }            = require('../_db');
const { checkCredentials, requireAuth, requireRole } = require('../_auth');
const { generateUserToken, generateMagicToken, verifyMagicToken, TTL_8H, TTL_30D } = require('../_token');
const { sendEmail }    = require('../_email');
const { wrap }         = require('../_handler');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { validateStr }  = require('../_validate');
const logger           = require('../_logger');

module.exports = wrap(async function handler(req, res) {
  const slug   = getSlug(req);
  const sql    = getDb();
  const action = new URL(req.url, 'http://x').searchParams.get('action') || '';

  // ── Accept invite (public — no auth) ─────────────────────────────────────
  if (req.method === 'POST' && action === 'accept-invite') {
    const { token, password } = req.body ?? {};
    if (!token || !password)             return res.status(400).json({ error: 'token and password required' });
    if (String(password).length < 8)     return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (String(password).length > 1000)  return res.status(400).json({ error: 'Password too long' });

    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Not found' });

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const [user] = await sql`
      SELECT * FROM users
      WHERE artist_id = ${band.id}
        AND invite_token_hash = ${tokenHash}
        AND invite_expires_at > now()
        AND password_hash IS NULL
    `;
    if (!user) return res.status(400).json({ error: 'Invalid or expired invite' });

    const hash = await bcrypt.hash(password, 12);
    await sql`
      UPDATE users
      SET password_hash = ${hash}, invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = ${user.id}
    `;
    const sessionToken = generateUserToken(user.id, user.role, TTL_8H);
    return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email });
  }

  // ── Password reset request (via /api/:artist/request-reset rewrite) ───────
  if (req.method === 'POST' && req.url.includes('request-reset')) {
    const { email } = req.body ?? {};
    if (await checkRateLimit(`reset:${clientIp(req)}`, 3, 600))
      return res.json({ ok: true }); // silent

    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Not found' });

    const cleanEmail = String(email || '').trim().toLowerCase();
    const [user] = await sql`
      SELECT * FROM users
      WHERE artist_id = ${band.id} AND email = ${cleanEmail} AND password_hash IS NOT NULL
    `;

    let resetEmail, tokenSeed;
    if (user) {
      resetEmail = user.email;
      tokenSeed  = user.password_hash;
    } else {
      // Bootstrap fallback: match ARTIST_ADMIN_EMAIL
      const adminEmail = process.env.ARTIST_ADMIN_EMAIL;
      if (!adminEmail || cleanEmail !== adminEmail.toLowerCase()) return res.json({ ok: true });
      resetEmail = adminEmail;
      tokenSeed  = band.password_hash;
    }

    const resetToken = generateMagicToken(tokenSeed);
    const h      = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const origin = process.env.APP_ORIGIN || `${h.includes('localhost') ? 'http' : 'https'}://${h}`;
    // Encode email as hint so client can pass it back for user lookup
    const hint   = Buffer.from(resetEmail).toString('base64url');
    const link   = `${origin}/login?magic=${encodeURIComponent(resetToken)}&hint=${hint}`;

    try {
      await sendEmail({
        to: resetEmail,
        subject: 'Login link',
        html: `<p>Here is your login link:</p><p><a href="${link}">${link}</a></p><p>Valid for 30 minutes. Do not share this link.</p>`,
      });
    } catch (err) {
      await logger.error('request_reset_failed', { band: slug, error: err.message });
      return res.status(500).json({ error: 'Failed to send email' });
    }
    return res.json({ ok: true });
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && !action) {
    const { email, password, rememberMe, magic, hint } = req.body ?? {};

    // Magic token login (password reset link click)
    if (magic) {
      if (await checkRateLimit(`auth:${clientIp(req)}`, 10, 60))
        return res.status(429).json({ error: 'Too many attempts — try again later' });
      const band = await getArtist(slug);
      if (!band) return res.status(404).json({ error: 'Not found' });

      if (hint) {
        // Multi-user magic: decode email from hint, verify against user's password_hash
        const hintEmail = Buffer.from(hint, 'base64url').toString().toLowerCase();
        const [user] = await sql`
          SELECT * FROM users
          WHERE artist_id = ${band.id} AND email = ${hintEmail} AND password_hash IS NOT NULL
        `;
        if (user && verifyMagicToken(magic, user.password_hash)) {
          const sessionToken = generateUserToken(user.id, user.role, TTL_8H);
          return res.json({ ok: true, token: sessionToken, role: user.role, email: user.email });
        }
        return res.status(401).json({ error: 'Invalid or expired login link' });
      }
      // Bootstrap magic token (no hint → single-user install)
      if (await checkCredentials(magic, band)) {
        return res.json({ ok: true, adminEmail: process.env.ARTIST_ADMIN_EMAIL || null });
      }
      return res.status(401).json({ error: 'Invalid or expired login link' });
    }

    // Legacy bootstrap: password-only (no email field, old installs)
    if (!email && password) {
      if (String(password).length > 1000) return res.status(400).json({ error: 'Invalid' });
      if (await checkRateLimit(`auth:${clientIp(req)}`, 10, 60))
        return res.status(429).json({ error: 'Too many attempts — try again later' });
      const band = await getArtist(slug);
      if (!band) return res.status(404).json({ error: 'Artist not found' });
      if (!await checkCredentials(password, band)) return res.status(401).json({ error: 'Invalid password' });
      return res.json({ ok: true, adminEmail: process.env.ARTIST_ADMIN_EMAIL || null });
    }

    // Email + password login
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (await checkRateLimit(`auth:${clientIp(req)}`, 10, 60))
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    const band = await getArtist(slug);
    if (!band) return res.status(404).json({ error: 'Artist not found' });

    const [user] = await sql`
      SELECT * FROM users
      WHERE artist_id = ${band.id}
        AND email = ${String(email).trim().toLowerCase()}
        AND password_hash IS NOT NULL
    `;
    if (!user || !await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });

    const ttl   = rememberMe ? TTL_30D : TTL_8H;
    const token = generateUserToken(user.id, user.role, ttl);
    return res.json({ ok: true, token, role: user.role, email: user.email });
  }

  // ── Authenticated actions ─────────────────────────────────────────────────
  const artist = await requireAuth(req, res, slug);
  if (!artist) return;

  // GET — list users (admin)
  if (req.method === 'GET') {
    if (!requireRole(req, res, 'admin')) return;
    const users = await sql`
      SELECT id, email, role, created_at,
             (password_hash IS NOT NULL)                                    AS accepted,
             (invite_token_hash IS NOT NULL AND invite_expires_at > now())  AS invite_pending
      FROM users WHERE artist_id = ${artist.id}
      ORDER BY created_at
    `;
    return res.json({ users });
  }

  // POST ?action=invite — send invite (admin)
  if (req.method === 'POST' && action === 'invite') {
    if (!requireRole(req, res, 'admin')) return;
    const { email, role } = req.body ?? {};
    const cleanEmail = validateStr(email, 200);
    if (!cleanEmail) return res.status(400).json({ error: 'Email required' });
    if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const [existing] = await sql`SELECT id FROM users WHERE artist_id = ${artist.id} AND email = ${cleanEmail.toLowerCase()}`;
    if (existing) return res.status(409).json({ error: 'User already exists' });

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [newUser] = await sql`
      INSERT INTO users (artist_id, email, role, invite_token_hash, invite_expires_at, invited_by)
      VALUES (${artist.id}, ${cleanEmail.toLowerCase()}, ${role}, ${tokenHash}, ${expires}, ${req.user.id})
      RETURNING id, email, role
    `;

    const h      = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const origin = process.env.APP_ORIGIN || `${h.includes('localhost') ? 'http' : 'https'}://${h}`;
    const link   = `${origin}/login?invite=${rawToken}`;

    try {
      await sendEmail({
        to: cleanEmail,
        subject: `You've been invited to ${artist.name}`,
        html: `<p>You've been invited to access ${artist.name} on smartist.</p>
               <p><a href="${link}">Accept invite and set your password</a></p>
               <p>This link expires in 7 days.</p>`,
      });
    } catch (err) {
      await sql`DELETE FROM users WHERE id = ${newUser.id}`;
      return res.status(500).json({ error: 'Failed to send invite email' });
    }
    return res.status(201).json({ ok: true, user: newUser });
  }

  // POST ?action=resend-invite (admin)
  if (req.method === 'POST' && action === 'resend-invite') {
    if (!requireRole(req, res, 'admin')) return;
    const { userId } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const [user] = await sql`
      SELECT * FROM users WHERE id = ${Number(userId)} AND artist_id = ${artist.id} AND password_hash IS NULL
    `;
    if (!user) return res.status(404).json({ error: 'Pending invite not found' });

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await sql`UPDATE users SET invite_token_hash = ${tokenHash}, invite_expires_at = ${expires} WHERE id = ${user.id}`;

    const h      = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const origin = process.env.APP_ORIGIN || `${h.includes('localhost') ? 'http' : 'https'}://${h}`;
    const link   = `${origin}/login?invite=${rawToken}`;

    try {
      await sendEmail({
        to: user.email,
        subject: `Invite reminder — ${artist.name}`,
        html: `<p>Here is your updated invite link for ${artist.name}:</p>
               <p><a href="${link}">Accept invite and set your password</a></p>
               <p>This link expires in 7 days.</p>`,
      });
    } catch { return res.status(500).json({ error: 'Failed to send email' }); }
    return res.json({ ok: true });
  }

  // PUT — update user role (admin)
  if (req.method === 'PUT') {
    if (!requireRole(req, res, 'admin')) return;
    const { userId, role } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (req.user.id && req.user.id === Number(userId)) return res.status(400).json({ error: 'Cannot change your own role' });

    const [updated] = await sql`
      UPDATE users SET role = ${role}
      WHERE id = ${Number(userId)} AND artist_id = ${artist.id}
      RETURNING id, email, role
    `;
    if (!updated) return res.status(404).json({ error: 'User not found' });
    return res.json({ ok: true, user: updated });
  }

  // DELETE — remove user (admin)
  if (req.method === 'DELETE') {
    if (!requireRole(req, res, 'admin')) return;
    const { userId } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (req.user.id && req.user.id === Number(userId)) return res.status(400).json({ error: 'Cannot remove yourself' });

    const [deleted] = await sql`
      DELETE FROM users WHERE id = ${Number(userId)} AND artist_id = ${artist.id} RETURNING id
    `;
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
});
```

- [ ] **Step 2: Verify no syntax errors**

```bash
node -e "require('./api/[artist]/auth.js')" 2>&1; echo "exit $?"
```

Expected: `exit 0` (no error output, or only a "module not found" for `_db` which is normal outside vercel dev).

- [ ] **Step 3: Run unit tests**

```bash
node tests/unit.js
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add "api/[artist]/auth.js"
git commit -m "feat: rewrite auth handler for multi-user login and user management"
```

---

## Task 5: common.js — token storage, getAuthRole, admin-only

**Files:**
- Modify: `app/js/common.js`
- Modify: `app/css/app.css`

Read `app/js/common.js` before editing. Key lines to change: 347, 474, 512–514, 554, 563.

- [ ] **Step 1: Update getToken() at line 563**

Replace:
```js
function getToken() { return sessionStorage.getItem(AUTH_TOKEN_KEY); }
```
With:
```js
function getToken() {
  return sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || null;
}
```

- [ ] **Step 2: Update isViewMode() at line 346**

Replace:
```js
function isViewMode() {
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) return true;
  if (_isTokenExpired(token)) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    return true;
  }
  return false;
}
```
With:
```js
function isViewMode() {
  var token = getToken();
  if (!token) return true;
  if (_isTokenExpired(token)) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    return true;
  }
  return false;
}
```

Note: `getToken()` is defined later in the file (line 563). Since both are `function` declarations (hoisted), the order doesn't matter.

- [ ] **Step 3: Update requireLogin() at line 553**

Replace:
```js
function requireLogin() {
  if (!sessionStorage.getItem(AUTH_TOKEN_KEY)) {
    goToLogin();
    return true;
  }
  return false;
}
```
With:
```js
function requireLogin() {
  if (!getToken()) {
    goToLogin();
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Update updateAuthIndicator() at line 474**

Replace:
```js
  var _tok = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (_tok && _isTokenExpired(_tok)) { sessionStorage.removeItem(AUTH_TOKEN_KEY); _tok = null; }
  var authed = !!_tok;
  var header = document.querySelector('.app-header');
  if (header) header.classList.toggle('app-header--authed', authed);
```
With:
```js
  var _tok = getToken();
  if (_tok && _isTokenExpired(_tok)) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    _tok = null;
  }
  var authed = !!_tok;
  var _role  = authed ? getAuthRole() : null;
  var header = document.querySelector('.app-header');
  if (header) {
    header.classList.toggle('app-header--authed', authed);
    header.classList.toggle('app-header--admin',  _role === 'admin');
  }
```

- [ ] **Step 5: Update doLogout() at line 512**

Replace:
```js
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem('smartist_admin_email');
```
With:
```js
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem('smartist_admin_email');
```

- [ ] **Step 6: Update apiFetch() at line 567 to use getToken()**

The function already calls `getToken()` — no change needed (it will now pick up localStorage tokens automatically via the updated `getToken()`).

- [ ] **Step 7: Add getAuthRole() after getToken()**

After the `getToken()` line, add:

```js
function getAuthRole() {
  var tok = getToken();
  if (!tok) return null;
  try {
    var b64 = tok.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var outer = JSON.parse(atob(b64));
    if (!outer.payload) return null;
    return JSON.parse(outer.payload).role || null;
  } catch { return null; }
}
```

- [ ] **Step 8: Add Users link to nav shell in injectShell()**

In `app/js/common.js`, find this exact line (around line 56):
```js
'<a href="/pro-import" class="auth-only">PRO</a>' +
```

Change it to:
```js
'<a href="/pro-import" class="auth-only">PRO</a>' +
'<a href="/users" class="admin-only">Users</a>' +
```

- [ ] **Step 9: Add .admin-only CSS to app.css**

Find the line in `app/css/app.css` that hides `.auth-only` elements (the rule with `.app-header:not(.app-header--authed) .auth-only`). Immediately after it, add:

```css
.app-header:not(.app-header--admin) .admin-only { display: none !important; }
```

- [ ] **Step 10: Bump common.js and CSS version references**

In `app/css/app.css` and in any HTML file that references `common.js?v=11`, bump to `v=12`. Update the `app.css?v=25` reference in HTML files to `v=26`.

Specifically:
- All `<link rel="stylesheet" href="/app/css/app.css?v=25">` → `v=26`
- All `<script src="/app/js/common.js?v=11">` → `v=12`

Run:
```bash
grep -rl "app.css?v=25" app/ | xargs sed -i '' 's/app\.css?v=25/app.css?v=26/g'
grep -rl "common.js?v=11" app/ | xargs sed -i '' 's/common\.js?v=11/common.js?v=12/g'
```

- [ ] **Step 11: Smoke test**

Start `vercel dev` and open the app. Confirm:
- Login still works with the old password (bootstrap mode, no users in DB yet)
- No console errors
- After login, no "Users" nav link visible (bootstrap mode returns `role: null` from `getAuthRole()`)

- [ ] **Step 12: Commit**

```bash
git add app/js/common.js app/css/app.css app/
git commit -m "feat: multi-store token handling, getAuthRole, admin-only nav"
```

---

## Task 6: Login form — home.js rewrite

**Files:**
- Rewrite: `app/js/home.js`

Read `app/js/home.js` before editing.

- [ ] **Step 1: Add storeToken() helper before renderLogin()**

Add this new function before `renderLogin`:

```js
function storeToken(token, remember) {
  if (remember) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
  } else {
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}
```

- [ ] **Step 2: Replace renderLogin()**

Replace the entire `renderLogin(errorMsg, cfg)` function:

```js
function renderLogin(errorMsg, cfg) {
  const el = document.getElementById('landing-auth');
  if (!el) return;

  const showGoogle   = !!cfg?.googleLogin;
  const showFacebook = !!cfg?.facebookLogin;
  const showOAuth    = showGoogle || showFacebook;

  const oauthHtml = !showOAuth ? '' :
    '<div class="oauth-btns">' +
      (showGoogle   ? '<button class="btn oauth-btn" id="google-btn">Continue with Google</button>'   : '') +
      (showFacebook ? '<button class="btn oauth-btn" id="facebook-btn">Continue with Facebook</button>' : '') +
    '</div>' +
    '<div class="auth-divider"><span>or</span></div>';

  el.innerHTML =
    '<div class="landing-login">' +
      oauthHtml +
      '<div class="auth-field">' +
        '<label class="auth-label" for="email-input">Email</label>' +
        '<input type="email" id="email-input" placeholder="you@band.com" autocomplete="email">' +
      '</div>' +
      '<div class="auth-field">' +
        '<label class="auth-label" for="pw-input">Password</label>' +
        '<div class="pw-wrapper">' +
          '<input type="password" id="pw-input" placeholder="••••••••" autocomplete="current-password">' +
          '<button type="button" class="pw-toggle" id="pw-toggle">show</button>' +
        '</div>' +
      '</div>' +
      '<div class="auth-remember">' +
        '<label class="auth-remember-label"><input type="checkbox" id="remember-me"> Remember me</label>' +
      '</div>' +
      '<div class="auth-error" id="auth-error">' + (errorMsg || '') + '</div>' +
      '<button class="btn active auth-submit" id="pw-btn">Sign in</button>' +
      '<button class="reset-link" id="reset-toggle">Forgot password?</button>' +
      '<div class="reset-form" id="reset-form" style="display:none">' +
        '<div class="auth-row">' +
          '<input type="email" id="reset-email" placeholder="Email address" autocomplete="email">' +
          '<button class="btn" id="reset-btn">Send link</button>' +
        '</div>' +
        '<div class="auth-error" id="reset-msg"></div>' +
      '</div>' +
      '<div class="auth-view-hint">No account? <a href="/songs">Browse in view mode →</a></div>' +
    '</div>';

  if (showGoogle)   document.getElementById('google-btn').addEventListener('click', () => startOAuth('google'));
  if (showFacebook) document.getElementById('facebook-btn').addEventListener('click', () => startOAuth('facebook'));
  document.getElementById('pw-btn').addEventListener('click', doLogin);
  document.getElementById('email-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('pw-input').focus(); });
  document.getElementById('pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('pw-toggle').addEventListener('click', () => {
    const input = document.getElementById('pw-input');
    const btn   = document.getElementById('pw-toggle');
    const show  = input.type === 'password';
    input.type      = show ? 'text' : 'password';
    btn.textContent = show ? 'hide' : 'show';
  });
  document.getElementById('reset-toggle').addEventListener('click', () => {
    const form = document.getElementById('reset-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
    if (form.style.display !== 'none') document.getElementById('reset-email').focus();
  });
  document.getElementById('reset-btn').addEventListener('click', doRequestReset);
  document.getElementById('reset-email').addEventListener('keydown', e => { if (e.key === 'Enter') doRequestReset(); });
  setTimeout(() => document.getElementById('email-input')?.focus(), 50);
}
```

- [ ] **Step 3: Add renderSetPassword() for invite acceptance**

Add this new function after `renderLogin`:

```js
function renderSetPassword(inviteToken, cfg) {
  const el = document.getElementById('landing-auth');
  if (!el) return;
  el.innerHTML =
    '<div class="landing-login">' +
      '<div class="auth-field">' +
        '<label class="auth-label" for="pw-new">Choose a password</label>' +
        '<div class="pw-wrapper">' +
          '<input type="password" id="pw-new" placeholder="8 or more characters" autocomplete="new-password">' +
          '<button type="button" class="pw-toggle" id="pw-toggle-new">show</button>' +
        '</div>' +
      '</div>' +
      '<div class="auth-error" id="auth-error"></div>' +
      '<button class="btn active auth-submit" id="accept-btn">Create account</button>' +
    '</div>';
  document.getElementById('pw-toggle-new').addEventListener('click', () => {
    const input = document.getElementById('pw-new');
    const btn   = document.getElementById('pw-toggle-new');
    const show  = input.type === 'password';
    input.type      = show ? 'text' : 'password';
    btn.textContent = show ? 'hide' : 'show';
  });
  document.getElementById('accept-btn').addEventListener('click', () => doAcceptInvite(inviteToken, cfg));
  document.getElementById('pw-new').addEventListener('keydown', e => { if (e.key === 'Enter') doAcceptInvite(inviteToken, cfg); });
  setTimeout(() => document.getElementById('pw-new')?.focus(), 50);
}
```

- [ ] **Step 4: Add doAcceptInvite() after renderSetPassword()**

```js
async function doAcceptInvite(inviteToken, cfg) {
  const pw  = document.getElementById('pw-new').value;
  const btn = document.getElementById('accept-btn');
  const err = document.getElementById('auth-error');
  if (!pw) { err.textContent = 'Enter a password.'; return; }
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const slug = cfg?.slug || artistSlug;
    const r    = await fetch(`/api/${slug}/auth?action=accept-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken, password: pw }),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error || 'Failed to create account.'; btn.disabled = false; btn.textContent = 'Create account'; return; }
    storeToken(data.token, false);
    sessionStorage.setItem('smartist_admin_email', data.email || '');
    renderLoggedIn(cfg);
  } catch {
    err.textContent = 'Connection error. Try again.';
    btn.disabled = false; btn.textContent = 'Create account';
  }
}
```

- [ ] **Step 5: Replace doLogin()**

Replace the existing `doLogin()` function:

```js
async function doLogin() {
  const email   = document.getElementById('email-input')?.value.trim() || '';
  const pw      = document.getElementById('pw-input').value.trim();
  const remember = document.getElementById('remember-me')?.checked || false;
  if (!pw) return;
  const btn = document.getElementById('pw-btn');
  const err = document.getElementById('auth-error');
  btn.disabled = true; btn.textContent = '…'; err.textContent = '';
  try {
    const cfg = await loadConfig();
    artistSlug = cfg.slug;
    // Send email if present (multi-user), omit it for bootstrap/legacy flow
    const body = email
      ? { email, password: pw, rememberMe: remember }
      : { password: pw };
    const r = await fetch(`/api/${artistSlug}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error || 'Sign in failed.'; btn.disabled = false; btn.textContent = 'Sign in'; return; }
    if (data.token) {
      storeToken(data.token, remember);
      sessionStorage.setItem('smartist_admin_email', data.email || '');
    } else {
      // Legacy bootstrap: server returns adminEmail (no token), store pw as bearer
      sessionStorage.setItem(AUTH_TOKEN_KEY, pw);
      if (data.adminEmail) sessionStorage.setItem('smartist_admin_email', data.adminEmail);
    }
    applyNav(cfg.name, cfg.config);
    renderLoggedIn(cfg);
  } catch {
    err.textContent = 'Connection error. Try again.';
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}
```

- [ ] **Step 6: Replace verifyToken() to handle magic+hint**

Replace `verifyToken(token)`:

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
    if (!r.ok) return false;
    const data = await r.json();
    if (data.token) {
      storeToken(data.token, false);
      sessionStorage.setItem('smartist_admin_email', data.email || '');
    } else if (data.adminEmail) {
      sessionStorage.setItem('smartist_admin_email', data.adminEmail);
    }
    return true;
  } catch { return false; }
}
```

- [ ] **Step 7: Replace init() to handle ?invite= and ?magic= as query params**

Replace the `init()` function:

```js
async function init() {
  const params     = new URLSearchParams(window.location.search);
  const magic      = params.get('magic') || new URLSearchParams(window.location.hash.slice(1)).get('magic');
  const hint       = params.get('hint');
  const invite     = params.get('invite');
  const oauthError = params.get('oauth_error');
  const path       = window.location.pathname.replace(/\/+$/, '') || '/';

  const hasToken = !!(sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY));
  if (path === '/' && !magic && !oauthError && !invite && !hasToken) {
    window.location.replace('/login' + window.location.search);
    return;
  }

  if (magic || oauthError || invite) history.replaceState(null, '', window.location.pathname);

  let cfg;
  try {
    cfg = await loadConfig();
    artistSlug = cfg.slug;
    applyNav(cfg.name, cfg.config);
    document.title = cfg.name || 'Band Tools';
  } catch {
    renderLogin();
    return;
  }

  if (oauthError) { renderLogin('Sign-in failed — the account email does not match the configured admin address.', cfg); return; }
  if (invite)     { renderSetPassword(invite, cfg); return; }

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
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_TOKEN_KEY);
    renderLogin(null, cfg);
  }
}
```

- [ ] **Step 8: Add login form CSS to app.css**

Find the `.landing-login` block in `app/css/app.css` and add these rules inside or after it:

```css
.auth-field { margin-bottom: 0.75rem; }
.auth-label { display: block; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--third-color); margin-bottom: 0.3rem; }
.auth-remember { margin: 0.1rem 0 0.75rem; }
.auth-remember-label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; color: #666; cursor: pointer; user-select: none; }
.auth-remember input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--secondary-color); cursor: pointer; }
.auth-submit { width: 100%; margin-bottom: 0.75rem; }
```

- [ ] **Step 9: Test the login flow end-to-end**

Start `vercel dev`. Visit `/login`. Confirm:
- Email field appears above password
- "Remember me" checkbox is present
- Logging in with just a password (no email) still works (bootstrap mode)
- Logging in with a wrong email shows "Invalid email or password"

- [ ] **Step 10: Commit**

```bash
git add app/js/home.js app/css/app.css
git commit -m "feat: login form with email, remember me, invite acceptance"
```

---

## Task 7: Users management page

**Files:**
- Create: `app/users.html`
- Create: `app/js/users.js`
- Modify: `vercel.json`

- [ ] **Step 1: Add /users route to vercel.json**

In `vercel.json`, inside the `"rewrites"` array, add after the `/hub` entry:

```json
{ "source": "/users", "destination": "/app/users.html" },
```

- [ ] **Step 2: Create app/users.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Users</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow"/>
  <meta name="theme-color" content="#f9bf8f">
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon_io/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon_io/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon_io/favicon-16x16.png">
  <link rel="manifest" href="/favicon_io/site.webmanifest">
  <link rel="stylesheet" href="/app/css/app.css?v=26">
  <style>
    .users-wrap { max-width: 680px; margin: 0 auto; padding: 4.5rem 1.25rem 4rem; }
    .invite-bar { display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1.5rem;padding:1rem 1.1rem;background:var(--surface-color);border:1px solid var(--border-color);border-radius:4px; }
    .invite-field { display:flex;flex-direction:column;gap:0.3rem;flex:1 1 180px;min-width:0; }
    .invite-field label { font-size:0.68rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--third-color); }
    .invite-input { padding:0.45rem 0.65rem;border:1px solid var(--border-color);border-radius:3px;font-family:'Courier New',monospace;font-size:0.88rem;background:var(--bg-color);color:var(--black);outline:none; }
    .invite-input:focus { border-color:var(--secondary-color); }
    .invite-role { padding:0.45rem 0.55rem;border:1px solid var(--border-color);border-radius:3px;font-family:'Courier New',monospace;font-size:0.88rem;background:var(--bg-color);color:var(--black);cursor:pointer;min-width:110px; }
    .user-section-label { font-size:0.7rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--third-color);margin:1.25rem 0 0.5rem; }
    .user-list { border:1px solid var(--border-color);border-radius:4px;overflow:hidden; }
    .user-row { display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:0.75rem;padding:0.7rem 1rem;border-bottom:1px solid #f0ebe3;background:var(--bg-color); }
    .user-row:last-child { border-bottom:none; }
    .user-row.header { background:var(--surface-color);padding:0.4rem 1rem;font-size:0.68rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--third-color); }
    .user-email { font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    .you-badge { font-size:0.7rem;color:var(--third-color);margin-left:0.4rem; }
    .status-badge { font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:10px;white-space:nowrap; }
    .status-active  { background:#dcfce7;color:#166534; }
    .status-pending { background:#fef9c3;color:#854d0e; }
    .role-select-inline { padding:0.15rem 0.35rem;border:1px solid var(--border-color);border-radius:3px;font-family:inherit;font-size:0.75rem;background:var(--bg-color);cursor:pointer; }
    .user-action-btn { background:none;border:1px solid var(--border-color);border-radius:3px;padding:0.2rem 0.5rem;font-family:inherit;font-size:0.72rem;color:var(--third-color);cursor:pointer;white-space:nowrap; }
    .user-action-btn:hover { border-color:var(--secondary-ink);color:var(--secondary-ink); }
    .user-action-btn.danger:hover { border-color:#e55;color:#e55; }
    .users-status { font-size:0.8rem;color:var(--third-color);margin-top:0.75rem;min-height:1.2em; }
    .users-status.error { color:#e55; }
    .empty-users { padding:1.5rem 1rem;text-align:center;font-size:0.85rem;color:var(--third-color); }
  </style>
</head>
<body>
<div class="app-wrap users-wrap">
  <h1>Users</h1>
  <div class="invite-bar">
    <div class="invite-field">
      <label for="invite-email">Email</label>
      <input type="email" id="invite-email" class="invite-input" placeholder="bandmate@example.com">
    </div>
    <div class="invite-field" style="flex:0 0 auto">
      <label for="invite-role">Role</label>
      <select id="invite-role" class="invite-role">
        <option value="member">member</option>
        <option value="viewer">viewer</option>
        <option value="admin">admin</option>
      </select>
    </div>
    <button class="btn active" id="invite-btn" onclick="sendInvite()">Send invite</button>
  </div>
  <div id="users-status" class="users-status"></div>
  <div class="user-section-label">Active</div>
  <div class="user-list" id="active-list"><p class="empty-users">Loading…</p></div>
  <div id="pending-section" style="display:none">
    <div class="user-section-label">Pending invites</div>
    <div class="user-list" id="pending-list"></div>
  </div>
</div>
<script src="/app/js/common.js?v=12"></script>
<script src="/app/js/users.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create app/js/users.js**

```js
var _artistSlug   = '';
var _currentUserId = null;

initPage(function(cfg) {
  _artistSlug = cfg.slug;
  // Decode current user id from stored token (so we can mark "you" row)
  try {
    var tok = getToken();
    if (tok) {
      var b64 = tok.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var outer = JSON.parse(atob(b64));
      if (outer.payload) _currentUserId = JSON.parse(outer.payload).userId || null;
    }
  } catch {}
  loadUsers();
});

async function loadUsers() {
  try {
    const r = await apiFetch('/api/' + _artistSlug + '/auth');
    const { users } = await r.json();
    _renderUsers(users);
  } catch (e) {
    if (String(e.message).includes('Session')) return; // apiFetch already redirected
    setStatus('users-status', 'Failed to load users.', true);
  }
}

function _renderUsers(users) {
  var active  = users.filter(function(u) { return u.accepted; });
  var pending = users.filter(function(u) { return u.invite_pending; });

  var activeEl       = document.getElementById('active-list');
  var pendingEl      = document.getElementById('pending-list');
  var pendingSection = document.getElementById('pending-section');

  if (!active.length) {
    activeEl.innerHTML = '<p class="empty-users">No active users yet.</p>';
  } else {
    activeEl.innerHTML =
      '<div class="user-row header"><span>Email</span><span>Status</span><span>Role</span><span></span></div>' +
      active.map(function(u) {
        var isMe     = u.id === _currentUserId;
        var roleCell = isMe
          ? '<span style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--third-color)">' + escHtml(u.role) + '</span>'
          : '<select class="role-select-inline" onchange="_changeRole(' + u.id + ',this.value)">' +
              ['admin', 'member', 'viewer'].map(function(r) {
                return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + r + '</option>';
              }).join('') +
            '</select>';
        var actionCell = isMe
          ? '<span style="display:inline-block;width:50px"></span>'
          : '<button class="user-action-btn danger" onclick="_removeUser(' + u.id + ',\'' + escHtml(u.email) + '\')">Remove</button>';
        return '<div class="user-row">' +
          '<span class="user-email">' + escHtml(u.email) +
            (isMe ? '<span class="you-badge">you</span>' : '') +
          '</span>' +
          '<span class="status-badge status-active">active</span>' +
          roleCell + actionCell +
          '</div>';
      }).join('');
  }

  if (pending.length) {
    pendingSection.style.display = '';
    pendingEl.innerHTML = pending.map(function(u) {
      return '<div class="user-row">' +
        '<span class="user-email">' + escHtml(u.email) + '</span>' +
        '<span class="status-badge status-pending">invite sent</span>' +
        '<span style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--third-color)">' + escHtml(u.role) + '</span>' +
        '<button class="user-action-btn" onclick="_resendInvite(' + u.id + ')">Resend</button>' +
        '</div>';
    }).join('');
  } else {
    pendingSection.style.display = 'none';
  }
}

async function sendInvite() {
  var email = document.getElementById('invite-email').value.trim();
  var role  = document.getElementById('invite-role').value;
  if (!email) { setStatus('users-status', 'Enter an email address.', true); return; }
  var btn = document.getElementById('invite-btn');
  btn.disabled = true; btn.textContent = '…'; setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth?action=invite', 'POST', { email, role });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to send invite.', true); return; }
    setStatus('users-status', 'Invite sent to ' + email + '.');
    document.getElementById('invite-email').value = '';
    loadUsers();
  } catch (e) {
    if (!String(e.message).includes('Session')) setStatus('users-status', 'Connection error.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Send invite';
  }
}

async function _changeRole(userId, role) {
  setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth', 'PUT', { userId, role });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to update role.', true); loadUsers(); }
  } catch {}
}

async function _removeUser(userId, email) {
  if (!confirm('Remove ' + email + '? They will lose access immediately.')) return;
  setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth', 'DELETE', { userId });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to remove user.', true); return; }
    setStatus('users-status', email + ' removed.');
    loadUsers();
  } catch {}
}

async function _resendInvite(userId) {
  setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth?action=resend-invite', 'POST', { userId });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to resend invite.', true); return; }
    setStatus('users-status', 'Invite resent.');
  } catch {}
}
```

- [ ] **Step 4: Verify /users loads**

Start `vercel dev`. Visit `/users`. Confirm:
- Page loads (redirected to login if not authed)
- After logging in as bootstrap admin, `/users` shows the page with the invite bar
- No JS console errors

- [ ] **Step 5: Commit**

```bash
git add app/users.html app/js/users.js vercel.json
git commit -m "feat: users management page"
```

---

## Task 8: Profile — bootstrap prompt

**Files:**
- Modify: `app/profile.html`

- [ ] **Step 1: Add bootstrap prompt div to profile.html**

Find the `<div class="app-wrap` in `app/profile.html`. Add this block immediately after the opening `<div>` or `<h1>` tag:

```html
<div id="bootstrap-prompt" style="display:none;margin-bottom:1.5rem;padding:0.9rem 1rem;background:#fef9c3;border:1px solid #fde68a;border-radius:4px;font-size:0.85rem;line-height:1.5">
  <strong>Set up named accounts</strong> — You're using single-password login.
  <a href="/users" style="color:var(--secondary-ink)">Go to Users →</a> to invite band members and create per-person accounts.
</div>
```

- [ ] **Step 2: Show the prompt when no users exist**

Find the profile page's `initPage(...)` callback (it's in the inline `<script>` or a separate JS file). At the end of the callback, add:

```js
// Show bootstrap prompt when no named users exist yet
apiFetch('/api/' + artistSlug + '/auth').then(function(r) {
  return r.json();
}).then(function(data) {
  if (data.users && data.users.length === 0) {
    var el = document.getElementById('bootstrap-prompt');
    if (el) el.style.display = '';
  }
}).catch(function() {});
```

- [ ] **Step 3: Verify**

Visit `/profile` as bootstrap admin. The yellow prompt should appear.

- [ ] **Step 4: Commit**

```bash
git add app/profile.html
git commit -m "feat: profile page bootstrap prompt for multi-user setup"
```

---

## Task 9: Integration tests

**Files:**
- Modify: `tests/api.js`

These run against `vercel dev` on port 3000. They use the existing `ARTIST_PASSWORD` env var for bootstrap access.

- [ ] **Step 1: Add multi-user integration tests to tests/api.js**

Add a new section in `tests/api.js` after the existing auth tests. Find where `BASE`, `ARTIST`, and `PASSWORD` are defined (they're at the top of the file).

```js
// ── Multi-user auth ──────────────────────────────────────────────────────────
console.log('\n── Multi-user auth ──');

const TEST_EMAIL = '[TEST]user_' + Date.now() + '@example.com';
let _testUserId = null;

// GET /auth — list users (bootstrap admin can access)
{
  const r = await fetch(`${BASE}/api/${ARTIST}/auth`, {
    headers: { Authorization: `Bearer ${PASSWORD}` },
  });
  assert(r.ok, `GET /auth status ${r.status}`);
  const { users } = await r.json();
  assert(Array.isArray(users), 'users is an array');
  console.log(`  ✓ list users (${users.length} found)`);
}

// POST ?action=invite — create pending user
{
  const r = await fetch(`${BASE}/api/${ARTIST}/auth?action=invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PASSWORD}` },
    body: JSON.stringify({ email: TEST_EMAIL, role: 'member' }),
  });
  assert(r.status === 201, `invite status ${r.status}`);
  const data = await r.json();
  _testUserId = data.user?.id;
  assert(_testUserId, 'invite returns user id');
  console.log(`  ✓ invite sent, userId=${_testUserId}`);
}

// accept-invite with garbage token → 400
{
  const r = await fetch(`${BASE}/api/${ARTIST}/auth?action=accept-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'garbage', password: 'somepassword' }),
  });
  assert(r.status === 400, `bad invite token → ${r.status}`);
  console.log('  ✓ garbage invite token rejected');
}

// PUT — update role
if (_testUserId) {
  const r = await fetch(`${BASE}/api/${ARTIST}/auth`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PASSWORD}` },
    body: JSON.stringify({ userId: _testUserId, role: 'viewer' }),
  });
  assert(r.ok, `PUT role → ${r.status}`);
  const data = await r.json();
  assert.strictEqual(data.user?.role, 'viewer', 'role updated');
  console.log('  ✓ role updated to viewer');
}

// POST login with email — wrong password → 401
{
  const r = await fetch(`${BASE}/api/${ARTIST}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrongpassword' }),
  });
  assert(r.status === 401, `bad login → ${r.status}`);
  console.log('  ✓ email login rejects bad credentials');
}

// DELETE — clean up test user
if (_testUserId) {
  const r = await fetch(`${BASE}/api/${ARTIST}/auth`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PASSWORD}` },
    body: JSON.stringify({ userId: _testUserId }),
  });
  assert(r.ok, `DELETE user → ${r.status}`);
  console.log('  ✓ test user removed');
}
```

- [ ] **Step 2: Run integration tests**

```bash
cd tests && ARTIST_PASSWORD=<your-password> npm test
```

Expected: all multi-user auth tests print `✓`.

- [ ] **Step 3: Commit**

```bash
git add tests/api.js
git commit -m "test: multi-user auth integration tests"
```

---

## Task 10: Add APP_SECRET to Vercel environments

- [ ] **Step 1: Add to preview**

```bash
vercel env add APP_SECRET preview
```

Paste the same value from your local `.env`.

- [ ] **Step 2: Add to production**

```bash
vercel env add APP_SECRET production
```

- [ ] **Step 3: Deploy preview and verify**

```bash
vercel deploy
```

Visit the preview URL. Confirm login page loads with email field and no console errors.

- [ ] **Step 4: Final unit + integration test run**

```bash
node tests/unit.js
cd tests && ARTIST_PASSWORD=<your-password> npm test
```

Expected: all pass.

- [ ] **Step 5: Commit and push**

```bash
git push
```
