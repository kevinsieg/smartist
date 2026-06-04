# Auth Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two runtime bugs and five security/integrity gaps found in a full audit of the auth system.

**Architecture:** Changes touch three layers in order of dependency: shared API helpers (`_token`, `_ratelimit`, `_auth`), then individual route handlers, then client-side JS. Each task is independently testable. No new dependencies or schema changes.

**Tech Stack:** Node.js serverless functions (Vercel), Neon/PostgreSQL, plain browser JS (no bundler).

---

## Files modified

| File | Why |
|------|-----|
| `api/_token.js` | Validate `APP_SECRET` at module load |
| `api/_ratelimit.js` | Fix spoofable client IP extraction |
| `api/_auth.js` | Add `minRole` param to `requireAuth` |
| `api/[artist]/auth.js` | Fix resend ordering, expired-invite query, email validation |
| `api/[artist]/songs.js` | Enforce `member` role on all mutations |
| `api/[artist]/songs/[...path].js` | Enforce `member` role on all mutations |
| `api/[artist]/gigs.js` | Enforce `member` role on mutations |
| `api/[artist]/gigs/[id].js` | Enforce `member` role on mutations |
| `api/[artist]/setlists.js` | Enforce `member` role on mutations |
| `api/[artist]/venues.js` | Enforce `member` role on mutations |
| `api/[artist]/venues/[...path].js` | Enforce `member` role on mutations |
| `api/[artist]/organizers.js` | Enforce `member` role on mutations |
| `api/[artist]/organizers/[...path].js` | Enforce `member` role on mutations |
| `api/config.js` | Enforce `admin` role on config mutations |
| `api/_media.js` | Enforce `admin` role on media uploads |
| `app/js/setlist.js` | Fix 8 direct sessionStorage reads + 4 incomplete clears |
| `app/js/hub.js` | Add `onNavAuthEmpty` redirect |
| `app/js/users.js` | Render expired invites with revoke-only row |
| `tests/unit/ratelimit.js` | Update test for rightmost-IP change |
| `tests/unit/auth.js` | Add `requireAuth` + `minRole` tests |
| `tests/unit/user_token.js` | Add missing-secret test |

---

## Task 1 — APP_SECRET startup validation

**Files:**
- Modify: `api/_token.js`
- Modify: `tests/unit/user_token.js`

The module currently crashes with an opaque `TypeError` inside a try/catch if `APP_SECRET` is unset. Adding an explicit check at module load makes the root cause obvious in logs.

- [ ] **Step 1: Add failing test for missing secret**

Add at the end of the `run` function in `tests/unit/user_token.js`, before the closing `}`:

```js
  test('missing APP_SECRET throws at require time', () => {
    const saved = process.env.APP_SECRET;
    delete process.env.APP_SECRET;
    delete require.cache[require.resolve(path.join(__dirname, '../../api/_token'))];
    try {
      require(path.join(__dirname, '../../api/_token'));
      throw new Error('expected throw, got none');
    } catch (e) {
      assert(/APP_SECRET/.test(e.message), `expected APP_SECRET in message, got: ${e.message}`);
    } finally {
      process.env.APP_SECRET = saved;
      delete require.cache[require.resolve(path.join(__dirname, '../../api/_token'))];
    }
  });
```

- [ ] **Step 2: Run to confirm it fails**

```bash
node tests/unit/user_token.js
```
Expected: `✗ missing APP_SECRET throws at require time`

- [ ] **Step 3: Add the guard in `api/_token.js`**

Add after the `require('crypto')` line (line 1), before any function definitions:

```js
if (!process.env.APP_SECRET) {
  throw new Error('APP_SECRET env var is required — set it in .env or Vercel project settings');
}
```

- [ ] **Step 4: Run tests**

```bash
node tests/unit/user_token.js
```
Expected: all pass including the new test.

- [ ] **Step 5: Commit**

```bash
git add api/_token.js tests/unit/user_token.js
git commit -m "fix: validate APP_SECRET at module load with a clear error message"
```

---

## Task 2 — clientIp uses rightmost (non-spoofable) IP

**Files:**
- Modify: `api/_ratelimit.js`
- Modify: `tests/unit/ratelimit.js`

