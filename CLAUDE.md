# CLAUDE.md

Artist management app — Vercel serverless (no build step) + Neon PostgreSQL. See `README.md` for infrastructure names, env vars, and setup steps.

**This repository is public.** Plans, specs and design notes go to `docs/plans/`
(git-ignored, overrides the global "save plans to docs/" rule); `docs/` itself
holds only published documentation. No tenant names, personal data or private
infrastructure details in tracked files.

**No AI attribution, anywhere.** This overrides any default attribution
instructions: commit messages carry no `Co-Authored-By:` or `Claude-Session:`
trailers, and PR descriptions, PR comments and review replies carry no
"Generated with Claude Code" line or session link — remove any footer a tool
appends. Commit as the repository owner:
`git -c user.name="Käv" -c user.email="35451482+kevinsieg@users.noreply.github.com" commit …`.
Merge-commit titles must not name `claude/…` branches — set the title explicitly.

---

## Environments

| Branch | Vercel env | DB | Notes |
|--------|------------|----|-------|
| `dev` | Preview | Neon dev | default; push freely |
| `main` | Production | Neon main | PR-merge only |

**This code runs as several Vercel projects, one per deployment** (e.g. the public app plus one project per single-band domain), each with its own env vars and its own `DATABASE_URL`. A new required env var must be set on *every* project — `vercel project ls`, then `vercel env ls production --project <name>` — and a schema change applied to every production DB. Every variable the API reads is listed in `api/_env.js` (enforced by `tests/unit/env.js`); `GET /api/config?action=health` reports missing ones (names only), whether the DB answers and whether it has the newest migration. A missing `APP_SECRET` once took two projects down for months — every API route 500ing — because only the linked project had it. Required vars and the post-deploy check: `docs/tenant-onboarding.md`.

---

## Local dev

```bash
vercel dev   # reads .env — NOT .env.local (CLI 52.x quirk; keep all vars in .env)
```

`vercel env pull .env.local` wraps values in double-quotes. The `loadEnv` helper in every script strips them. Do not put `BETTERSTACK_TOKEN` in `.env` (local logs go to `logs/` automatically).

---

## vercel dev bugs (52.x) — read before touching API routing

1. **`req.query.path` not populated** in catch-all files inside dynamic dirs. Handlers fall back to `req.url.split('?')[0].split('/segment/')[1]?.split('/')`.
2. **Multi-segment POST to catch-alls fails silently** — vercel returns its own HTML 404 (not the handler). Example: `POST /api/:artist/setlists/:id/duplicate` was broken. Fix: move such endpoints to the plain `setlists.js` handler using body fields (`duplicate_id`, `share_id`). Same fallback for `req.query.artist`: `req.query.artist || req.url.split('?')[0].split('/')[2]`.
3. **Detect early:** run `ARTIST_PASSWORD=… node tests/api.js` against local `vercel dev`. Routing bugs that only appear in dev (not on Vercel) will fail these tests.

---

## Pages

| URL | JS |
|-----|-----|
| `/` | `app/js/home.js` |
| `/dashboard` | `app/js/dashboard.js` |
| `/setlist` | `app/js/setlist.js` |
| `/setlist-history` | `app/js/setlist-history.js` |
| `/songs` | `app/js/songs.js` (init, data, filters, list view) + `songs-table.js` (bulk edit), `songs-panel.js` (side panel), `songs-media.js` (audio/sheet/playback), `songs-lyrics.js` (lyrics + URL preview) — one global scope, loaded in that order with `songs.js` last because it calls `init()`; `tests/songs-split-client.js` executes them together |
| `/pro-import` | `app/js/pro-import.js` |
| `/gigs` | `app/js/gigs.js` |
| `/venues` | `app/js/venues.js` |
| `/organizers` | `app/js/organizers.js` |
| `/hub` | `app/js/hub.js` |
| `/profile` | inline script in `profile.html` — personal (email, change password) |
| `/settings` (alias `/users`) | `app/js/settings.js` — admin only: band, app settings, members, instruments |
| `/stage?id=N` | `app/js/stage.js` — **no `common.js`; no nav** |
| `/admin` | `app/js/admin.js` — **super-admin only** (`SUPER_ADMIN_EMAILS`); cross-tenant usage overview + per-band plan change; standalone, no `common.js`, English-only |

