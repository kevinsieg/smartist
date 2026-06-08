# Sign-up & Multi-Tenant Migration — Design Spec
_2026-06-08_

## Scope

Introduce self-service sign-up at `smartist.studio/signup` so any musician can create their own artist workspace. Migrate the app from single-tenant (one artist per deployment, hardcoded `ARTIST_SLUG`) to multi-tenant path-based routing (`/:slug/dashboard`). Add a personal `/home` page for users who belong to multiple artist workspaces. Establish a DDD module structure for all new code, with a strangler-fig migration path for existing handlers.

Out of scope: per-song pricing, passkeys, subdomain routing, global song library (Model B), copy-song-across-artists (noted as follow-on).

---

## Architecture

### Layering principle

Three layers. Handlers are thin HTTP controllers — parse, call domain, respond. No business logic in handlers.

```
api/
  _infra/           ← infrastructure: db, email, storage, logger, token, ratelimit, handler
  _domain/          ← business logic: no HTTP, no DOM
  config.js         ← thin controller (function 1 of 12)
  [artist]/
    auth.js         ← thin controller (function 2 of 12)
    ...             ← remaining 10 functions unchanged

app/js/
  services/         ← API client wrappers: no DOM, pure fetch
  signup.js         ← new page controller
  onboarding.js     ← new page controller
  workspaces.js     ← new page controller (workspace picker, URL: /home)
  home.js           ← existing login page controller (unchanged name)
  ...               ← existing page controllers (migrated as touched)
```

Files and directories prefixed `_` are not counted as Vercel serverless functions. `_domain/` and `_infra/` are safe.

### New domain modules

| File | Bounded context |
|------|----------------|
| `api/_domain/registration.js` | Sign-up, onboarding, artist creation |
| `api/_domain/identity.js` | Auth, sessions, tokens, OAuth helpers |
| `api/_domain/artist.js` | Artist config, slug management, workspace listing |
| `api/_domain/members.js` | User management within an artist (invite, roles) — extracted from auth.js as part of this work |

### Strangler fig rule

Every file modified in this feature either (a) extracts its business logic into a domain module, or (b) is explicitly noted as "refactor deferred." No net addition of business logic to handler files.

### New frontend services

| File | Covers |
|------|--------|
| `app/js/services/registration.js` | Sign-up, onboarding API calls |
| `app/js/services/identity.js` | Auth API calls (shared across pages) |
| `app/js/services/artist.js` | Config, slug check, workspace listing |

---

## URL Structure

### Global routes (no artist context)

| URL | Destination | Change |
|-----|-------------|--------|
| `/` | `app/landing.html` | Was login — now marketing page |
| `/signup` | `app/signup.html` | New |
| `/onboarding` | `app/onboarding.html` | New |
| `/home` | `app/workspaces.html` | New — multi-artist workspace picker |
| `/login` | `app/index.html` | Unchanged; artist-aware via `?next=` |
| `/demo`, `/impressum`, `/api/docs` | Unchanged | — |

### Per-artist routes (all new with slug prefix)

| URL | Destination |
|-----|-------------|
| `/:slug/dashboard` | `app/dashboard.html` |
| `/:slug/songs` | `app/songs.html` |
| `/:slug/setlist` | `app/setlist.html` |
| `/:slug/setlist-history` | `app/setlist-history.html` |
| `/:slug/gigs` | `app/gigs.html` |
| `/:slug/venues` | `app/venues.html` |
| `/:slug/organizers` | `app/organizers.html` |
| `/:slug/hub` | `app/hub.html` |
| `/:slug/pro-import` | `app/pro-import.html` |
| `/:slug/stage` | `app/stage.html` |
| `/:slug/users` | `app/users.html` |
| `/:slug/profile` | `app/profile.html` |

`GET /:slug` redirects to `/:slug/dashboard` — defined last in `vercel.json` so it does not shadow global routes.

### vercel.json ordering rule