`x-forwarded-for` is a comma-list. On Vercel the client controls the leftmost entries; Vercel appends the real IP last. Taking the first value lets an attacker set `X-Forwarded-For: fake` and exhaust a different key than their real IP, bypassing the rate limit.

- [ ] **Step 1: Update existing test and add rightmost test**

Replace the entire `run` function in `tests/unit/ratelimit.js` with:

```js
function run(r) {
  const { test, assertEq, B } = r;

  console.log(B('\nrate-limit helpers'));

  test('clientIp returns rightmost forwarded IP (non-spoofable)', () => {
    assertEq(
      clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }),
      '10.0.0.1'
    );
  });
  test('clientIp trims whitespace', () => {
    assertEq(clientIp({ headers: { 'x-forwarded-for': ' 2001:db8::1 , 9.9.9.9 ' } }), '9.9.9.9');
  });
  test('clientIp single value works', () => {
    assertEq(clientIp({ headers: { 'x-forwarded-for': '203.0.113.10' } }), '203.0.113.10');
  });
  test('clientIp missing forwarded header → unknown', () => {
    assertEq(clientIp({ headers: {} }), 'unknown');
  });
  test('isMissingRateLimitTable detects PostgreSQL undefined_table errors', () => {
    assertEq(isMissingRateLimitTable({ code: '42P01', message: 'relation "rate_limits" does not exist' }), true);
  });
  test('isMissingRateLimitTable detects Neon missing relation messages', () => {
    assertEq(isMissingRateLimitTable({ message: 'relation "rate_limits" does not exist' }), true);
  });
  test('isMissingRateLimitTable ignores unrelated database errors', () => {
    assertEq(isMissingRateLimitTable({ code: '08006', message: 'connection failure' }), false);
  });
}
```

- [ ] **Step 2: Run to confirm the first test fails**

```bash
node tests/unit/ratelimit.js
```
Expected: `✗ clientIp returns rightmost forwarded IP` (still returns `1.2.3.4`)

- [ ] **Step 3: Fix `clientIp` in `api/_ratelimit.js`**

Replace the `clientIp` function (the last function before `module.exports`):

```js
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',').pop().trim();
  return req.headers['x-real-ip'] || 'unknown';
}
```

- [ ] **Step 4: Run tests**

```bash
node tests/unit/ratelimit.js
```
Expected: all 7 pass.

- [ ] **Step 5: Commit**

```bash
git add api/_ratelimit.js tests/unit/ratelimit.js
git commit -m "fix: use rightmost x-forwarded-for IP to prevent rate-limit bypass"
```

---

## Task 3 — requireAuth accepts minRole

**Files:**
- Modify: `api/_auth.js`
- Modify: `tests/unit/auth.js`

All data-mutation handlers call `requireAuth` and get back an artist object. Adding an optional `minRole` parameter means each call site can express its access requirement in one place, without a separate `requireRole` call.

- [ ] **Step 1: Add failing tests**

Append to the `run` function in `tests/unit/auth.js` (before the closing `}`). The test stubs `getArtist` and `verifyUserToken` via the require cache:

```js
  // ── requireAuth with minRole ─────────────────────────────────────────────────
  // We need to test requireAuth. Stub _db and _token in the require cache.
  const { makeRunner: _, stubLogger } = require('./_runner');
  stubLogger();

  const dbPath2    = require.resolve(path.join(__dirname, '../../api/_db'));
  const tokenPath2 = require.resolve(path.join(__dirname, '../../api/_token'));
  const authPath   = require.resolve(path.join(__dirname, '../../api/_auth'));

  const FAKE_ARTIST = { id: 1, slug: 'testband', name: 'Test Band', password_hash: '$2b$12$fakehash' };

  function stubAuthDeps(tokenClaim) {
    require.cache[dbPath2] = {
      id: dbPath2, filename: dbPath2, loaded: true,
      exports: { getArtist: async () => FAKE_ARTIST, getDb: () => null },
    };
    require.cache[tokenPath2] = {
      id: tokenPath2, filename: tokenPath2, loaded: true,
      exports: {
        verifyUserToken: () => tokenClaim,
        verifyMagicToken: () => false,
        generateMagicToken: () => '',
        generateUserToken: () => '',
        TTL_8H: 28800000, TTL_30D: 2592000000,
      },
    };
    delete require.cache[authPath];
    return require(path.join(__dirname, '../../api/_auth'));
  }

  function mockReq(role) {
    const claim = role ? { userId: 1, role } : null;
    const { generateUserToken } = require(tokenPath2) || {};
    return {
      headers: { authorization: 'Bearer faketoken' },
      _claim: claim,
    };
  }

  console.log(B('\nrequireAuth minRole'));

  r.testAsync('viewer blocked from member-gated route → null + 403', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'viewer' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'member');
    assertEq(result, null);
    assertEq(res.statusCode(), 403);
  });

  r.testAsync('member passes member-gated route → artist returned', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'member' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'member');
    assert(result !== null, 'expected artist object');
    assertEq(result.slug, 'testband');
  });

  r.testAsync('admin passes admin-gated route → artist returned', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'admin' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'admin');
    assert(result !== null, 'expected artist object');
  });

  r.testAsync('member blocked from admin-gated route → null + 403', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'member' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband', 'admin');
    assertEq(result, null);
    assertEq(res.statusCode(), 403);
  });

  r.testAsync('no minRole: viewer passes (backward compat) → artist returned', async () => {
    const { requireAuth } = stubAuthDeps({ userId: 1, role: 'viewer' });
    const res = mockRes();
    const req = { headers: { authorization: 'Bearer faketoken' } };
    const result = await requireAuth(req, res, 'testband');
    assert(result !== null, 'expected artist');
  });
```

- [ ] **Step 2: Run to confirm new async tests fail**

```bash
node tests/unit/auth.js
```
Expected: the five new `testAsync` cases fail (requireAuth has no minRole param yet).

- [ ] **Step 3: Update `api/_auth.js`**

Replace the `requireAuth` function:

```js
async function requireAuth(req, res, slug, minRole = null) {
  const header = req.headers.authorization ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }

  const artist = await getArtist(slug);
  if (!artist) { res.status(404).json({ error: 'Artist not found' }); return null; }

  const claim = verifyUserToken(token);
  if (claim) {
    req.user = { id: claim.userId, role: claim.role };
  } else if (await checkCredentials(token, artist)) {
    req.user = { id: null, role: 'admin' };
  } else {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  if (minRole && !requireRole(req, res, minRole)) return null;
  return artist;
}
```

- [ ] **Step 4: Run all unit tests**