`app/js/common.js` is loaded by every page except `stage.html`. **Do not put `<header>` or `<footer>` in page HTML** — `injectShell()` in `common.js` builds them at script-load time. `stage.js` calls `fetch('/api/config')` directly instead of `loadConfig()` (which lives in `common.js`).

**Key common.js exports:**
- `loadConfig()` — stale-while-revalidate; blocks on first call, cached in `sessionStorage` thereafter
- `invalidateConfigCache()` — call after any `PATCH /api/config` that mutates `artists.config` so the next `loadConfig()` fetches fresh data
- `createSortableList(options)` — reusable column-driven table with sort buttons and filter input. Column shape: `{ field, label, width, sortable, filterable, muted, type, render, actions }`. Multiple instances sharing one filter input register via `filterInputId` (uses `_slFilterRegistry` internally). Returns `{ setData(rows), refresh() }`.

---

## Serverless functions (11 of 12 — Hobby plan limit)

| File | Routes |
|------|--------|
| `api/config.js` | `GET /api/config` (returns `plan`+`usage`); `PATCH /api/config` (update name/config); `POST /api/config` (subscribe/demo/contact); `POST ?action=upgrade|downgrade` (self-serve plan seam — see Plans); `GET ?action=admin-overview` / `POST ?action=admin-set-plan` (super-admin); `GET ?action=google-url\|facebook-url` (OAuth start); `GET ?action=oauth-callback` (via `/auth/callback` rewrite); `GET ?action=photo-url` (presigned upload) |
| `api/[artist]/auth.js` | `POST /api/:artist/auth` (login); `POST ?action=invite\|resend-invite\|accept-invite\|change-password`; `GET` (list users), `PUT` (role only — login email is the cross-workspace identity and is never admin-editable), `DELETE` — admin; `POST /api/:artist/request-reset` (via rewrite) |
| `api/[artist]/gigs.js` | `GET/POST /api/:artist/gigs`; `GET/PUT/DELETE /api/:artist/gigs/:id` and the poster actions (via the `/api/:artist/gigs/:id` → `?id=:id` rewrite — one function for both) |
| `api/[artist]/organizers.js` | `GET/POST /api/:artist/organizers` |
| `api/[artist]/organizers/[...path].js` | `GET/PUT/DELETE /api/:artist/organizers/:id` |
| `api/[artist]/setlists.js` | `GET /api/:artist/setlists`; `POST` — create `{song_ids}`, duplicate `{duplicate_id}`, share `{share_id,email}` |
| `api/[artist]/setlists/[...path].js` | `GET/PUT /api/:artist/setlists/:id`; `GET /api/:artist/setlists/export` (via rewrite) |
| `api/[artist]/songs.js` | `GET/POST/PATCH /api/:artist/songs`; `GET /api/:artist/song-logs` (via rewrite) |
| `api/[artist]/songs/[...path].js` | `DELETE` / `restore` / `setlists` / `gema` / `lyrics` / `lyrics-suggest` / `audio` / `sheet` / `playback` / `gema-import` (internal catch-all segment, via `/api/:artist/gema/import` rewrite) |
| `api/[artist]/venues.js` | `GET/POST /api/:artist/venues`; `PATCH` — bulk edit of the CRM fields (array of `{id, …}`, max 200, only the fields sent are written). `GET` takes `q/status/category/country/has_gigs`, paging (`limit`/`offset`), `sort` (whitelist: name, city, status, category, last_communication, deadline, season, preferred_period) + `dir`, and `letter` (single A–Z, or `#` for non-alphabetic) |
| `api/[artist]/venues/[...path].js` | `GET/PUT/DELETE /api/:artist/venues/:id` |

**Duplicate and share are both `POST /api/:artist/setlists`** with a body field — not separate URL paths. This avoids the vercel dev multi-segment POST bug (see above).

`/api/docs` is a static rewrite to `app/api-docs.html` — uses zero functions.

---

