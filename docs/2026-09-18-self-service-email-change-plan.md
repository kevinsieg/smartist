# Self-service email change — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user change their own login email, confirmed by a link sent to the new address, applied across every band they belong to.

**Architecture:** Two new `?action=` branches on the existing `api/[artist]/auth.js` — `request-email-change` (authenticated) and `confirm-email-change` (unauthenticated, preview + apply in one action). Pending state lives in three new `users` columns mirroring the invite columns. A new static `/confirm-email` page reads the token from the URL fragment and drives the two-phase confirm.

**Tech Stack:** Node on Vercel serverless, postgres.js against Neon, bcryptjs, plain browser JS (no build step), i18n via `app/js/i18n.js`.

**Spec:** `docs/2026-09-18-self-service-email-change-design.md`

## Global Constraints

- `api/` is at **exactly 12 route files**, the Hobby-plan function limit. This feature adds **zero** new files under `api/` — only new branches inside `api/[artist]/auth.js`. Helpers under `api/_*` and `api/_domain/*` do not count.
- Tokens travel in the URL **fragment**, never the query string, so they cannot reach server or CDN logs.
- `app/i18n/{en,fr,de}.json` must hold an **identical key set** (currently 1095 keys each). Enforced by `tests/unit/i18n.js`.
- Page scripts loaded alongside `common.js` must not declare top-level `const`/`let` — SPA navigation re-executes them in the same document. Enforced by `tests/unit/page_scripts.js`.
- `I18N_VERSION` in `app/js/i18n.js` is currently `9`, and every page references `i18n.js?v=9`. Bump both together, in the last task only.
- Commit messages: short, lower-case subject, no attribution trailers.
- Transactional emails are English-only, matching `request-reset` and the invite mails.
- Every handler stays wrapped by `wrap(...)` — do not add a second `module.exports`.

**Note on page choice:** the existing inbox-token flow (invites) has no dedicated page; `app/js/home.js` reads `?invite=` on `/login` and renders inline. This plan follows the approved spec and adds a separate `/confirm-email` page instead, to avoid growing `home.js` further and because the confirm screen needs a two-phase preview that does not fit the login renderer.

---

### Task 1: Pending-email columns

**Files:**
- Modify: `scripts/schema.sql` (append at end of file, after the `storage_used_bytes` line)

**Interfaces:**
- Consumes: nothing
- Produces: `users.pending_email TEXT`, `users.email_change_token_hash TEXT`, `users.email_change_expires_at TIMESTAMPTZ`

- [ ] **Step 1: Append the columns**

Add to the very end of `scripts/schema.sql`:

```sql

-- 2026-09-18: self-service email change (pending address + single-use token)
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_expires_at TIMESTAMPTZ;
```

- [ ] **Step 2: Apply to the dev database**

Run: `node scripts/apply_schema.js`
Answer `y` at the prompt. Expected: `✓ N statements applied, M already existed` with no failure line.

- [ ] **Step 3: Verify the columns exist**

Run:

```bash
node -e '
const fs=require("fs");
for (const l of fs.readFileSync(".env","utf8").split("\n")) { const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)/); if (m && !process.env[m[1]]) process.env[m[1]]=m[2].trim().replace(/^"(.*)"$/,"$1"); }
const sql=require("postgres")(process.env.DATABASE_URL,{max:1});
(async()=>{
  const r=await sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${"users"} AND column_name LIKE ${"%email%"} ORDER BY column_name`;
  console.log(r.map(x=>x.column_name).join(", "));
  await sql.end();
})();'
```

Expected output includes: `email, email_change_expires_at, email_change_token_hash, pending_email`

- [ ] **Step 4: Commit**

```bash
git add scripts/schema.sql
git commit -m "feat: add pending email columns"
```

---

### Task 2: request-email-change

**Files:**
- Modify: `api/[artist]/auth.js` (insert a new branch immediately after the `change-password` branch, which ends at line 289)
- Test: `tests/unit/auth_handler.js` (append tests inside `run`, before its closing brace)

**Interfaces:**
- Consumes: `users.pending_email`, `users.email_change_token_hash`, `users.email_change_expires_at` (Task 1)
- Produces: `POST /api/:artist/auth?action=request-email-change` with body `{ currentPassword, newEmail }` → `200 { ok: true }`; writes `pending_email`, `email_change_token_hash` = `sha256(raw)`, `email_change_expires_at` = now + 24h on the caller's row

- [ ] **Step 1: Write the failing tests**

Append inside `run(r)` in `tests/unit/auth_handler.js`, before the final `}`:

```js
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
    assertEq(written[0], 'new@example.com');                        // lowercased pending address
    assert(/^[0-9a-f]{64}$/.test(written[1]), 'must store a sha256 hex hash');
    assert(new Date(written[2]).getTime() > Date.now(), 'expiry must be in the future');
    assert(sentMail && sentMail.to === 'new@example.com', 'confirmation mail goes to the NEW address');
    assert(!sentMail.html.includes(written[1]), 'the mail must carry the raw token, not the stored hash');
  });