```bash
node tests/unit.js
```
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add api/_auth.js tests/unit/auth.js
git commit -m "feat: requireAuth accepts optional minRole for inline RBAC enforcement"
```

---

## Task 4 — Enforce roles on all data-mutation endpoints

**Files:**
- Modify: `api/[artist]/songs.js` (lines 139, 222, 249, 277, 328, 355, 392, 437)
- Modify: `api/[artist]/songs/[...path].js` (lines 155, 446, 472, 502, 518, 557, 577, 666, 707)
- Modify: `api/[artist]/gigs.js` (line 89)
- Modify: `api/[artist]/gigs/[id].js` (line 56)
- Modify: `api/[artist]/setlists.js` (line 35)
- Modify: `api/[artist]/venues.js` (line 90)
- Modify: `api/[artist]/venues/[...path].js` (line 32)
- Modify: `api/[artist]/organizers.js` (line 45)
- Modify: `api/[artist]/organizers/[...path].js` (line 34)
- Modify: `api/config.js` (lines 168, 189, 200)
- Modify: `api/_media.js` (line 26)

Data mutations (songs, gigs, setlists, venues, organizers) require at minimum `member`. Config and media changes (branding, display fields) require `admin`. Viewers remain read-only.

- [ ] **Step 1: Update all data-mutation handlers**

In every file below, replace the plain `requireAuth(req, res, slug)` call with the versioned one. The pattern is always:
```js
// before:
const band = await requireAuth(req, res, slug);
// after:
const band = await requireAuth(req, res, slug, 'member');
```
And for config/media:
```js
const band = await requireAuth(req, res, slug, 'admin');
```

**`api/[artist]/songs.js`** — replace all 8 occurrences (lines 139, 222, 249, 277, 328, 355, 392, 437):
```js
const band = await requireAuth(req, res, slug, 'member');
```

**`api/[artist]/songs/[...path].js`** — replace all 9 occurrences (lines 155, 446, 472, 502, 518, 557, 577, 666, 707):
```js
const band = await requireAuth(req, res, slug, 'member');
```

**`api/[artist]/gigs.js`** line 89:
```js
const artist = await requireAuth(req, res, slug, 'member');
```

**`api/[artist]/gigs/[id].js`** line 56:
```js
const artist = await requireAuth(req, res, slug, 'member');
```

**`api/[artist]/setlists.js`** line 35:
```js
const band = await requireAuth(req, res, slug, 'member');
```

**`api/[artist]/venues.js`** line 90:
```js
const artist = await requireAuth(req, res, slug, 'member');
```

**`api/[artist]/venues/[...path].js`** line 32:
```js
const artist = await requireAuth(req, res, slug, 'member');
```

**`api/[artist]/organizers.js`** line 45:
```js
const artist = await requireAuth(req, res, slug, 'member');
```

**`api/[artist]/organizers/[...path].js`** line 34:
```js
const artist = await requireAuth(req, res, slug, 'member');
```

**`api/config.js`** lines 168, 189, 200 — all three:
```js
const band = await requireAuth(req, res, slug, 'admin');
```

**`api/_media.js`** line 26:
```js
const band = await requireAuth(req, res, slug, 'admin');
```

- [ ] **Step 2: Run unit tests to confirm nothing broken**

```bash
node tests/unit.js
```
Expected: all pass (unit tests don't hit these handlers directly).

- [ ] **Step 3: Smoke-test locally**

With `vercel dev` running and `ARTIST_PASSWORD` set, run:
```bash
cd tests && ARTIST_PASSWORD=$ARTIST_PASSWORD npm test
```
Expected: all existing integration tests pass (admin token has `role: admin` which satisfies both `member` and `admin` guards).

- [ ] **Step 4: Commit**

```bash
git add api/[artist]/songs.js "api/[artist]/songs/[...path].js" \
        api/[artist]/gigs.js "api/[artist]/gigs/[id].js" \
        api/[artist]/setlists.js \
        api/[artist]/venues.js "api/[artist]/venues/[...path].js" \
        api/[artist]/organizers.js "api/[artist]/organizers/[...path].js" \
        api/config.js api/_media.js
git commit -m "feat: enforce member/admin role on all data-mutation endpoints"
```

---

## Task 5 — Fix resend-invite: update DB before sending email

**Files:**
- Modify: `api/[artist]/auth.js`

Currently the email is sent first, then the DB is updated. If the DB write fails after the email is sent, the recipient gets a link that references a hash that doesn't exist in the database. Swapping the order means the DB is always consistent with the sent email.

- [ ] **Step 1: Reorder the resend-invite block**

In `api/[artist]/auth.js`, find the `// POST ?action=resend-invite` block. The current sequence is: generate token → build link → `sendEmail` → `UPDATE users`. Change it to: generate token → `UPDATE users` → build link → `sendEmail`. Replace the whole block (from `const rawToken` through the closing `return res.json({ ok: true })`):

```js
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
    const proto  = req.headers['x-forwarded-proto'] || (h.includes('localhost') ? 'http' : 'https');
    const origin = process.env.APP_ORIGIN || `${proto}://${h}`;
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
```

- [ ] **Step 2: Run unit tests**

```bash
node tests/unit.js
```
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add "api/[artist]/auth.js"
git commit -m "fix: update invite token in DB before sending email in resend-invite"
```

---

## Task 6 — Email format validation on invite

**Files:**
- Modify: `api/[artist]/auth.js`

`validateStr` only checks length. A malformed address (e.g. `notanemail`, `user@`) gets stored, the invite email bounces, and the row blocks future attempts for that address.

- [ ] **Step 1: Add email regex after `validateStr` in the invite action**

In `api/[artist]/auth.js`, find the `// POST ?action=invite` block. After the line `const cleanEmail = validateStr(email, 200);`, add:

```js
    if (!cleanEmail) return res.status(400).json({ error: 'Email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail))
      return res.status(400).json({ error: 'Invalid email address' });
```

