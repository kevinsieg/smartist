# Profile / Settings Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the misnamed profile page into a slim personal `/profile` (email, change password) and an admin-only `/settings` page that absorbs the users page plus all workspace config (band photo/name, privacy, columns/filters, instruments with member mapping).

**Architecture:** Two API additions inside the existing `api/[artist]/auth.js` (no new serverless function — Hobby 12-function limit). New `app/settings.html` + `app/js/settings.js` assembled from today's `users.html`/`users.js` and the workspace sections of `profile.html`. `profile.html` is rebuilt small. Nav link "Users" becomes "Settings"; `/users` rewrite repoints to the settings page.

**Tech Stack:** Vanilla JS (no build step), Vercel serverless, postgres.js/Neon, bcryptjs.

**Spec:** `docs/2026-06-12-profile-settings-refactor-design.md`

**Workflow note (user preference):** Do NOT commit during execution. A single user-verification checkpoint at the end gates the commit. Pause there.

---

### Task 1: API — `POST ?action=change-password`

**Files:**
- Modify: `api/[artist]/auth.js` (insert after the resend-invite block, before the PUT block, ~line 266)
- Test: `tests/api.js` (inside `testMultiUserAuth`, before the final 401 tests)

- [ ] **Step 1: Write the failing tests**

Add to `testMultiUserAuth` in `tests/api.js` (after the "PUT updates user role" test):

```js
  // POST ?action=change-password
  await test('POST change-password without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/auth?action=change-password`,
      { currentPassword: 'a'.repeat(8), newPassword: 'b'.repeat(8) });
    assertStatus(res, json, 401);
  });

  await test('POST change-password with bootstrap token → 400', async () => {
    // Bootstrap login has no users row (req.user.id === null) — nothing to update.
    const { res, json } = await POST(`/api/${slug}/auth?action=change-password`,
      { currentPassword: 'a'.repeat(8), newPassword: 'b'.repeat(8) }, { token });
    assertStatus(res, json, 400);
  });

  await test('POST change-password short newPassword → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/auth?action=change-password`,
      { currentPassword: 'a'.repeat(8), newPassword: 'short' }, { token });
    assertStatus(res, json, 400);
  });

  await test('POST change-password missing fields → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/auth?action=change-password`,
      {}, { token });
    assertStatus(res, json, 400);
  });