## API helpers (`api/_*.js`)

| Module | Key exports / notes |
|--------|---------------------|
| `_db.js` | `getDb()` singleton, `getArtist(slug)` → null if not found, `insertAuditLog` silently swallows errors by design |
| `_auth.js` | `requireAuth(req, res, slug)` → artist object or writes 401/404 and returns null |
| `_handler.js` | `wrap(handler)` — **required on every handler**; catches unhandled errors → 500 |
| `_validate.js` | returns `null` (missing/empty), validated value, or `false` (invalid) |
| `_email.js` | `sendEmail({to,subject,text?,html?,attachments?})` — swap provider via `PROVIDER` block at top |
| `_pdf.js` | `buildSetlistPdf(setlist, songs, artistName)` → Buffer; `setlistTitle(setlist)` |
| `_r2.js` | `createPresignedUrl`, `deleteFromR2` — swap storage via `STORAGE` block at top |
| `_media.js` | `MEDIA_CONFIGS` + `presignMedia` / `confirmMedia` / `deleteMedia` (shared by the body-dispatched POSTs in `songs.js` and the REST routes, both `member`); `makeMediaFn(config)` wraps them for the catch-all |
| `_env.js` | Every env var the API reads (required / recommended / pairs), `envReport()`, and `SCHEMA_VERSION` — the newest migration id in `schema.sql` |
| `_domain/gema.js` | GEMA CSV parsers and `importWorks` / `importRightholders` — used by the pro-import route and `scripts/import_gema.js` |
| `_lyrics.js` | `suggestLyrics(sql, band, songId, ip)` — lyrics.ovh → lrclib → AI, shared by both lyrics-suggest routes |
| `_ai.js` | `suggestLyricsWithAI(title, artist, opts)` — swap provider via `AI` block at top; `format:'gemini'` default |
| `_logger.js` | `info/warn/error(event, data)` — dev→file, preview→stdout, prod→BetterStack; swap via `TRANSPORT` block |
| `_token.js` | `generateMagicToken(seed, purpose)`, `verifyMagicToken(token, seed, purpose)` — 30-min HMAC, purpose `login`/`reset`/`demo` (a `demo` token is a **member** session). `generateUserToken(id, role, ttl, passwordHash)` embeds a password fingerprint: changing a password revokes older sessions (`passwordMatches`). |
| `_ownership.js` | `ownsSongs/ownsGig/ownsVenue/ownsOrganizer` — **every foreign id from a request body must pass one** (ids are one sequence across tenants); `isOwnMediaUrl` gates R2 deletes |

---

## Code patterns

**Handler skeleton:**
```js
module.exports = wrap(async function handler(req, res) {
  // catch-alls: req.query.artist may be unpopulated in vercel dev
  const slug = req.query.artist || req.url.split('?')[0].split('/')[2];
  const sql  = getDb();
  ...
});
```

**Validation:**
```js
const name = validateStr(rawName, 200);
if (name === false) return res.status(400).json({ error: 'name too long' });
if (!name)          return res.status(400).json({ error: 'name required' });
```

**Mixed GET (public) / PUT (authed) on the same resource — auth-gate first to avoid double `getArtist`:**
```js
let artist;
if (req.method === 'PUT') {
  artist = await requireAuth(req, res, slug);
  if (!artist) return;
} else {
  artist = await getArtist(slug);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
}
```

**Batch inserts (avoid N round-trips):**
```js
await sql`INSERT INTO setlist_songs (setlist_id, song_id, position)
  SELECT * FROM unnest(${ids}::int[], ${songIds}::int[], ${positions}::int[])`;
```

**Driver:** postgres.js (`postgres` npm package). Connects to Neon over the standard wire protocol. `sql.begin(async tx => {...})` is available for transactions. The swap point is `DB.connect` in `api/_db.js` — the rest of the codebase is driver-agnostic.