Remove the existing `if (!cleanEmail) return res.status(400).json({ error: 'Email required' });` line that immediately followed `validateStr` (it is now included above).

The block should read:
```js
    const cleanEmail = validateStr(email, 200);
    if (!cleanEmail) return res.status(400).json({ error: 'Email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail))
      return res.status(400).json({ error: 'Invalid email address' });
    if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
```

- [ ] **Step 2: Run unit tests**

```bash
node tests/unit.js
```
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add "api/[artist]/auth.js"
git commit -m "fix: validate email format before creating invite"
```

---

## Task 7 — Expose and render expired invites

**Files:**
- Modify: `api/[artist]/auth.js`
- Modify: `app/js/users.js`

When an invite expires (7 days without being accepted), the row disappears from the pending list but the email address is still blocked. Admins see "User already exists" if they try re-inviting. This task surfaces expired rows with a distinct badge and a Revoke button (so the slot can be freed).

- [ ] **Step 1: Add `invite_expired` to the GET query**

In `api/[artist]/auth.js`, replace the GET users query:

```js
    const users = await sql`
      SELECT id, email, role, created_at, invite_expires_at,
             (password_hash IS NOT NULL)                                                          AS accepted,
             (invite_token_hash IS NOT NULL AND invite_expires_at >  now() AND password_hash IS NULL) AS invite_pending,
             (invite_token_hash IS NOT NULL AND invite_expires_at <= now() AND password_hash IS NULL) AS invite_expired
      FROM users WHERE artist_id = ${artist.id}
      ORDER BY created_at
    `;
```

- [ ] **Step 2: Update `_renderUsers` in `app/js/users.js`**

Replace the existing `_renderUsers` function with:

```js
function _renderUsers(users) {
  var active   = users.filter(function(u) { return u.accepted; });
  var pending  = users.filter(function(u) { return u.invite_pending; });
  var expired  = users.filter(function(u) { return u.invite_expired; });

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

  var pendingRows = pending.map(function(u) {
    var sentDate = u.invite_expires_at
      ? new Date(new Date(u.invite_expires_at).getTime() - 7 * 24 * 60 * 60 * 1000)
          .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';
    return '<div class="user-row">' +
      '<span class="user-email">' + escHtml(u.email) + '</span>' +
      '<span class="status-badge status-pending">invite sent</span>' +
      '<span style="font-size:0.72rem;color:var(--third-color)">' + escHtml(sentDate) + '</span>' +
      '<span style="display:flex;gap:0.35rem">' +
        '<button class="user-action-btn" onclick="_resendInvite(' + u.id + ')">Resend</button>' +
        '<button class="user-action-btn danger" onclick="_revokeInvite(' + u.id + ',\'' + escHtml(u.email) + '\')">Revoke</button>' +
      '</span>' +
    '</div>';
  });

  var expiredRows = expired.map(function(u) {
    return '<div class="user-row">' +
      '<span class="user-email">' + escHtml(u.email) + '</span>' +
      '<span class="status-badge" style="background:#f3ede4;color:var(--third-color)">expired</span>' +
      '<span style="font-size:0.72rem;color:var(--third-color)">' + escHtml(u.role) + '</span>' +
      '<button class="user-action-btn danger" onclick="_revokeInvite(' + u.id + ',\'' + escHtml(u.email) + '\')">Remove</button>' +
    '</div>';
  });

  var allPending = pendingRows.concat(expiredRows);
  if (allPending.length) {
    pendingSection.style.display = '';
    pendingEl.innerHTML = allPending.join('');
  } else {
    pendingSection.style.display = 'none';
  }
}
```

- [ ] **Step 3: Run unit tests**

```bash
node tests/unit.js
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add "api/[artist]/auth.js" app/js/users.js
git commit -m "fix: surface expired invites in UI so admins can revoke blocked email slots"
```

---

## Task 8 — Fix setlist.js token reads and clears

**Files:**
- Modify: `app/js/setlist.js`

Eight places read directly from `sessionStorage`, missing tokens stored in `localStorage` by the "remember me" feature. Four 401-handling blocks clear only `sessionStorage`, leaving a stale `localStorage` token that will re-authenticate the user on the next page load.

- [ ] **Step 1: Replace all 8 direct token reads with `getToken()`**

Each replacement is `sessionStorage.getItem(AUTH_TOKEN_KEY)` → `getToken()`. Make the following changes in `app/js/setlist.js`:

**Line 668** (inside `openAcceptModal`):
```js
// before:
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
// after:
  const token = getToken();