```

(The success path needs a real per-user password; it cannot run with the bootstrap token. Covered by manual verification in Task 8.)

- [ ] **Step 2: Run tests to verify they fail**

Run (vercel dev must be running on port 3000):
```bash
cd tests && ARTIST_PASSWORD=… npm test
```
Expected: the four new tests FAIL — unknown action currently falls through to `405 Method not allowed`, not 401/400.
Note: the no-token case may already pass (requireAuth runs first); that's fine.

- [ ] **Step 3: Implement the endpoint**

In `api/[artist]/auth.js`, after the `resend-invite` block (after line 266, before the `PUT` block), insert:

```js
  // POST ?action=change-password — caller changes their own password
  if (req.method === 'POST' && action === 'change-password') {
    const { currentPassword, newPassword } = req.body ?? {};
    if (req.user.id === null)
      return res.status(400).json({ error: 'Not available for password-only login' });
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    if (String(newPassword).length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (String(newPassword).length > 1000)
      return res.status(400).json({ error: 'Password too long' });
    if (await checkRateLimit(`chpw:${clientIp(req)}`, 5, 600))
      return res.status(429).json({ error: 'Too many attempts — try again later' });

    const [user] = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    if (!user || !user.password_hash || !await bcrypt.compare(String(currentPassword), user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(String(newPassword), 12);
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${user.id}`;
    return res.json({ ok: true });
  }
```

(All requires — `bcrypt`, `checkRateLimit`, `clientIp` — are already imported at the top of the file. Note: password hashes are per-workspace `users` rows by design; this changes the password for this workspace only, consistent with login and accept-invite.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd tests && ARTIST_PASSWORD=… npm test
```
Expected: all four new tests PASS, no existing test regresses.

---

### Task 2: API — `PUT /api/:artist/auth` accepts `email`

**Files:**
- Modify: `api/[artist]/auth.js:268-283` (the PUT block)
- Test: `tests/api.js` (inside `testMultiUserAuth`)

- [ ] **Step 1: Write the failing tests**

Add to `testMultiUserAuth`, right after the existing "PUT updates user role" test:

```js
  if (_testUserId) {
    await test('PUT updates user email → 200', async () => {
      const newEmail = '[TEST]renamed_' + Date.now() + '@example.com';
      const { res, json } = await PUT(`/api/${slug}/auth`,
        { userId: _testUserId, email: newEmail }, { token });
      assertStatus(res, json, 200);
      assert(json.user?.email === newEmail.toLowerCase(), 'email updated');
    });

    await test('PUT email duplicate of existing user → 409', async () => {
      // First user in the list is some other account; reusing its email must conflict.
      const { json: list } = await GET(`/api/${slug}/auth`, { token });
      const other = (list.users || []).find(u => u.id !== _testUserId);
      if (!other) { console.log('    (skipped — only one user)'); return; }
      const { res, json } = await PUT(`/api/${slug}/auth`,
        { userId: _testUserId, email: other.email }, { token });
      assertStatus(res, json, 409);
    });

    await test('PUT invalid email → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/auth`,
        { userId: _testUserId, email: 'not-an-email' }, { token });
      assertStatus(res, json, 400);
    });
  }

  await test('PUT with neither role nor email → 400', async () => {
    const { res, json } = await PUT(`/api/${slug}/auth`,
      { userId: 999999 }, { token });
    assertStatus(res, json, 400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd tests && ARTIST_PASSWORD=… npm test
```
Expected: email tests FAIL (current PUT rejects with "Invalid role" / requires role). The "neither role nor email" test FAILS (currently returns "Invalid role", a 400 — verify the failure message; if it already returns 400 the test passes by accident, which is acceptable but note it).

- [ ] **Step 3: Replace the PUT block**

Replace `api/[artist]/auth.js` lines 268-283 (the whole `// PUT — update user role (admin)` block) with:

```js
  // PUT — update user role and/or email (admin)
  if (req.method === 'PUT') {
    if (!requireRole(req, res, 'admin')) return;
    const { userId, role, email } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (role === undefined && email === undefined)
      return res.status(400).json({ error: 'role or email required' });

    const updates = {};
    if (role !== undefined) {
      if (!['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
      if (req.user.id !== null && req.user.id === Number(userId))
        return res.status(400).json({ error: 'Cannot change your own role' });
      updates.role = role;
    }
    if (email !== undefined) {
      const cleanEmail = validateStr(email, 200);
      if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail))
        return res.status(400).json({ error: 'Invalid email address' });
      const lower = cleanEmail.toLowerCase();
      const [conflict] = await sql`
        SELECT id FROM users
        WHERE artist_id = ${artist.id} AND email = ${lower} AND id <> ${Number(userId)}
      `;
      if (conflict) return res.status(409).json({ error: 'A user with this email already exists' });
      updates.email = lower;
    }

    const [updated] = await sql`
      UPDATE users SET ${sql(updates)}
      WHERE id = ${Number(userId)} AND artist_id = ${artist.id}
      RETURNING id, email, role
    `;
    if (!updated) return res.status(404).json({ error: 'User not found' });
    return res.json({ ok: true, user: updated });
  }
```

(`sql(updates)` is postgres.js dynamic-column syntax. Self-email change is allowed on purpose; self-role change stays blocked. Changing an email detaches that membership from the user's other workspaces — accepted in the spec.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd tests && ARTIST_PASSWORD=… npm test
```
Expected: all new tests PASS; existing role-update tests still PASS.

---

### Task 3: `app/settings.html` — page shell

**Files:**
- Create: `app/settings.html`

- [ ] **Step 1: Create the file**

Assemble `app/settings.html` from existing pieces — the result is a standard page (head copied from `app/users.html:1-13`, stylesheet `app.css?v=27`) with `<title>Settings</title>` and this exact body structure:

```html
<body>
<script src="/app/js/common.js?v=12"></script>

<div class="app-wrap settings-wrap">
  <h1>Settings</h1>
  <div id="settings-loading" style="text-align:center;color:var(--third-color);padding:2rem 0;">Loading…</div>

  <div id="settings-content" style="display:none;">

    <!-- ── Band ──────────────────────────────────────────────── -->
    <section class="settings-card">
      <h2 class="settings-card-title">Band</h2>
      <!-- photo block: copy app/profile.html lines 233-243 unchanged -->
      <!-- favicon block: copy app/profile.html lines 245-257 unchanged -->
      <!-- band name section: copy app/profile.html lines 259-267 unchanged -->
      <!-- slug section: copy app/profile.html lines 269-273 unchanged -->
    </section>

    <!-- ── App settings ──────────────────────────────────────── -->
    <section class="settings-card">
      <h2 class="settings-card-title">App settings</h2>
      <!-- privacy section: copy app/profile.html lines 275-283 unchanged -->
      <!-- display fields section: copy app/profile.html lines 285-294 unchanged -->
      <!-- filter fields section: copy app/profile.html lines 312-321 unchanged -->
    </section>

    <!-- ── Members ───────────────────────────────────────────── -->
    <section class="settings-card">
      <h2 class="settings-card-title">Members</h2>
      <!-- invite bar + lists: copy app/users.html lines 44-65 unchanged
           (invite-bar, users-status, Active list, pending-section) -->
    </section>

    <!-- ── Instruments ───────────────────────────────────────── -->
    <section class="settings-card">
      <h2 class="settings-card-title">Instruments</h2>
      <!-- arrangement section: copy app/profile.html lines 296-310 unchanged,
           but change its inner labels to:
           "Instruments & Techniques" (instruments list first),
           then "Band members" (members list second) — instruments must be
           defined before they can be assigned to members. -->
    </section>

  </div>
</div>
<script src="/app/js/settings.js"></script>
</body>
```

Into the `<style>` block copy, in this order:
1. All styles from `app/users.html:15-38` (`.users-wrap` … `.empty-users`) — rename `.users-wrap` to `.settings-wrap` and change its `max-width` to `680px`.
2. From `app/profile.html`: the photo/favicon styles (lines 21-127), field styles (lines 129-163), config-editor styles (lines 173-190), arrangement styles (lines 192-212). Skip `.profile-wrap` and `.auth-notice` (not needed).
3. Add the new card styles:

```css
    .settings-card { border:1px solid var(--border-color); border-radius:6px; background:var(--bg-color); padding:1.25rem 1.25rem 1.5rem; margin-bottom:1.75rem; }
    .settings-card-title { font-size:0.78rem; letter-spacing:0.18em; text-transform:uppercase; color:var(--third-color); margin:0 0 1.25rem; border-bottom:1px solid var(--border-color); padding-bottom:0.6rem; }
    .photo-block { margin-bottom:1.5rem; }
```

- [ ] **Step 2: Sanity-check in browser**

With `vercel dev` running, open `http://localhost:3000/app/settings.html` directly. Expected: page renders "Settings" + "Loading…" (script 404s until Task 4 — that's fine), no console CSS errors.

---

### Task 4: `app/js/settings.js` — port users.js + workspace config + email edit

**Files:**
- Create: `app/js/settings.js`

- [ ] **Step 1: Assemble the file**

`app/js/settings.js` = current `app/js/users.js` content + the workspace parts of the inline script in `app/profile.html:326-972`, merged as follows (top-level `var`, not `let` — SPA re-execution rule; private names to avoid clobbering common.js globals):

1. **Start from `app/js/users.js` verbatim** (lines 1-167), with these changes:
   - Replace the whole `initPage(...)` block (lines 6-22) with:

```js
initPage(function(cfg) {
  if (requireLogin()) return;
  var _role = getAuthRole();
  if (_role !== null && _role !== 'admin') { navigate('/dashboard'); return; }
  _artistSlug = cfg.slug;
  try {
    var tok = getToken();
    if (tok) {
      var b64 = tok.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var outer = JSON.parse(atob(b64));
      if (outer.payload) _currentUserId = JSON.parse(outer.payload).userId || null;
    }
  } catch {}
  document.getElementById('settings-loading').style.display = 'none';
  document.getElementById('settings-content').style.display = '';
  document.querySelectorAll('button.auth-action').forEach(function(el) { el.disabled = false; });
  renderWorkspace(cfg);
  loadUsers();
});
```

   - In `_renderUsers`, keep everything but add an Edit-email button to active rows: change the `actionCell` assignment to:

```js
        var editBtn = '<button class="user-action-btn" onclick="_editEmail(' + u.id + ',\'' + escHtml(u.email) + '\')">Edit email</button>';
        var actionCell = isMe
          ? '<span style="display:flex;gap:0.35rem">' + editBtn + '</span>'
          : '<span style="display:flex;gap:0.35rem">' + editBtn +
            '<button class="user-action-btn danger" onclick="_removeUser(' + u.id + ',\'' + escHtml(u.email) + '\')">Remove</button></span>';
```

   - After `_resendInvite`, append the new email-edit + a users-cache hook:

```js
var _settingsUsers = [];   // active users, cached for the account-link dropdowns

async function _editEmail(userId, currentEmail) {
  var next = prompt('New email for ' + currentEmail + ':', currentEmail);
  if (next === null) return;
  next = next.trim();
  if (!next || next === currentEmail) return;
  setStatus('users-status', '');
  try {
    const r    = await apiFetch('/api/' + _artistSlug + '/auth', 'PUT', { userId, email: next });
    const data = await r.json();
    if (!r.ok) { setStatus('users-status', data.error || 'Failed to update email.', true); return; }
    setStatus('users-status', 'Email updated to ' + data.user.email + '.');
    loadUsers();
  } catch {}
}
```

   - In `loadUsers`, after `const { users } = await r.json();` add:

```js
    _settingsUsers = users.filter(function(u) { return u.accepted; });
    _renderArrMembersIfReady();
```

2. **Port the workspace config code from `app/profile.html`'s inline script.** Copy these functions/blocks out of the IIFE into settings.js as top-level functions, unchanged unless noted:
   - `_profileCfg` var and `STANDARD_FIELDS` (profile.html lines 735-747)
   - `initials` (lines 363-365)
   - arrangement config block (lines 367-495): `_arrCfg`, `renderArrMembers`, `renderArrInstruments`, all `arr*` handlers, `saveArrangementConfig` — Task 5 modifies `renderArrMembers`; port as-is first
   - `renderProfile` (lines 499-630) — **rename to `renderWorkspace`**, and replace its `artistSlug` references with `_artistSlug`
   - `showFavicon`/`uploadFavicon` (632-682), `showPhoto`/`uploadPhoto` (684-733)
   - field editors (749-934): `renderFieldTags`, `openDisplayFieldsEditor`, `removeCustomDisplayField`, `_typeSelect`, `addCustomDisplayField`, `closeDisplayFieldsEditor`, `saveDisplayFields`, `openFilterFieldsEditor`, `closeFilterFieldsEditor`, `saveFilterFields`
   - `patchConfig` (936-949) — replace `artistSlug` with `_artistSlug`
   - the `window.*` export block (lines 952-969) — keep, since onclick attributes need globals; settings.js is not an IIFE so plain top-level `function` declarations are already global, meaning the export block can be dropped entirely. Drop it.
   - **Do not port:** `init()`, the view-mode handling, the bootstrap-prompt fetch (lines 350-357), `profile-loading`/`profile-auth-notice` references — the settings page is admin-only, never view-mode.
   - In `renderWorkspace` delete the two lines referencing `profile-content` and the `auth-action` enable loop (now done in initPage), i.e. lines 501-502 of the original.
   - Add a stub used by the users-cache hook (Task 5 fills it in):

```js
function _renderArrMembersIfReady() {
  if (_profileCfg) renderArrMembers(_arrCfg().members || []);
}
```

3. **`loadConfig` light mode:** the old profile used `loadConfig(undefined, { light: true })`. `initPage`'s `cfg` is the standard config — check `initPage` (common.js:700) passes the full config; `renderWorkspace` needs `cfg.config` (displayFields etc.), which the light config may omit for non-authed users but settings is always authed. Use the `cfg` that `initPage` provides; verify in the browser that displayFields/filterFields render.

- [ ] **Step 2: Manual test**

With `vercel dev` running and logged in as admin, open `http://localhost:3000/<slug>/settings` — expected 404 (rewrite comes in Task 7); use `http://localhost:3000/app/settings.html` plus `?` — instead, temporarily verify via the `/users` flow after Task 7. For now run a quick smoke: `node tests/unit.js` (must stay green) and check the browser console on `app/settings.html` shows no syntax errors.

---

### Task 5: Instruments ↔ members mapping UI

**Files:**
- Modify: `app/js/settings.js` (`renderArrMembers`, `_arrCfg` consumers)
- Modify: `app/settings.html` (style additions)

Data shape (JSONB only, no schema change): `arrangementConfig.members[i] = { name, abbr, instruments: ['GUITAR', …], userEmail: 'x@y.z' | undefined }`.

- [ ] **Step 1: Replace `renderArrMembers` in settings.js**

```js
function renderArrMembers(members) {
  var list = document.getElementById('arr-members-list');
  if (!list) return;
  var instruments = (_arrCfg().instruments || []).filter(function(inst) { return inst.key; });
  list.innerHTML = members.map(function(m, i) {
    var chips = instruments.map(function(inst) {
      var on = (m.instruments || []).indexOf(inst.key) !== -1;
      return '<button type="button" class="member-inst-chip' + (on ? ' on' : '') + '" ' +
        'onclick="arrToggleMemberInstrument(' + i + ',\'' + escHtml(inst.key) + '\')">' +
        escHtml(inst.label || inst.key) + '</button>';
    }).join('');
    var accountOpts = '<option value="">— no account —</option>' + _settingsUsers.map(function(u) {
      var sel = m.userEmail === u.email ? ' selected' : '';
      return '<option value="' + escHtml(u.email) + '"' + sel + '>' + escHtml(u.email) + '</option>';
    }).join('');
    return '<div class="arr-member-card">' +
      '<div class="arr-member-row">' +
        '<input class="arr-cfg-input" type="text" value="' + escHtml(m.name || '') + '" placeholder="Name" oninput="arrMemberChange(' + i + ',\'name\',this.value)">' +
        '<input class="arr-cfg-input arr-cfg-abbr" type="text" value="' + escHtml(m.abbr || '') + '" placeholder="Abbr" maxlength="4" title="Abbreviation shown in harmony chips" oninput="arrMemberChange(' + i + ',\'abbr\',this.value)">' +
        '<button class="arr-cfg-remove" onclick="arrRemoveMember(' + i + ')" title="Remove">&#215;</button>' +
      '</div>' +
      '<div class="member-inst-row">' +
        (chips || '<span class="member-inst-empty">No instruments configured yet</span>') +
      '</div>' +
      '<div class="member-account-row">' +
        '<label>Account</label>' +
        '<select class="member-account-select" onchange="arrMemberChange(' + i + ',\'userEmail\',this.value || undefined)">' + accountOpts + '</select>' +
      '</div>' +
    '</div>';
  }).join('');
}

function arrToggleMemberInstrument(i, key) {
  var cfg = _arrCfg();
  var m = cfg.members[i];
  if (!m) return;
  m.instruments = m.instruments || [];
  var idx = m.instruments.indexOf(key);
  if (idx === -1) m.instruments.push(key); else m.instruments.splice(idx, 1);
  if (!_profileCfg.config) _profileCfg.config = {};
  _profileCfg.config.arrangementConfig = cfg;
  renderArrMembers(cfg.members);
}
```

Also: in `renderArrInstruments`'s input handlers nothing changes, but instrument key edits should refresh member chips — at the end of `arrInstChange`, `arrAddInstrument`, and `arrRemoveInstrument` add `renderArrMembers(cfg.members || []);`.

`arrMemberChange` already writes arbitrary fields (`m[field] = value`), so `userEmail` works without changes. Saving stays on the existing "Save arrangement config" button → `saveArrangementConfig()` → `patchConfig({ arrangementConfig })` (JSONB `||` merge on the server preserves other config keys).

- [ ] **Step 2: Add styles to settings.html**

```css
    .arr-member-card { border:1px solid var(--border-color); border-radius:4px; padding:0.5rem 0.6rem; margin-bottom:0.4rem; }
    .member-inst-row { display:flex; flex-wrap:wrap; gap:0.3rem; margin-top:0.45rem; }
    .member-inst-chip { border:1px solid var(--border-color); background:none; border-radius:12px; padding:0.15rem 0.6rem; font-size:0.75rem; font-family:inherit; color:var(--third-color); cursor:pointer; }
    .member-inst-chip.on { background:var(--secondary-color); border-color:var(--secondary-color); color:var(--white); }
    .member-inst-empty { font-size:0.72rem; color:var(--third-color); }
    .member-account-row { display:flex; align-items:center; gap:0.5rem; margin-top:0.45rem; }
    .member-account-row label { font-size:0.65rem; letter-spacing:0.12em; text-transform:uppercase; color:var(--third-color); }
    .member-account-select { padding:0.2rem 0.4rem; border:1px solid var(--border-color); border-radius:3px; font-size:0.78rem; font-family:inherit; background:var(--bg-color); }
```

- [ ] **Step 3: Manual test (after Task 7 routing)**

Toggle instruments on a member, link an account, save, reload — selections persist. Verified in Task 8's checklist.

---

### Task 6: Rebuild `app/profile.html`

**Files:**
- Rewrite: `app/profile.html` (full replacement)

- [ ] **Step 1: Replace the file**

Keep the head block (current lines 1-13). New body + minimal styles:

```html
  <style>
    .profile-wrap { max-width: 460px; margin: 0 auto; padding: 4.5rem 1.25rem 4rem; }
    .profile-section { margin-bottom: 2rem; }
    .profile-section label { display:block; font-size:0.65rem; letter-spacing:0.2em; text-transform:uppercase; color:var(--third-color); margin-bottom:0.4rem; }
    .profile-email { font-size:0.95rem; padding:0.4rem 0; }
    .profile-hint { font-size:0.72rem; color:var(--third-color); margin-top:0.3rem; }
    .profile-section input[type="password"] { width:100%; padding:0.6rem 0.75rem; border:1px solid #ddd; border-radius:4px; font-size:0.95rem; font-family:inherit; color:var(--black); background:var(--white); outline:none; margin-bottom:0.6rem; }
    .profile-section input[type="password"]:focus { border-color:var(--secondary-color); }
    .save-row { display:flex; align-items:center; gap:1rem; margin-top:0.4rem; }
    .save-msg { font-size:0.72rem; color:var(--third-color); min-height:1.2em; }
    .save-msg.ok { color:#4a9a6a; }
    .save-msg.err { color:var(--danger-color); }
  </style>
</head>
<body>
<script src="/app/js/common.js?v=12"></script>

<div class="app-wrap profile-wrap">
  <h1>Profile</h1>

  <div class="profile-section">
    <label>Email</label>
    <div class="profile-email" id="profile-email">—</div>
    <div class="profile-hint">Your login email. Ask a workspace admin to change it.</div>
  </div>

  <div class="profile-section" id="password-section" style="display:none;">
    <label>Change password</label>
    <input type="password" id="pw-current" placeholder="Current password" autocomplete="current-password">
    <input type="password" id="pw-new" placeholder="New password (min. 8 characters)" autocomplete="new-password">
    <input type="password" id="pw-confirm" placeholder="Repeat new password" autocomplete="new-password">
    <div class="save-row">
      <button class="btn active" id="pw-save-btn">Change password</button>
      <span class="save-msg" id="pw-msg"></span>
    </div>
  </div>

  <div class="profile-hint" id="bootstrap-note" style="display:none;">
    You are logged in with the workspace password — personal passwords are managed per account.
  </div>
</div>

<script>
(function () {
  var _slug = '';

  window.onNavAuthEmpty = function() { goToLogin(); };

  initPage(function(cfg) {
    if (requireLogin()) return;
    _slug = cfg.slug;
    document.getElementById('profile-email').textContent =
      sessionStorage.getItem('smartist_admin_email') || '—';

    // Bootstrap (workspace-password) logins have no users row → no personal password.
    var isBootstrap = getAuthRole() === null;
    document.getElementById(isBootstrap ? 'bootstrap-note' : 'password-section').style.display = '';
    if (isBootstrap) return;

    document.getElementById('pw-save-btn').addEventListener('click', changePassword);
  });

  async function changePassword() {
    var cur = document.getElementById('pw-current').value;
    var nw  = document.getElementById('pw-new').value;
    var cf  = document.getElementById('pw-confirm').value;
    var msg = document.getElementById('pw-msg');
    msg.className = 'save-msg';
    if (!cur || !nw)   { msg.textContent = 'Fill in all fields.';            msg.className = 'save-msg err'; return; }
    if (nw.length < 8) { msg.textContent = 'Minimum 8 characters.';          msg.className = 'save-msg err'; return; }
    if (nw !== cf)     { msg.textContent = 'New passwords do not match.';    msg.className = 'save-msg err'; return; }
    var btn = document.getElementById('pw-save-btn');
    btn.disabled = true; msg.textContent = 'Saving…';
    try {
      var r = await apiFetch('/api/' + _slug + '/auth?action=change-password', 'POST',
        { currentPassword: cur, newPassword: nw });
      var data = await r.json();
      if (!r.ok) { msg.textContent = data.error || 'Failed.'; msg.className = 'save-msg err'; return; }
      msg.textContent = 'Password changed.'; msg.className = 'save-msg ok';
      document.getElementById('pw-current').value = '';
      document.getElementById('pw-new').value = '';
      document.getElementById('pw-confirm').value = '';
    } catch (e) {
      if (!String(e.message).includes('Session')) { msg.textContent = 'Connection error.'; msg.className = 'save-msg err'; }
    } finally { btn.disabled = false; }
  }
}());
</script>
</body>
</html>
```

(Check `initPage` in `common.js:700` for the exact callback contract before wiring — the old profile used a hand-rolled `init()`; the users page used `initPage(cb)`. Follow the users-page pattern. Note `<title>Profile</title>` stays.)

- [ ] **Step 2: Manual test**

Open `/<slug>/profile` logged in as a named user: email shows, password change with wrong current → "Current password is incorrect"; with valid input → "Password changed", then re-login with the new password works. As bootstrap admin: password section hidden, note shown.

---

### Task 7: Nav, routing, delete old users page

**Files:**
- Modify: `app/js/common.js:89` (nav link)
- Modify: `vercel.json:39-40`
- Delete: `app/users.html`, `app/js/users.js`

- [ ] **Step 1: Nav link**

In `app/js/common.js` line 89, replace:
```js
              '<a href="' + _base + '/users" class="admin-only">Users</a>' +
```
with:
```js
              '<a href="' + _base + '/settings" class="admin-only">Settings</a>' +
```

- [ ] **Step 2: Rewrites**

In `vercel.json`, replace line 40 and add the settings route so both URLs serve the new page:
```json
    { "source": "/:slug/settings",         "destination": "/app/settings.html" },
    { "source": "/:slug/users",            "destination": "/app/settings.html" },
```

- [ ] **Step 3: Delete old files**

```bash
git rm app/users.html app/js/users.js
```
(Confirm nothing else references them first: `grep -rn "users.html\|js/users.js" app/ api/ vercel.json` — expect only the rewrite just edited. The old profile bootstrap-prompt that linked to `/users` is gone with Task 6.)

- [ ] **Step 4: Restart vercel dev and smoke-test**

`/<slug>/settings` renders the four cards; `/<slug>/users` lands on the same page; the More dropdown shows "Settings" for admins and hides it for members/viewers.

---

### Task 8: Full verification + docs + user checkpoint

**Files:**
- Modify: `CLAUDE.md` (routes table + pages table)

- [ ] **Step 1: Update CLAUDE.md**

In the serverless-functions table row for `api/[artist]/auth.js`, change the Routes cell to:
`POST /api/:artist/auth`; `POST ?action=change-password\|invite\|resend-invite\|accept-invite`; `PUT` (role/email, admin); `POST /api/:artist/request-reset` (via rewrite)
In the Pages table add:
`| /:slug/profile | inline script in profile.html |` and `| /:slug/settings (alias /users) | app/js/settings.js — admin only |`

- [ ] **Step 2: Run the full suites**

```bash
node tests/unit.js
cd tests && ARTIST_PASSWORD=… npm test
```
Expected: all green (the suite creates two `[TEST]` setlists — known/accepted).

- [ ] **Step 3: Manual checklist**

- Admin: More ▾ shows **Settings**; page shows Band / App settings / Members / Instruments cards; photo upload, name save, privacy toggle, column editor, filter editor all work (`invalidateConfigCache()` paths unchanged).
- Members card: invite, resend, revoke, role change, remove, **edit email** (own + others), 409 on duplicate.
- Instruments card: add instrument + techniques, toggle instruments on a member, link a member to an account, save, reload — persists; arrangement page (`/songs` arrangement panel) still reads members/instruments correctly (it reads `name`/`abbr`/`key`/`label`, which are unchanged).
- Member (non-admin) login: no Settings link; `/<slug>/settings` redirects to dashboard; profile page changes password successfully; old password rejected afterwards.
- Bootstrap login: Settings accessible (legacy role `null` = admin), profile shows the bootstrap note.

- [ ] **Step 4: USER VERIFICATION GATE — do not commit**

Pause. Show the user what changed and ask them to verify in the browser. Commit only on their explicit instruction (single commit, e.g. `feat: settings page + slim profile (users page merged)` … ending with the Claude co-author line).