Global named routes first, then per-artist `/:slug/*` routes, then the `/:slug` catch-redirect last. Vercel processes rewrites in order — the wildcard must not shadow `/signup`, `/login`, `/home`, `/demo`, `/impressum`.

---

## Sign-up Flow

### Email path

1. User visits `/signup`, enters email, submits.
2. `POST /api/config?action=signup-link` (handled by `registration.js` domain):
   - Validate email format.
   - Rate-limit: 3 requests per email per hour (`signup-link:<email>`).
   - Generate `rawToken = crypto.randomBytes(32).toString('hex')`.
   - Store `SHA256(rawToken)` + expiry (30 min) in `subscribers.meta` JSONB via upsert — no schema change.
   - Send email: link to `/onboarding?token=<rawToken>`.
   - Respond `{ ok: true }`.
3. Page shows "Check your email."
4. User clicks link → arrives at `/onboarding?token=xxx`.

### OAuth path

1. User visits `/signup`, clicks Google or Facebook.
2. `GET /api/config?action=google-url&mode=signup` — `_generateState()` encodes `mode: 'signup'` in the state blob.
3. OAuth callback (`?action=oauth-callback`) resolves the email, reads `mode` from verified state:
   - Email already exists in `users` table → find artist(s) for that user → if one artist, issue session token and redirect to `/:slug/dashboard`; if multiple, redirect to `/home` with a session token (graceful: user already has an account).
   - Email is new → generate signup token, store in `subscribers.meta`, redirect to `/onboarding?token=xxx`.
4. Same onboarding page as email path.

### `/onboarding` page

The page handles two entry modes:

**Sign-up mode** (new user, arrives with `?token=`): token verification gates the form.
**Add-artist mode** (authenticated user adding a second workspace, arrives from `/home`): active session token gates the form instead. No `?token=` in URL; page reads the stored auth token from localStorage/sessionStorage and calls `GET /api/config?action=my-artists` to confirm they are authenticated. If neither token nor session is present, redirect to `/signup`.

1. On load: if `?token=` present → `POST /api/config?action=verify-signup-token` with `{ token }`. Returns `{ ok: true, email }` or `{ error: ... }`. On error: show "Link expired" with link back to `/signup`. If no `?token=` → check stored auth token; if invalid/absent → redirect to `/signup`.

2. Form: band name (required) + slug (auto-generated kebab-case from band name, editable).
3. Slug field: debounced live check `GET /api/config?action=check-slug&slug=xxx` → `{ available }`. Submit blocked while unavailable.
4. Submit: `POST /api/config?action=signup` with `{ token, name, slug }`.
5. Server (`registration.js` domain):
   - Re-verify token.
   - Validate slug: lowercase alphanumeric + hyphens, 3–50 chars, unique in `artists`.
   - `INSERT INTO artists (slug, name, config) VALUES (...)`.
   - `INSERT INTO users (artist_id, email, role) VALUES (..., 'admin')`.
   - Clear signup token from `subscribers.meta`.
   - Issue `generateUserToken(userId, 'admin', TTL_8H)`.
   - Return `{ ok, token, slug, role, email }`.
6. Client stores token, redirects to `/:slug/dashboard`.

### Edge cases

| Case | Behaviour |
|------|-----------|
| Token expired | Error page with "Request a new link →  /signup" |
| Email submitted twice | Second call upserts token — old link stops working |
| Slug taken (at submit) | 409 response, form re-enables with error on slug field |
| OAuth email matches existing user | Sign in directly, skip onboarding |
| User navigates back to `/onboarding` after account created | Token cleared → "Link expired" |

---

## API Changes (`api/config.js`)

All sign-up actions fold into `api/config.js` to stay within the 12-function limit. The handler delegates everything to domain modules — it does no business logic itself.

### New POST actions

| Action | Domain module | What it does |
|--------|--------------|--------------|
| `signup-link` | `registration.js` | Validate email, rate-limit, store token in `subscribers.meta`, send email |
| `verify-signup-token` | `registration.js` | Verify token hash + expiry, return email |
| `signup` | `registration.js` | Create artist + admin user, issue session token |