```

**Line 739** (inside the `create-gig-btn` listener):
```js
// before:
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
// after:
  const token = getToken();
```

**Line 759** (inside the `save-btn` listener):
```js
// before:
  const token   = sessionStorage.getItem(AUTH_TOKEN_KEY);
// after:
  const token   = getToken();
```

**Line 1318** (inside `_histSaveEdits`):
```js
// before:
  var token    = sessionStorage.getItem(AUTH_TOKEN_KEY);
// after:
  var token    = getToken();
```

**Line 1427** (inside `_confirmDeleteSetlist`):
```js
// before:
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
// after:
  var token = getToken();
```

**Line 1607** (inside `_histShare`, the `hasToken` check):
```js
// before:
  var hasToken = !!sessionStorage.getItem(AUTH_TOKEN_KEY);
// after:
  var hasToken = !!getToken();
```

**Line 1644** (inside `_histShareSend`):
```js
// before:
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
// after:
  var token = getToken();
```

**Line 1690** (inside `_histDuplicate`):
```js
// before:
  var token = sessionStorage.getItem(AUTH_TOKEN_KEY);
// after:
  var token = getToken();
```

- [ ] **Step 2: Replace all 4 incomplete 401 clears**

Each `sessionStorage.removeItem(AUTH_TOKEN_KEY)` in a 401 handler must also clear localStorage. There are exactly four instances (lines 787, 1340, 1666, 1711). Replace each with:

```js
sessionStorage.removeItem(AUTH_TOKEN_KEY);
localStorage.removeItem(AUTH_TOKEN_KEY);
```

- [ ] **Step 3: Run unit tests**

```bash
node tests/unit.js
```
Expected: all pass (unit tests don't cover setlist.js directly but confirm no regressions elsewhere).

- [ ] **Step 4: Commit**

```bash
git add app/js/setlist.js
git commit -m "fix: use getToken() in setlist.js to respect remember-me localStorage tokens; clear both storages on 401"
```

---

## Task 9 — Hub page redirects on session expiry

**Files:**
- Modify: `app/js/hub.js`

The hub page makes authenticated PATCH calls via `apiFetch`. When the session expires, `apiFetch` clears the token and calls `requireLogin()`, but the page content stays rendered and the nav switches to "Login →" without navigating. `onNavAuthEmpty` fires whenever `updateAuthIndicator` detects no session, including during the nav update after `doLogout()`.

- [ ] **Step 1: Add the hook**

In `app/js/hub.js`, before the `initPage(...)` call, add:

```js
window.onNavAuthEmpty = function() { goToLogin(); };
```

- [ ] **Step 2: Verify manually**

With `vercel dev` running:
1. Log in and navigate to `/hub`
2. Open DevTools → Application → Session Storage, delete the `smartist_token` key
3. Click any nav item or wait for the nav to refresh (or call `updateAuthIndicator()` in the console)

Expected: immediately redirected to `/login?next=/hub`.

- [ ] **Step 3: Commit**

```bash
git add app/js/hub.js
git commit -m "fix: redirect to login on session expiry from hub page"
```

---

## Self-review

**Spec coverage:**
- A1 (setlist token reads) → Task 8 ✓
- A2 (expired invites ghost) → Task 7 ✓
- B1 (RBAC on data APIs) → Tasks 3 + 4 ✓
- B2 (IP spoofing) → Task 2 ✓
- B3 (APP_SECRET) → Task 1 ✓
- C1 (resend ordering) → Task 5 ✓
- D1 (email validation) → Task 6 ✓
- E1 (hub session expiry) → Task 9 ✓

**Placeholders:** none found.

**Type consistency:** `requireAuth(req, res, slug, minRole)` — the new fourth parameter is used consistently across Tasks 3, 4. The `invite_expired` field added to the GET query in Task 7 matches the field read in the `_renderUsers` function.