```

The last test needs the stubbed mailer to record what it sent. In `makeHandler`, replace the `_email` stub:

```js
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendEmail: async (mail) => { sentMail = mail; } },
  };
```

and declare the recorder at module scope, next to `const ARTIST = ...`:

```js
let sentMail = null;
```

`makeHandler` already stubs `bcryptjs` with `compare: async () => false`. Change that stub so the password check is meaningful:

```js
      compare: async (plain) => plain === 'correct-password',
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/unit/auth_handler.js`
Expected: the four new tests FAIL with `got 405` — no branch matches, so the POST falls through to the handler's method guard.

- [ ] **Step 3: Write the implementation**

Insert into `api/[artist]/auth.js` directly after the `change-password` branch closes (after line 289, before the `// PUT — update user role` comment):

```js
  // POST ?action=request-email-change — caller asks to change their own login
  // email. Nothing changes until the link sent to the NEW address is confirmed:
  // email is the cross-workspace identity, so it must be proven, not asserted.
  if (req.method === 'POST' && action === 'request-email-change') {
    const { currentPassword, newEmail } = req.body ?? {};
    if (!currentPassword || !newEmail)
      return res.status(400).json({ error: 'currentPassword and newEmail required' });
    if (String(currentPassword).length > 1000)
      return res.status(400).json({ error: 'Password too long' });
    if (req.user.id === null)
      return res.status(400).json({ error: 'Email change is not available for this account' });

    const clean = validateStr(newEmail, 200);
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean))
      return res.status(400).json({ error: 'Invalid email address' });
    const lower = clean.toLowerCase();

    if (await checkRateLimit(`emailchg:${clientIp(req)}`, 5, 600))
      return res.status(429).json({ error: 'Too many attempts — try again later' });

    const [user] = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    if (!user || !user.password_hash || !await bcrypt.compare(String(currentPassword), user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });
    if (user.email.toLowerCase() === lower)
      return res.status(400).json({ error: 'That is already your email address' });

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires   = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await sql`
      UPDATE users
      SET pending_email = ${lower}, email_change_token_hash = ${tokenHash}, email_change_expires_at = ${expires}
      WHERE id = ${user.id}
    `;

    const h      = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const proto  = req.headers['x-forwarded-proto'] || (h.includes('localhost') ? 'http' : 'https');
    const origin = process.env.APP_ORIGIN || `${proto}://${h}`;
    // Fragment, not query — tokens must not land in server/CDN logs.
    const link   = `${origin}/confirm-email#token=${encodeURIComponent(rawToken)}&slug=${encodeURIComponent(slug)}`;

    try {
      await sendEmail({
        to: lower,
        subject: 'Confirm your new email address',
        html: `<p>Confirm this address to finish changing your smartist login email:</p>
               <p><a href="${link}">Confirm new email address</a></p>
               <p>Valid for 24 hours. If you did not request this, you can ignore this email.</p>`,
      });
    } catch (err) {
      await logger.error('email_change_request_failed', { band: slug, error: err.message });
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.json({ ok: true });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/unit/auth_handler.js`
Expected: PASS, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add "api/[artist]/auth.js" tests/unit/auth_handler.js
git commit -m "feat: request self-service email change"
```

---

### Task 3: confirm-email-change — preview mode

**Files:**
- Modify: `api/[artist]/auth.js` (insert a new branch immediately after the `request-email-change` branch from Task 2)
- Test: `tests/unit/auth_handler.js`

**Interfaces:**
- Consumes: the three columns from Task 1, written by Task 2
- Produces: `POST /api/:artist/auth?action=confirm-email-change` with body `{ token }` → `200 { newEmail, bands: [{ slug, name, role }] }`, writing nothing

- [ ] **Step 1: Write the failing test**

Append inside `run(r)` in `tests/unit/auth_handler.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/unit/auth_handler.js`
Expected: both new tests FAIL with `got 405` (unmatched POST falls through to the method guard).

- [ ] **Step 3: Write the implementation**

Insert into `api/[artist]/auth.js` after the Task 2 branch:

```js
  // POST ?action=confirm-email-change — public: the link is clicked from an
  // inbox, so there is no session. Two modes: without `confirm` it previews the
  // change (new address + every band affected); with `confirm: true` it applies.
  if (req.method === 'POST' && action === 'confirm-email-change') {
    const { token, confirm } = req.body ?? {};
    if (!token) return res.status(400).json({ error: 'token required' });
    if (await checkRateLimit(`emailchg-confirm:${clientIp(req)}`, 10, 600))
      return res.status(429).json({ error: 'Too many attempts — try again later' });

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const [pending] = await sql`
      SELECT id, email, pending_email FROM users
      WHERE email_change_token_hash = ${tokenHash}
        AND email_change_expires_at > now()
        AND pending_email IS NOT NULL
    `;
    if (!pending) return res.status(400).json({ error: 'Invalid or expired link' });

    // Every band reached by the current address — the change moves all of them.
    const bands = await sql`
      SELECT a.slug, a.name, u.role
      FROM users u JOIN artists a ON a.id = u.artist_id
      WHERE u.email = ${pending.email}
      ORDER BY a.name
    `;

    if (!confirm) return res.json({ newEmail: pending.pending_email, bands });
  }
```

Note: the apply half of this branch is Task 4. After Task 3 the branch ends with the preview return, so a `{ token, confirm: true }` call falls through to the handler's 405/404 — Task 4 closes that gap.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/unit/auth_handler.js`
Expected: PASS, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add "api/[artist]/auth.js" tests/unit/auth_handler.js
git commit -m "feat: preview pending email change"
```

---

### Task 4: confirm-email-change — apply mode

**Files:**
- Modify: `api/[artist]/auth.js` (replace the `if (!confirm) return ...` line from Task 3 with preview return plus the apply block)
- Test: `tests/unit/auth_handler.js`

**Interfaces:**
- Consumes: the preview lookup and `bands` query from Task 3
- Produces: `{ token, confirm: true }` → `200 { ok: true, email }`; rewrites `users.email` for every row holding the old address and clears the three pending columns; `409 { error }` when the address is taken in an affected band

- [ ] **Step 1: Write the failing tests**

Append inside `run(r)` in `tests/unit/auth_handler.js`:

```js
  await testAsync('POST confirm-email-change applies to every band and clears the token', async () => {
    const rawToken  = 'c'.repeat(64);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const sql = makeSqlStub([
      {
        match: text => text.includes('email_change_token_hash'),
        rows: () => [{ id: 7, email: 'old@example.com', pending_email: 'new@example.com' }],
      },
      { match: text => text.includes('JOIN artists a'), rows: () => [{ slug: 'band-a', name: 'Band A', role: 'admin' }] },
      { match: text => text.includes('SELECT 1 FROM users'), rows: () => [] },  // no collision
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
  });

  await testAsync('POST confirm-email-change refuses an address already used in an affected band', async () => {
    const rawToken  = 'd'.repeat(64);
    const sql = makeSqlStub([
      {
        match: text => text.includes('email_change_token_hash'),
        rows: () => [{ id: 7, email: 'old@example.com', pending_email: 'taken@example.com' }],
      },
      { match: text => text.includes('JOIN artists a'), rows: () => [{ slug: 'band-a', name: 'Band A', role: 'admin' }] },
      { match: text => text.includes('SELECT 1 FROM users'), rows: () => [{ name: 'Band A' }] },  // collision
      { match: text => text.includes('SET email'), rows: () => { throw new Error('must not rewrite on collision'); } },
    ]);
    sql.begin = async fn => fn(sql);
    const handler = makeHandler({ sql });
    const res = mockRes();

    await handler(authReq('POST', '/api/test/auth?action=confirm-email-change', { token: rawToken, confirm: true }), res);

    assertEq(res.statusCode, 409);
    assertEq(sql.calls.filter(c => c.text.includes('SET email')).length, 0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/unit/auth_handler.js`
Expected: both FAIL with `got 405` — the apply path does not exist yet, so the POST falls through to the method guard.

- [ ] **Step 3: Write the implementation**

In `api/[artist]/auth.js`, replace the single line

```js
    if (!confirm) return res.json({ newEmail: pending.pending_email, bands });
```

with:

```js
    if (!confirm) return res.json({ newEmail: pending.pending_email, bands });

    const oldEmail = pending.email;
    const target   = pending.pending_email;
    try {
      await sql.begin(async tx => {
        // Refuse if the address is already taken in any band this change touches.
        const [clash] = await tx`
          SELECT 1 FROM users u
          JOIN artists a ON a.id = u.artist_id
          WHERE u.email = ${target}
            AND u.artist_id IN (SELECT artist_id FROM users WHERE email = ${oldEmail})
          LIMIT 1
        `;
        if (clash) { const e = new Error('taken'); e.taken = true; throw e; }

        // One statement moves every membership, so the person keeps all bands.
        await tx`UPDATE users SET email = ${target} WHERE email = ${oldEmail}`;
        await tx`
          UPDATE users
          SET pending_email = NULL, email_change_token_hash = NULL, email_change_expires_at = NULL
          WHERE id = ${pending.id}
        `;
      });
    } catch (err) {
      // 23505 = unique_violation: someone claimed the address mid-flight.
      if (err.taken || err.code === '23505')
        return res.status(409).json({ error: 'That email address is already in use' });
      throw err;
    }

    // Tell the old address after the change is durable. A mail failure must not
    // roll it back — retrying would risk applying the change twice.
    try {
      await sendEmail({
        to: oldEmail,
        subject: 'Your email address was changed',
        html: `<p>Your smartist login email was changed to ${target}.</p>
               <p>If you did not do this, contact support immediately.</p>`,
      });
    } catch (err) {
      await logger.error('email_change_notice_failed', { band: slug, error: err.message });
    }

    return res.json({ ok: true, email: target });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/unit/auth_handler.js`
Expected: PASS, 0 failed.

- [ ] **Step 5: Run the whole unit suite**

Run: `node tests/unit.js`
Expected: 0 failed.

- [ ] **Step 6: Commit**

```bash
git add "api/[artist]/auth.js" tests/unit/auth_handler.js
git commit -m "feat: apply confirmed email change across bands"
```

---

### Task 5: Confirm page

**Files:**
- Create: `app/confirm-email.html`
- Modify: `vercel.json` (add a rewrite next to the other flat page rewrites, after the `/workspaces` line)

**Interfaces:**
- Consumes: `POST /api/:artist/auth?action=confirm-email-change` from Tasks 3 and 4
- Produces: the `/confirm-email` route

- [ ] **Step 1: Add the rewrite**

In `vercel.json`, directly after the `/workspaces` entry, add:

```json
    { "source": "/confirm-email",   "destination": "/app/confirm-email.html" },
```

- [ ] **Step 2: Create the page**

Create `app/confirm-email.html`. It mirrors `app/profile.html`'s head block, but must **not** call `initPage` (that forces a login) and must use `var`, never top-level `const`/`let`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm email — smartist</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon_io/favicon-32x32.png">
  <link rel="stylesheet" href="/app/css/app.css?v=29">
  <script src="/app/js/i18n.js?v=9"></script>
  <style>
    .confirm-wrap { max-width: 460px; margin: 0 auto; padding: 4.5rem 1.25rem 4rem; }
    .confirm-bands { margin: 0.75rem 0 1.25rem; padding-left: 1.1rem; }
    .confirm-bands li { margin-bottom: 0.3rem; }
  </style>
</head>
<body>
<div class="app-wrap confirm-wrap">
  <h1 data-i18n="confirmEmail.title">Confirm your new email address</h1>
  <div id="confirm-status" class="status-msg" data-i18n="confirmEmail.checking">Checking your link…</div>

  <div id="confirm-body" style="display:none;">
    <p><span data-i18n="confirmEmail.newAddress">New address</span>: <strong id="confirm-email-value"></strong></p>
    <p data-i18n="confirmEmail.affects">This will apply to every band you belong to:</p>
    <ul class="confirm-bands" id="confirm-bands"></ul>
    <div class="save-row">
      <button class="btn active" id="confirm-btn" data-i18n="confirmEmail.confirmBtn">Confirm change</button>
      <span class="save-msg" id="confirm-msg"></span>
    </div>
  </div>

  <p id="confirm-done" style="display:none;">
    <a href="/login" data-i18n="confirmEmail.loginLink">Log in with your new address</a>
  </p>
</div>

<script src="/app/js/common.js?v=14"></script>
<script>
(function () {
  var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  var token  = params.get('token') || '';
  var slug   = params.get('slug')  || '';
  // Strip the token from the address bar so it does not linger in history.
  history.replaceState(null, '', window.location.pathname);

  var statusEl = document.getElementById('confirm-status');

  function fail(key) {
    statusEl.textContent = t(key);
    statusEl.className = 'status-msg error';
  }

  async function post(body) {
    return await fetch('/api/' + encodeURIComponent(slug) + '/auth?action=confirm-email-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function start() {
    if (window.i18n && window.i18n.ready) { try { await window.i18n.ready; } catch (e) {} }
    if (!token || !slug) { fail('confirmEmail.badLink'); return; }
    try {
      var r = await post({ token: token });
      var data = await r.json();
      if (!r.ok) { fail('confirmEmail.invalid'); return; }
      document.getElementById('confirm-email-value').textContent = data.newEmail;
      document.getElementById('confirm-bands').innerHTML =
        (data.bands || []).map(function (b) { return '<li>' + escHtml(b.name) + '</li>'; }).join('');
      statusEl.style.display = 'none';
      document.getElementById('confirm-body').style.display = '';
    } catch (e) { fail('confirmEmail.connError'); }
  }

  document.getElementById('confirm-btn').addEventListener('click', async function () {
    var btn = document.getElementById('confirm-btn');
    var msg = document.getElementById('confirm-msg');
    btn.disabled = true;
    msg.className = 'save-msg';
    msg.textContent = t('confirmEmail.applying');
    try {
      var r = await post({ token: token, confirm: true });
      var data = await r.json();
      if (!r.ok) {
        msg.textContent = data.error || t('confirmEmail.failed');
        msg.className = 'save-msg err';
        btn.disabled = false;
        return;
      }
      document.getElementById('confirm-body').style.display = 'none';
      statusEl.style.display = '';
      statusEl.textContent = t('confirmEmail.changed');
      statusEl.className = 'status-msg';
      document.getElementById('confirm-done').style.display = '';
    } catch (e) {
      msg.textContent = t('confirmEmail.connError');
      msg.className = 'save-msg err';
      btn.disabled = false;
    }
  });

  start();
}());
</script>
</body>
</html>
```

- [ ] **Step 3: Verify the page script obeys the SPA rule**

Run: `node tests/unit/page_scripts.js`
Expected: PASS — including a line for `confirm-email.html`'s scripts, with no top-level `const`/`let` reported.

- [ ] **Step 4: Commit**

```bash
git add app/confirm-email.html vercel.json
git commit -m "feat: add confirm email page"
```

---

### Task 6: Profile UI

**Files:**
- Modify: `app/profile.html` (replace the email section at lines 33-37; add a handler in the inline script)

**Interfaces:**
- Consumes: `POST /api/:artist/auth?action=request-email-change` from Task 2
- Produces: no new interface

- [ ] **Step 1: Replace the email section**

Replace lines 33-37 of `app/profile.html` with:

```html
  <div class="profile-section">
    <label data-i18n="profile.emailLabel">Email</label>
    <div class="profile-email" id="profile-email">—</div>
    <div class="profile-hint" data-i18n="profile.emailHint">Your login email.</div>
  </div>

  <div class="profile-section" id="email-section" style="display:none;">
    <label data-i18n="profile.changeEmail">Change email</label>
    <input type="password" id="em-current" placeholder="Current password" autocomplete="current-password" data-i18n-attr="placeholder:profile.pwCurrent">
    <input type="email" id="em-new" placeholder="New email address" autocomplete="email" data-i18n-attr="placeholder:profile.emNew">
    <div class="save-row">
      <button class="btn active" id="em-save-btn" data-i18n="profile.sendConfirmation">Send confirmation link</button>
      <span class="save-msg" id="em-msg"></span>
    </div>
    <div class="profile-hint" data-i18n="profile.emailChangeHint">We email a link to the new address. Your login only changes once you confirm it there.</div>
  </div>
```

- [ ] **Step 2: Wire it up**

In the inline script of `app/profile.html`, inside `initPage(...)`, directly after the existing `document.getElementById('pw-save-btn').addEventListener('click', changePassword);` line, add:

```js
    document.getElementById('email-section').style.display = '';
    document.getElementById('em-save-btn').addEventListener('click', requestEmailChange);
```

and add this function after `changePassword`:

```js
  async function requestEmailChange() {
    var cur = document.getElementById('em-current').value;
    var nw  = document.getElementById('em-new').value.trim();
    var msg = document.getElementById('em-msg');
    msg.className = 'save-msg';
    if (!cur || !nw) { msg.textContent = t('profile.fillAll'); msg.className = 'save-msg err'; return; }
    var btn = document.getElementById('em-save-btn');
    btn.disabled = true; msg.textContent = t('profile.saving');
    try {
      var r = await apiFetch('/api/' + _slug + '/auth?action=request-email-change', 'POST',
        { currentPassword: cur, newEmail: nw });
      var data = await r.json();
      if (!r.ok) { msg.textContent = data.error || t('profile.failed'); msg.className = 'save-msg err'; return; }
      msg.textContent = t('profile.emailLinkSent'); msg.className = 'save-msg ok';
      document.getElementById('em-current').value = '';
      document.getElementById('em-new').value = '';
    } catch (e) {
      if (!String(e.message).includes('Session')) { msg.textContent = t('profile.connError'); msg.className = 'save-msg err'; }
    } finally { btn.disabled = false; }
  }
```

The bootstrap branch returns before these lines, so accounts without a `users` row never see the section — matching the server's rejection.

- [ ] **Step 3: Commit**

```bash
git add app/profile.html
git commit -m "feat: add change email to profile"
```

---

### Task 7: Translations and cache version

**Files:**
- Modify: `app/i18n/en.json`, `app/i18n/fr.json`, `app/i18n/de.json`
- Modify: `app/js/i18n.js` (`I18N_VERSION` 9 → 10)
- Modify: every `app/*.html` (`i18n.js?v=9` → `?v=10`)

**Interfaces:**
- Consumes: the `data-i18n` keys used in Tasks 5 and 6
- Produces: no new interface

- [ ] **Step 1: Add the English keys**

In `app/i18n/en.json`, after `"profile.emailHint"`, add:

```json
  "profile.changeEmail": "Change email",
  "profile.emNew": "New email address",
  "profile.sendConfirmation": "Send confirmation link",
  "profile.emailChangeHint": "We email a link to the new address. Your login only changes once you confirm it there.",
  "profile.emailLinkSent": "Confirmation link sent. Check the new address.",
  "confirmEmail.title": "Confirm your new email address",
  "confirmEmail.checking": "Checking your link…",
  "confirmEmail.newAddress": "New address",
  "confirmEmail.affects": "This will apply to every band you belong to:",
  "confirmEmail.confirmBtn": "Confirm change",
  "confirmEmail.applying": "Applying…",
  "confirmEmail.changed": "Your email address has been changed.",
  "confirmEmail.loginLink": "Log in with your new address",
  "confirmEmail.badLink": "This link is incomplete. Request a new one from your profile.",
  "confirmEmail.invalid": "This link is invalid or has expired. Request a new one from your profile.",
  "confirmEmail.failed": "Could not apply the change.",
  "confirmEmail.connError": "Connection error.",
```

- [ ] **Step 2: Add the French keys**

In `app/i18n/fr.json`, at the same position:

```json
  "profile.changeEmail": "Modifier l'e-mail",
  "profile.emNew": "Nouvelle adresse e-mail",
  "profile.sendConfirmation": "Envoyer le lien de confirmation",
  "profile.emailChangeHint": "Nous envoyons un lien à la nouvelle adresse. Votre identifiant ne change qu'après confirmation.",
  "profile.emailLinkSent": "Lien de confirmation envoyé. Vérifiez la nouvelle adresse.",
  "confirmEmail.title": "Confirmez votre nouvelle adresse e-mail",
  "confirmEmail.checking": "Vérification de votre lien…",
  "confirmEmail.newAddress": "Nouvelle adresse",
  "confirmEmail.affects": "Ceci s'appliquera à tous vos groupes :",
  "confirmEmail.confirmBtn": "Confirmer la modification",
  "confirmEmail.applying": "Application…",
  "confirmEmail.changed": "Votre adresse e-mail a été modifiée.",
  "confirmEmail.loginLink": "Se connecter avec la nouvelle adresse",
  "confirmEmail.badLink": "Ce lien est incomplet. Demandez-en un nouveau depuis votre profil.",
  "confirmEmail.invalid": "Ce lien est invalide ou a expiré. Demandez-en un nouveau depuis votre profil.",
  "confirmEmail.failed": "Impossible d'appliquer la modification.",
  "confirmEmail.connError": "Erreur de connexion.",
```

- [ ] **Step 3: Add the German keys**

In `app/i18n/de.json`, at the same position:

```json
  "profile.changeEmail": "E-Mail ändern",
  "profile.emNew": "Neue E-Mail-Adresse",
  "profile.sendConfirmation": "Bestätigungslink senden",
  "profile.emailChangeHint": "Wir senden einen Link an die neue Adresse. Ihr Login ändert sich erst nach der Bestätigung dort.",
  "profile.emailLinkSent": "Bestätigungslink gesendet. Prüfen Sie die neue Adresse.",
  "confirmEmail.title": "Bestätigen Sie Ihre neue E-Mail-Adresse",
  "confirmEmail.checking": "Link wird geprüft…",
  "confirmEmail.newAddress": "Neue Adresse",
  "confirmEmail.affects": "Dies gilt für alle Bands, zu denen Sie gehören:",
  "confirmEmail.confirmBtn": "Änderung bestätigen",
  "confirmEmail.applying": "Wird angewendet…",
  "confirmEmail.changed": "Ihre E-Mail-Adresse wurde geändert.",
  "confirmEmail.loginLink": "Mit der neuen Adresse anmelden",
  "confirmEmail.badLink": "Dieser Link ist unvollständig. Fordern Sie in Ihrem Profil einen neuen an.",
  "confirmEmail.invalid": "Dieser Link ist ungültig oder abgelaufen. Fordern Sie in Ihrem Profil einen neuen an.",
  "confirmEmail.failed": "Die Änderung konnte nicht angewendet werden.",
  "confirmEmail.connError": "Verbindungsfehler.",
```

FR and DE are a machine-quality first pass — flag them for native review before production.

- [ ] **Step 4: Bump the cache version**

In `app/js/i18n.js` change `var I18N_VERSION = 9;` to `var I18N_VERSION = 10;`, then update every page:

```bash
grep -rl "i18n\.js?v=9" app --include='*.html' | xargs sed -i '' -e 's#i18n.js?v=9#i18n.js?v=10#g'
grep -rhoE "i18n\.js\?v=[0-9]+" app --include='*.html' | sort | uniq -c
```

Expected: one line, `21 i18n.js?v=10` (20 existing pages plus the new confirm page).

- [ ] **Step 5: Verify key parity and versions**

Run: `node tests/unit.js`
Expected: 0 failed — `tests/unit/i18n.js` proves all three locales hold the same keys, and `tests/unit/asset_versions.js` proves every page agrees on the version.

- [ ] **Step 6: Commit**

```bash
git add app/i18n app/js/i18n.js app/*.html
git commit -m "i18n: add email change strings, bump cache version"
```

---

### Task 8: Integration coverage and final verification

**Files:**
- Modify: `tests/api.js` (append inside `testAuth`, which spans lines 536-641 — insert directly after the `PATCH /config without token → 401` test that ends at line 640, before the function's closing brace. Note `testMultiUserAuth` starts at line 645; these tests do **not** belong there, since they need no password.)

**Interfaces:**
- Consumes: both actions from Tasks 2-4
- Produces: no new interface

- [ ] **Step 1: Write the tests**

Append inside `testAuth(slug)` in `tests/api.js`:

```js
  await test('POST request-email-change without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/auth?action=request-email-change`,
      { currentPassword: 'x'.repeat(8), newEmail: 'someone@example.com' });
    assertStatus(res, json, 401);
  });

  await test('POST confirm-email-change without a token → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/auth?action=confirm-email-change`, {});
    assertStatus(res, json, 400);
  });

  await test('POST confirm-email-change with a garbage token → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/auth?action=confirm-email-change`,
      { token: 'e'.repeat(64) });
    assertStatus(res, json, 400);
  });
```

- [ ] **Step 2: Run the integration suite**

With `vercel dev` running on port 3000:

Run: `cd tests && npm test`
Expected: 0 failed. The three new tests pass without `ARTIST_PASSWORD`, since they only exercise rejection paths.

- [ ] **Step 3: Run everything**

Run: `node tests/unit.js && npm run test:unit`
Expected: 0 failed.

- [ ] **Step 4: Manual end-to-end check**

With `vercel dev` running and a real address you control:

1. Log in, open `/:slug/profile`, enter your password and the new address, submit. Expect "Confirmation link sent".
2. Open the emailed link. Expect the new address and your bands listed, with a Confirm button.
3. Confirm. Expect the success message, and a notice mail at the **old** address.
4. Log in with the new address. Expect your bands and role unchanged.
5. Re-open the same link. Expect "invalid or has expired" — the token is single-use.

- [ ] **Step 5: Commit**

```bash
git add tests/api.js
git commit -m "test: cover email change rejection paths"
```

---

## Self-review

**Spec coverage:** request action (Task 2), confirm preview (Task 3), confirm apply with transaction, collision and `23505` handling (Task 4), notice to the old address (Task 4), schema columns (Task 1), fragment-only token and the `/confirm-email` route (Task 5), profile UI (Task 6), i18n and version bump (Task 7), unit and integration tests plus the manual walk-through (Tasks 2-4, 8), rollout (Task 1 Step 2 for dev; production migration stays with the deploy, per the spec).

**Names checked across tasks:** `pending_email`, `email_change_token_hash`, `email_change_expires_at` are spelled identically in Tasks 1-4. The actions are `request-email-change` and `confirm-email-change` everywhere. The preview response keys `newEmail` and `bands` match between Task 3, Task 4 and the page in Task 5. Rate-limit keys `emailchg:` and `emailchg-confirm:` match the spec.

**Known deviations from the spec:** none. The spec's `?v=` numbers were written before this branch; Task 7 uses the values actually present here (`I18N_VERSION` 9 → 10, `app.css?v=29`).