### New GET actions

| Action | Domain module | What it does |
|--------|--------------|--------------|
| `check-slug` | `artist.js` | Check slug uniqueness in `artists` table. Rate-limited. Returns `{ available }` |
| `my-artists` | `artist.js` | Auth required (`requireAuth` called before domain call). Returns `[{ slug, name, role }]` for all artist workspaces the token user belongs to |

### Changes to existing actions

`GET /api/config` — adds `?slug=` query param. Falls back to `ARTIST_SLUG` env var when absent (single-tenant backward compat). One-line change in handler; slug resolution extracted to `artist.js`.

`GET ?action=google-url` / `GET ?action=facebook-url` — accept `?mode=signup|login`, pass through into `_generateState()`. Default `mode: 'login'`.

`GET ?action=oauth-callback` — after email resolved, checks `mode` in verified state. Multi-tenant path: look up user across all artists; if found, sign in. Sign-up path: generate token, redirect to onboarding. Single-tenant fallback (`ARTIST_ADMIN_EMAIL` check) retained when `mode: 'login'` and no multi-tenant user found.

### `api/_domain/registration.js` interface

```js
createSignupToken(email, sql)          // → rawToken
verifySignupToken(rawToken, sql)       // → { email } | null
createArtistAndAdmin(name, slug, email, sql) // → { artistId, userId }
clearSignupToken(email, sql)           // → void
```

### `api/_domain/artist.js` interface

```js
resolveArtist(slugOrEnvFallback, sql)  // → artist | null  (replaces ARTIST_SLUG usage)
isSlugAvailable(slug, sql)             // → boolean
getArtistsForUser(userId, sql)         // → [{ slug, name, role }]
```

### `api/_domain/identity.js` interface

```js
resolveOAuthEmail(provider, code, redirectUri)         // → email | null
generateState(provider, mode)                          // → stateString
verifyState(state)                                     // → { provider, mode } | null
```

---

## Frontend Migration

### `common.js`

Three targeted changes:

1. Slug from URL path (one constant, derived once):
   ```js
   const _artistSlug = window.location.pathname.split('/').filter(Boolean)[0] || '';
   ```

2. `loadConfig()` passes slug; cache key is slug-scoped:
   ```js
   const r = await fetch(_artistSlug ? `/api/config?slug=${_artistSlug}` : '/api/config');
   // cache key: 'artist_config_cache_' + (_artistSlug || 'default')
   ```

3. `applyNav()` / `navigate()` — internal links prefixed with `/${_artistSlug}`. Nav gains a "Switch workspace" link to `/home` (hidden when user belongs to only one artist — determined from token payload or a lazy `my-artists` fetch).

### `app/js/home.js` (login page, existing)

Slug detection from `?next=` param:
```js
const next = new URLSearchParams(window.location.search).get('next') || '';
const slugFromNext = next.split('/').filter(Boolean)[0] || '';
```
Used for `POST /api/:slug/auth`. If no slug present and no `ARTIST_SLUG` env var, redirect to `/signup`.

Post-login redirect: uses `next` param if present, otherwise `/${slug}/dashboard`.

OAuth callback redirect changes from `/?magic=` to `/${slug}/dashboard#magic=`.

### `app/js/stage.js`

Single-line addition: extract slug from path before calling `/api/config`:
```js
const _stageSlug = window.location.pathname.split('/').filter(Boolean)[0] || '';
```

### `vercel.json`

Route ordering (abbreviated):
```json
{ "source": "/", "destination": "/app/landing.html" },
{ "source": "/signup", "destination": "/app/signup.html" },
{ "source": "/onboarding", "destination": "/app/onboarding.html" },
{ "source": "/home", "destination": "/app/workspaces.html" },
{ "source": "/login", "destination": "/app/index.html" },
{ "source": "/demo", "destination": "/app/demo.html" },
{ "source": "/impressum", "destination": "/app/impressum.html" },
{ "source": "/api/docs", "destination": "/app/api-docs.html" },
... all /api/:artist/* rewrites unchanged ...
{ "source": "/:slug/dashboard", "destination": "/app/dashboard.html" },
{ "source": "/:slug/songs", "destination": "/app/songs.html" },
... remaining per-artist pages ...
{ "source": "/:slug", "destination": "/:slug/dashboard" }
```

