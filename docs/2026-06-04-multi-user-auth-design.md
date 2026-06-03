# Multi-User Auth — Design Spec
_2026-06-04_

## Scope

Phase 1: email + password login, remember me, per-user roles, admin user management, invite via email.
Phase 2 (out of scope here): passkeys (WebAuthn).

---

## Roles

Three predefined roles, ordered by access level:

| Role | Access |
|------|--------|
| `admin` | Full access + user management (invite, change roles, remove users) |
| `member` | Full app access — songs, setlists, gigs, venues, organizers; no user management. Destructive-delete gating is a future enhancement, not enforced in Phase 1. |
| `viewer` | Read-only, authenticated (like current view mode but with a named account) |

Role enforcement happens at the API layer via `requireRole(req, res, minRole)`. Frontend hides restricted UI elements using a new `.admin-only` CSS class alongside the existing `.auth-only`.

---

## Database

One new table added to `scripts/schema.sql` (idempotent, `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  artist_id         INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  password_hash     TEXT,                 -- NULL until invite accepted
  role              TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('admin', 'member', 'viewer')),
  invite_token_hash TEXT,                 -- SHA256(raw token); NULL after accepted
  invite_expires_at TIMESTAMPTZ,
  invited_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artist_id, email)
);
```

`artists.password_hash` and `ARTIST_ADMIN_EMAIL` are retained for bootstrap mode (see below). No migration removes or alters existing columns.

---

## Token format

`api/_token.js` gains two new exports alongside the existing magic-token functions:

```js
// Signs {userId, role, exp} with APP_SECRET env var (not password_hash).
// ttlMs: 8h (no remember-me) or 30 days (remember-me).
generateUserToken(userId, role, ttlMs) → string

// Returns {userId, role} or null if invalid/expired.
verifyUserToken(token) → {userId, role} | null
```

Signing uses `crypto.createHmac('sha256', process.env.APP_SECRET)` — the existing Node.js `crypto` module, no new dependencies.

`APP_SECRET` is a new required env var (long random string). Added to `.env` locally and Vercel env on both preview and production.

---

## Auth flow

### Login (`POST /api/:artist/auth`)

Request body: `{ email, password, rememberMe }`.

1. Look up user by `(artist_id, email)`.
2. Verify `bcrypt.compare(password, user.password_hash)`.
3. Issue `generateUserToken(user.id, user.role, rememberMe ? 30d : 8h)`.
4. Return `{ ok: true, token, role, email }`.

Client stores token in `localStorage` (remember me) or `sessionStorage` (session only).

### Bootstrap fallback

If the `users` table has **zero rows** for this artist, `requireAuth` falls back to checking the bearer token against `artists.password_hash` (old bcrypt/magic-token check). This preserves existing single-password setups and allows the first admin user to be created from the profile page without locking anyone out.

### `requireAuth` (updated `api/_auth.js`)

1. Extract bearer token from `Authorization` header.
2. Try `verifyUserToken(token)` — if valid, fetch artist by slug, set `req.user = {id, role}`, return artist.
3. If no user token: check if users table is empty for this artist → if so, fall back to old `checkCredentials` and set `req.user = {id: null, role: 'admin'}`.
4. Otherwise 401.

All 12 existing handlers keep their current call signature — `requireAuth` still returns the artist object.

### `requireRole(req, res, minRole)`

New helper in `_auth.js`. Called after `requireAuth` in handlers that need role gating:

```js
if (!requireRole(req, res, 'admin')) return;
```

Role order: `viewer < member < admin`. Bootstrap synthetic admin always passes.

---

## API changes (`api/[artist]/auth.js`)

Stays within the 12-function limit. All new user management actions fold into this file:

| Method + condition | Action |
|--------------------|--------|
| `POST` body has `email` | Login (new) |
| `POST` body has `password` only | Login (legacy bootstrap) |
| `GET` | List users — admin only |
| `POST ?action=invite` | Invite user `{email, role}` — admin only |
| `POST ?action=accept-invite` | Accept invite `{token, password}` — public |
| `POST ?action=resend-invite` | Resend invite `{userId}` — admin only |
| `PUT` | Update user role `{userId, role}` — admin only |
| `DELETE` | Remove user `{userId}` — admin only, cannot remove self |

Invite flow:
1. Admin POSTs `{email, role}` → server creates user row (`password_hash = NULL`), generates a random 32-byte token, stores `SHA256(token)` in `invite_token_hash`, sets `invite_expires_at = now + 7 days`, sends email with link `https://<host>/login?invite=<token>`.
2. Recipient clicks link → login page detects `?invite=` param → shows "Set your password" form.
3. Client POSTs `{token, password}` to `?action=accept-invite` → server verifies hash, sets `password_hash`, clears invite columns, returns a session token → user is logged in.

---

## Frontend changes

### `app/js/home.js` (login page)

New login form (Option B layout — OAuth section always visible if configured, email/password below):
- Email field + password field + show/hide toggle
- Remember me checkbox
- Sign in button
- Forgot password: user enters their email → server looks up the user row by `(artist_id, email)`, generates a magic token keyed to their `password_hash`, sends reset link to that email. Falls back to the old `ARTIST_ADMIN_EMAIL` check in bootstrap mode.
- `?invite=<token>` detection → renders "Set your password" form instead

### `app/js/common.js`

- `AUTH_TOKEN_KEY` stored in `localStorage` (remember me path) or `sessionStorage` (session path). On read, check both: `sessionStorage.getItem(key) || localStorage.getItem(key)`.
- Logout clears both stores.
- New `getAuthRole()` client-side helper: reads the stored token from sessionStorage/localStorage, base64-decodes the payload, returns the `role` string without a server round-trip.
- New `.admin-only` CSS class: hidden unless `app-header--admin` class is on `<header>`. `applyNav()` sets this class when role is `admin`.

### New page: `app/users.html` + `app/js/users.js`

Admin-only page at `/users`. Layout:
- Invite bar: email input + role selector + "Send invite" button.
- Active users list: email, status badge, inline role dropdown (save on change), Remove button.
- Pending invites section: email, "invite sent" badge, role, Resend button.
- Current user row is display-only (no edit, no remove).

Nav link added to `common.js` shell with `.admin-only` class.

### `app/profile.html` / profile page

No structural changes. If `users` table is empty (bootstrap mode), the profile page shows a "Set up multi-user access" prompt linking to `/users`. This is the migration path for existing single-password installs.

---

## New env var

| Var | Purpose |
|-----|---------|
| `APP_SECRET` | HMAC signing key for user tokens. Long random string. Required. |

---

## What does not change

- All 12 existing API handler files are untouched unless they explicitly need role-gating (most don't — member access = full app access for now).
- `artists.password_hash` column stays.
- `ARTIST_ADMIN_EMAIL` stays (used for magic-link reset and bootstrap identity).
- OAuth (Google/Facebook) login flow is unchanged.
- Passkeys: out of scope for this phase.