**Round-trips:** with `prepare: false` (required on Neon's pooler) every query with parameters costs two round-trips, and on the function's single connection `Promise.all` does not overlap them. Save time by writing fewer statements — one CTE (`WITH s AS (INSERT … RETURNING *), l AS (INSERT INTO song_logs …) SELECT …`) instead of insert + log + re-select — not by adding parallelism.

**JSONB:**
- postgres.js serialises JS objects directly — do **not** `JSON.stringify()`.
- Use `extra || ${update.extra}` (JSONB `||`) for partial PATCH; full replacement overwrites keys like `isrc` that the UI doesn't manage.
- Batch writes pass the rows as one JSON parameter: `FROM jsonb_to_recordset(${sql.json(rows)}) AS v(id int, …)` (songs PATCH, GEMA import). Do not pass JS boolean arrays (`${[true]}::bool[]` fails in postgres.js) and do not `JSON.stringify` into a `::jsonb` cast (it is double-encoded).

---

## Database

Tables: `artists`, `songs`, `song_lyrics`, `gigs`, `schema_migrations`, `setlists`, `setlist_songs`, `song_logs`, `venues`, `organizers`, `gema_works`, `gema_rightholders`, `rate_limits`, `subscribers`. Full schema (idempotent) in `scripts/schema.sql`. See `DATABASE.md` for entity diagram and column reference.

Songs use a `deleted` flag (soft-delete; lyrics and arrangements stay, so a restore brings them back). `songs.language` is a column. `songs.extra` JSONB holds arbitrary per-song data (`isrc`, `listenUrl`, `sheetUrl`, `playbackUrl`, `capo`, …).

**Lyrics live in `song_lyrics` (one row per song), never in a song list.** Lists carry `has_lyrics`; the text comes with one song's details (`GET /api/:artist/songs/:id` → `lyrics`), or for the CSV export with `GET /api/:artist/songs?lyrics=1`. The client loads it through `loadSongLyrics(slug, song)` in `common.js`. Shared song queries and the lyrics write are in `api/_domain/songs.js`; the API still accepts `extra.lyrics` / `extra.language` from older clients and moves them to the columns.

`venues` carry CRM contact data: `phone`, `contact_name`, `generic_email`, plus `lat`/`lng` for the map.

`artists.config` JSONB drives the UI: `displayFields`, `filterFields`, `logoUrl`, and `platforms` (streaming/social links managed via `/hub`). Always use JSONB `||` merge (`config || ${update}`) when patching — never overwrite the full object.

**A workspace is private. Anonymous access is opt-in, one surface at a time** — `api/_auth.js` exports the two gates:

| Config key | Default | Opens |
|---|---|---|
| `publicCatalogue` | off | `canBrowseCatalogue()` — the songs list and detail, gig list and detail, and a song's gig appearances. The config payload also ships songs only when this is on. |
| `publicStage` | off | `canOpenStage()` — one setlist by id, one song by id, and that song's arrangements: exactly what a shared `/stage?id=N` link reads. |

Both compare by identity (`=== true`) because `config` is JSONB and a string `"true"` must not pass for the boolean.

**Everything else needs a session, with no setting involved:** venues (rows carry `contact_name`, `phone`, `generic_email` — this is why the old single flag was wrong), organizers, the setlists *list*, song logs and GEMA. Individual setlists are reachable for stage; the list is not, so nothing can be enumerated.

A stage link carries no token and ids are sequential, so with `publicStage` on anyone can walk that band's songs and setlists by id — that is why it is off by default. Anonymous stage responses drop song `comment`s. The `share_token` sketched in `scripts/schema.sql` would replace this with per-link access.

**Song `extra.*Url` values** must be http(s); a URL into our bucket is only accepted when it is the one already stored (uploads go through presign → confirm). New media keys are `audio|sheets|playback/<artist id>/<uuid>-<name>`, and confirm checks that prefix.

Venues and organizers are CRM-style reference tables linked to gigs via `venue_id`/`organizer_id` (FK `ON DELETE RESTRICT`). Both support soft-delete (`deleted` flag).

GEMA: `songs.language` is editable when no GEMA work is linked; the GEMA value shadows it when linked. `extra.isrc` is always read-only (set via script). The `||` PATCH merge preserves both.

Plan state lives in `artists.config`: `plan` (`free`|`pro`), `upgradedAt` (sticky ISO, set on self-serve upgrade — survives downgrade, the demand metric). Storage usage is the `artists.storage_used_bytes BIGINT` column (atomic `+ n` / `GREATEST(0, - n)`; song media only). Future paid keys (`plan_status`, `ls_subscription_id`, `ls_customer_id`, `renews_at`) are reserved for the parked Lemon Squeezy rollout.

---

## Plans, limits, billing & support

Per-band tier system. **`api/_plans.js` is the single source of truth** — edit the two `features` arrays to change what's free vs paid. `getPlan(artist)` is the **only entitlement seam** (reads `artists.config.plan`, unknown/missing → free); real billing later only changes what writes `config.plan`, nothing downstream.

- **Tiers:** Free = 30 MB storage + 100 songs, features `songs/setlists/gigs/hub`. Pro = unlimited + `venues/organizers/pro-import/booking`. Helpers: `hasFeature`, `storageLimitBytes`, `songLimit`, `wouldExceedStorage`, `planSummary`, `requireFeature(res, artist, key)`.
- **Enforcement is server-side** (`402` + machine codes): `requireFeature` → `upgrade_required` (venues/organizers/`gema-import`); storage cap → `storage_limit` (at song-media upload-confirm, `confirmMedia` in `_media.js`, nets the replaced file); song cap → `song_limit` (song create). Client mirrors for UX only.
- **Client gating:** `common.js` adds `.plan-locked` to nav items the plan lacks (`NAV_FEATURE` map) and routes clicks to `/settings#plan`. `loadConfig()` exposes `cfg.plan`/`cfg.usage`.
- **Self-serve upgrade seam:** `POST /api/config?action=upgrade` — today flips `config.plan=pro` + sets `upgradedAt`, returns `{mode:'self-serve'}`; later returns `{mode:'checkout', url}` and lets a webhook set the plan. `settings.js renderPlan` branches on `mode`. `POST ?action=downgrade` sets `plan=free` (keeps `upgradedAt`). `PATCH /api/config` strips `plan`/`upgradedAt` — plan state changes only through these actions or `admin-set-plan`. **This is the swap point for paid billing — no other code changes.**
- **Super-admin:** `/admin` page + `?action=admin-overview`/`admin-set-plan`, gated by `SUPER_ADMIN_EMAILS` (allowlist via global user token, email from DB). Manual grants also via `scripts/plans.js`.
- **Support/donations (live now):** `SUPPORT_LINKS` constant in `footer.js` (provider-agnostic; empty-url entries skipped; optional `img` for official brand buttons loaded as `<img>` — third-party `button.js` is **not** used, CSP blocks it). `renderSupportLinks(el)` renders them in the footer + the Settings donation panel shown after a self-serve upgrade. i18n: `settings.plan.donatePrompt`.
- **One footer everywhere:** `app/js/footer.js` + `app/css/footer.css` (languages left, donations centred, right: smartist.studio · Contact · Impressum; two compact rows under 480px). `/impressum` redirects to smartist.studio/impressum (one legal notice). Pages without a workspace slug (login, root contact) and signup/onboarding show a "smartist studio" wordmark linking to the marketing site. Every page loads `footer.js` before `common.js`; `injectShell()` calls `renderAppFooter()`, standalone pages carry `<footer data-app-footer></footer>`. `footer.css` has variable fallbacks because `demo.html` does not load `app.css`.
- **Docs:** `docs/architecture.md` (why things are built this way), `docs/deployment.md`, `docs/tenant-onboarding.md`, `docs/oauth-setup.md`, `docs/ci-cd.md`.

---

## Client-side rules

- **Every workspace endpoint goes through `apiFetch()`**, never bare `fetch()`. A workspace is private (see the two gates under Database) and answers 401 without a token, and a bare fetch then renders empty state instead of data. Only login, password reset, invite acceptance, OAuth start, `/api/config` and the contact form may use plain `fetch`. `tests/unit/page_scripts.js` enforces this; `stage.js`/`arrangement.js` run without `common.js` and add the header themselves.
- Venues list is **paged** (`limit`/`offset` + A–Z `letter`), not append-on-scroll; sorting is server-side so it covers all rows. Bulk edit (`venues_bulk_edit` in localStorage, desktop only) reloads the table on every sort, page, filter or letter change, so it asks before discarding unsaved rows (`_confirmDiscardBulk`). `PATCH` writes the whole batch in one `unnest` statement inside `sql.begin` and returns `{count, rejected:[{id,error}]}`; rejected rows are marked in the table.

- `loadConfig()` in `common.js` — stale-while-revalidate via `sessionStorage` key `artist_config_cache`. First call blocks on network; subsequent calls in the same tab return immediately.
- After any `PATCH /api/config` that changes `artists.config`, call `invalidateConfigCache()` so the next `loadConfig()` fetches fresh data.
- Auth token: `smartist_token` (`AUTH_TOKEN_KEY` in `common.js`) — in `sessionStorage`, or `localStorage` with "remember me"; `apiFetch()` sends it as `Authorization: Bearer <token>`. `clearToken()` removes both copies and the legacy `setlist_token`. Change-password returns a replacement token (the old one stops verifying) — store it where the old one was.
- **Do not call `loadLogs()` inside `renderTable()`** — `renderTable()` is also called by `discardAll()`. Logs only need refreshing after a real data change.
- Songs table: toolbar is `position:sticky`; `table-wrap` has JS-computed `maxHeight` for independent scroll. `thead th` uses `box-shadow` instead of `border-bottom` to avoid the sticky/border-collapse disappearing-border bug.
- OAuth login: Google/Facebook buttons appear on the login and signup pages only when `cfg.googleLogin`/`cfg.facebookLogin` are true (both variables of a provider set). On success the server redirects to `/login#session=<token>&hint=…&next=…` — a finished session in the fragment, never a query string. `state` is bound to an `oauth_nonce` cookie; Facebook signs into existing accounts only with `FACEBOOK_TRUST_EMAIL=true`. Setup: `docs/oauth-setup.md`.

---

## Dates and numbers

`formatDate(value, style)` and `formatTime(value)` in `common.js` are the only date formatters — no page calls `toLocaleDateString` itself (`tests/unit/page_scripts.js` enforces it). Styles: default `22.01.2026` (de) / `22/01/26` (en, fr), `'short'` without the year, `'long'` with the month spelled out. Values are read with UTC accessors because date columns arrive as UTC midnight. `stage.html` loads no `common.js` and keeps a documented copy (`_stageDate`). ISO strings stay raw in `<input type="date">` values and in the .ics export.

---

## Styling

`app/css/app.css` holds the tokens: `--font-ui` (system sans, interface text) and `--font-mono` (song key, tempo, dates, lyrics, slugs, stage view — anything read as a grid), the type scale (`--text-xs/sm/md/base`), `--radius`/`--radius-sm`, `--control-h` (36px) and `--row-h` (32px). Page-level `<style>` blocks use these tokens rather than their own hex values and pixel sizes. **Bump the `app.css?v=` query on every page when the stylesheet changes** — same rule as `i18n.js?v=`.

---

## Internationalisation (i18n)

The app ships in **English (default), French, German**. `stage.html` and `api-docs.html` are intentionally English-only.

- **`app/js/i18n.js`** — loaded in the `<head>` of every translated page, before any other script (so `window.i18n`/`window.t` exist before `common.js` and page scripts run). UMD-style: pure functions are `module.exports`-ed for Node tests; browser glue runs only when `typeof document !== 'undefined'`. `common.js` *consumes* it — `initPage()` and `home.init()` `await window.i18n.ready` before rendering.
- **Locale files** `app/i18n/{en,fr,de}.json` — flat `key → string`. **English is the source of truth.** All three files must hold an **identical key set** (enforced by `tests/unit/i18n.js` — run `node tests/unit.js`).
- **Conventions:**
  - Static HTML: `data-i18n="key"` (keep English inline as default); attributes: `data-i18n-attr="placeholder:key;aria-label:key2"`. **Never** put `data-i18n` on an element that has child elements — `applyTranslations` sets `textContent` and would delete them; split into child `<span data-i18n>` siblings.
  - JS-generated strings: `t('key', vars)` with `{var}` interpolation. Singular/plural use distinct keys (`x.foo_one`/`x.foo_other`) selected in JS.
  - Array/column `label` fields rendered to users: use `get label() { return t('…'); }` getters (re-evaluate per render).
  - Don't translate: API/DB field names, enum values sent to the API (translate only the visible label), slugs, CSS classes, log/console strings, URLs, data values, musical notation.
- **Shared modules loaded by `stage.html`** (`share-utils.js`, `arrangement.js`) must NOT call bare `t()` — stage has no `i18n.js`. They use a guarded helper (`_shareT`/`_arrT`) that returns an English fallback when `window.t` is absent.
- **Detection/persistence:** `getLocale()` precedence is `localStorage['smartist_lang']` → `navigator.language` → `'en'`. The flag switcher (footer via the shell, plus `/profile`) calls `setLocale()`, which stores the choice and reloads.
- **Performance:** only one locale dictionary is ever loaded; it's primed synchronously from localStorage on repeat visits. **Bump `I18N_VERSION` in `i18n.js` (and the `i18n.js?v=` query on pages) whenever locale strings change**, to bust the localStorage dict cache.
- **Adding a string:** add the key to all three locale files, reference it via `data-i18n`/`t()`, run `node tests/unit.js`. FR/DE were machine-translated as a first pass — flag for native-speaker review before production.

---

## Scripts

All scripts: show DB hostname, require `y` confirmation before connecting. `loadEnv` strips surrounding quotes from values. New scripts use `scripts/_lib.js` (`loadEnv`, `confirmDb`, `connect` — postgres.js, like the API).

**Schema changes:** append a dated block to `scripts/schema.sql` that ends with `INSERT INTO schema_migrations (id) VALUES ('<date>') ON CONFLICT DO NOTHING;`, and set `SCHEMA_VERSION` in `api/_env.js` to that date (a unit test checks they match). No `DO $$` blocks — `apply_schema.js` splits on `;`.

```bash
node scripts/setup.js                                      # first-time: schema + artist row
node scripts/apply_schema.js [--check] [--yes]             # apply schema.sql; --check lists pending migrations
node scripts/seed.js [--force]                             # dev DB test data; --force wipes first
node scripts/import_songs.js --artist <slug> songs.json
node scripts/import_gema.js  --artist <slug> [--ids <csv>] [--info <csv>] [--beteiligte <csv>] [--dry-run]
node scripts/plans.js                                      # list bands: plan, storage used/limit, songs, users
node scripts/plans.js --artist <slug> --plan <free|pro>   # grant/change a band's plan
node scripts/plans.js --recount                           # recompute storage_used_bytes from R2
node scripts/delete_artist.js --artist <slug>             # delete an artist + all its data (asks for the slug)
node scripts/create_user.js --artist <slug> --email <addr> [--role admin|member|viewer]
                                                          # first login account for a band that has none
                                                          # (signup makes a NEW band; invite needs an admin already)
                                                          # USER_PASSWORD=… plus --yes runs it unattended
node scripts/create_user.js --artist <slug> --email <addr> --set-password
                                                          # change an existing account's password (no email needed)
node scripts/demo_reset.js --export                      # snapshot the demo band to scripts/demo_seed.json
node scripts/demo_reset.js [--dry-run] [--yes]            # restore it; runs nightly via .github/workflows/demo-reset.yml
```

`ARTIST_SLUG` env var targets the artist; falls back to the first artist in the DB.

---

## Tests

```bash
node tests/unit.js                        # validate + token helpers; runs in CI
cd tests && ARTIST_PASSWORD=… npm test      # full integration suite against vercel dev (port 3000)
npm run test:dev                          # against Vercel Preview URL
```

Workspaces are private, so every read and write test runs with a session (`ARTIST_PASSWORD` as bearer); without it only the anonymous checks run. Write tests create `[TEST]` rows and delete them again; an interrupted run can leave some behind (see `docs/ci-cd.md`). CI previews sit behind Vercel Deployment Protection — the suite sends `VERCEL_AUTOMATION_BYPASS_SECRET` as `x-vercel-protection-bypass`.