---

## Multi-Artist Workspace Model

### Data model

No schema changes. The `users` table already has `(artist_id, email)` as unique, supporting many-to-many user↔artist. A new user created via sign-up gets one `users` row (role `admin`) for their first artist. They can be invited into additional artist workspaces by other admins — existing invite flow unchanged.

### `/home` page (`app/workspaces.html`)

Shows all artist workspaces the logged-in user belongs to. Populated by `GET /api/config?action=my-artists` using the stored auth token. Each workspace card shows artist name, user's role, and links to `/:slug/dashboard`. A "Create new artist" button links to `/onboarding` (add-artist mode — session token replaces signup token, see onboarding dual-mode above).

### Post-login routing

| User state | Redirect |
|------------|---------|
| 0 artists | `/onboarding` |
| 1 artist | `/:slug/dashboard` |
| 2+ artists | `/home` |

This logic lives in `app/js/services/identity.js` and is shared between `home.js` (login page) and `onboarding.js`.

### Nav workspace switcher

"Switch workspace" link in the nav bar → `/home`. Visible only when `my-artists` returns more than one workspace. The link is added by `applyNav()` in `common.js`; the `my-artists` fetch is lazy (on first nav render) and cached in `sessionStorage`.

### Copy song (follow-on)

The workspace model means songs are per-artist. A "Copy to another project" action on the songs page (`POST /api/:artist/songs` with `{ copy_from_artist, song_id }`) is the practical workaround for covers played across multiple bands. Not in scope for this feature — noted here for planning.

---

## New Files Summary

| File | Type | Purpose |
|------|------|---------|
| `api/_domain/registration.js` | Domain | Sign-up business logic |
| `api/_domain/identity.js` | Domain | Auth, tokens, OAuth helpers (extracted from config.js) |
| `api/_domain/artist.js` | Domain | Slug resolution, workspace listing, config |
| `api/_domain/members.js` | Domain | User management (extracted from auth.js) |
| `app/signup.html` + `app/js/signup.js` | Frontend | Sign-up page |
| `app/onboarding.html` + `app/js/onboarding.js` | Frontend | Band setup page (dual-mode: signup token or session) |
| `app/workspaces.html` + `app/js/workspaces.js` | Frontend | Multi-artist workspace picker (URL: `/home`) |
| `app/js/services/registration.js` | Service | Sign-up API calls |
| `app/js/services/identity.js` | Service | Auth API calls |
| `app/js/services/artist.js` | Service | Config/workspace API calls |

Note: the existing login page is `app/js/home.js`. The new workspace home is `app/js/home_workspace.js` to avoid a filename collision.

---

## Modified Files Summary

| File | What changes |
|------|-------------|
| `api/config.js` | New actions delegating to domain modules; `GET` adds `?slug=` param |
| `api/[artist]/auth.js` | Delegates members logic to `_domain/members.js`; post-login returns artist list |
| `app/js/common.js` | Slug from path, `loadConfig()` slug param, nav update |
| `app/js/home.js` | Slug from `?next=`, post-login routing, OAuth redirect fix |
| `app/js/stage.js` | One-line slug extraction |
| `vercel.json` | Root → landing, new page routes, all app routes get `/:slug/` prefix |

---

## What Does Not Change

- All 12 existing API handler files stay as functions — no new files in function positions.
- `artists` and `users` table schema unchanged.
- Single-tenant deploys (`ARTIST_SLUG` set) keep working with zero behaviour change.
- Existing invite flow, role management, password reset — unchanged.
- OAuth credentials and callback URL — unchanged.
