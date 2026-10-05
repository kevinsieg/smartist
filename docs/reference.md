# Code reference

Where things live and how they are wired: pages, API routes, helpers, the
database rules, plans, client conventions, i18n and the scripts. The rules an
agent or contributor must not break are in [AGENTS.md](../AGENTS.md); the reasons
behind the design are in [architecture.md](architecture.md); tables and columns
in [DATABASE.md](../DATABASE.md).

## Pages

| URL | JS |
|-----|-----|
| `/` | `app/js/home.js` |
| `/dashboard` | `app/js/dashboard.js` |
| `/setlist` | `setlist-generator.js` (generator, saving a set) + `setlist-history-tab.js` (History tab) + `setlist.js` (state, `init()`, tab switch — loaded last) |
| `/setlist-history` | a redirect in `vercel.json` to `/setlist?view=history` (the setlist page's history tab) |
| `/songs` | `app/js/songs.js` (init, data, filters, list view) + `songs-table.js` (bulk edit), `songs-panel.js` (side panel), `songs-media.js` (audio/sheet/playback), `songs-lyrics.js` (lyrics + URL preview) — one global scope, loaded in that order with `songs.js` last because it calls `init()`; `tests/songs-split-client.js` executes them together |
| `/pro-import` | `app/js/pro-import.js` |
| `/song-import` | `app/js/song-import.js` — CSV song import (template, preview, fixes, import); reached from the songs page's share menu. `SI_COLUMNS` mirrors `COLUMNS` in `_domain/song_import.js` (checked by `tests/unit/song_import.js`) |
| `/gigs` | `app/js/gigs.js` |
| `/venues` | `app/js/venues.js` |
| `/organizers` | `app/js/organizers.js` |
| `/hub` | `app/js/hub.js` |
| `/profile` | `app/js/profile.js` — personal (email, change password) |
| `/settings` | `app/js/settings.js` — admin only: band, app settings, members, instruments |
| `/stage?id=N` | `app/js/stage.js` — **`core.js` only; no nav**. Keeps the screen awake (Wake Lock) while visible; ←/→ (and page-turner pedals) go to the previous/next song, Escape closes the share menu and dialogs |
| `/admin` | `app/js/admin.js` — **super-admin only** (`SUPER_ADMIN_EMAILS`); cross-tenant usage overview + per-band plan change; standalone, none of the shared scripts, English-only |
| `/signup`, `/onboarding` | `app/js/signup.js`, `app/js/onboarding.js` — new account, then new band |
| `/workspaces` | `app/js/workspaces.js` — the signed-in user's bands |
| `/contact`, `/confirm-email`, `/demo` | `app/js/contact.js`, `app/js/confirm-email.js`, `app/js/demo.js` |

Every app page loads the four shared scripts in this order, after `footer.js`: `core.js` (escaping, `safeUrl`, `formatDate`/`formatTime`, `formatLength`, `songFieldHidden` — no session, no DOM shell), `session.js` (slug, token, `apiFetch`, `loadConfig`), `ui.js` (lists, typeahead, modals, `withBusy`, hard delete) and `shell.js` (header/nav, auth menu, `initPage`, SPA `navigate()`; its IIFEs run at load, so it comes last). SPA navigation keeps these four loaded and re-runs only page scripts. `stage.html` loads `core.js` only. **Do not put `<header>` or `<footer>` in page HTML** — `injectShell()` in `shell.js` builds them at script-load time. `stage.js` calls `fetch('/api/config')` directly instead of `loadConfig()`. Bump the `?v=` of all four together (`tests/unit/asset_versions.js`).

**Key shared-script exports:**
- `loadConfig()` — stale-while-revalidate; blocks on first call, cached in `sessionStorage` thereafter
- `invalidateConfigCache()` — call after any `PATCH /api/config` that mutates `artists.config` so the next `loadConfig()` fetches fresh data
- `announce(msg)` (`ui.js`) — polite screen-reader message for a change with no focus of its own (a song moved or removed); keep focus on the control the user used after re-rendering a list
- `createSortableList(options)` — reusable column-driven table with sort buttons and filter input. Column shape: `{ field, label, width, sortable, filterable, muted, type, render, actions }`. Multiple instances sharing one filter input register via `filterInputId` (uses `_slFilterRegistry` internally). Returns `{ setData(rows), refresh() }`.

---

## API handlers

One serverless function, `api/index.js`, sends every `/api/*` path to a handler through its route table (`tests/unit/router.js` pins each path).

| File | Routes |
|------|--------|
| `api/_config.js` | `GET /api/config` (returns `plan`+`usage`); `PATCH /api/config` (update name/config); `GET ?action=health`; and the account routes, each a line in `api/index.js` that sets `action`: `/api/login`, `/api/auth/*` (sign-in links, OAuth, reset, workspaces, logout everywhere, account deletion), `/api/signup*`, `/api/admin/*` (super-admin), `/api/config/upgrade\|downgrade` (plan seam — see Plans), `/api/config/photo-url\|favicon-url` (presigned upload), `/api/contact`, `/api/subscribe`. `/auth/callback` is the OAuth return. Actions never come from the body |
| `api/_band/members.js` | Who may call what, then `_domain/members.js`: `POST /members/accept-invite\|confirm-email-change` (public, the email links), `/members/change-password\|request-email-change` (own account), `/members/invite\|resend-invite`, `GET` (list users), `PUT` (role only — login email is the cross-workspace identity and is never admin-editable), `DELETE` — admin. Signing in and password reset are root actions in `api/_config.js` (`_domain/login.js`, `_domain/reset.js`) |
| `api/_band/gigs.js` | `GET/POST /api/:artist/gigs`; `GET/PUT/DELETE /api/:artist/gigs/:id`; `POST …/:id/poster-url` (presigned upload), `PUT|DELETE …/:id/poster` |
| `api/_band/organizers.js` | `GET/POST /api/:artist/organizers` |
| `api/_band/organizers/item.js` | `GET/PUT/DELETE /api/:artist/organizers/:id` |
| `api/_band/setlists.js` | `GET /api/:artist/setlists`; `POST` — create `{song_ids}` |
| `api/_band/setlists/item.js` | `GET/PUT/DELETE /api/:artist/setlists/:id`; `POST …/:id/duplicate`, `POST …/:id/share` `{email}` |
| `api/_band/export.js` | `GET /api/:artist/export` — every table of the band as a ZIP of CSVs |
| `api/_band/songs.js` | `GET/POST/PATCH /api/:artist/songs`; `GET /api/:artist/song-logs`; `POST /songs/import` — CSV import (`_domain/song_import.js`) |
| `api/_band/songs/item.js` | `GET /songs/:id` (details incl. lyrics + arrangements); `DELETE` / `restore` / `setlists` / `gema` / `audio` / `sheet` / `playback`; `arrangements` (GET/POST, `/:arrId` PUT/DELETE, `/:arrId/activate`); `lyrics` (PUT/DELETE, `/lyrics/suggest` POST) |
| `api/_band/gema.js` | `POST /api/:artist/gema/import` — one GEMA CSV (`_domain/gema.js`), Pro |
| `api/_band/venues.js` | `GET/POST /api/:artist/venues`; `PATCH` — bulk edit of the CRM fields (array of `{id, …}`, max 200, only the fields sent are written). `GET` takes `q/status/category/country`, paging (`limit`/`offset`), `sort` (whitelist: name, city, status, category, last_communication, deadline, season, preferred_period) + `dir`, and `letter` (single A–Z, or `#` for non-alphabetic) |
| `api/_band/venues/item.js` | `GET/PUT/DELETE /api/:artist/venues/:id` |
| `api/_band/record_item.js` | the shared GET/PUT/DELETE item handler behind `organizers/item.js` and `venues/item.js` (one table spec each) |

`/api/docs` is a static rewrite to `app/api-docs.html` in `vercel.json`. It renders `openapi.json`, which is written by hand: a new route or method goes into it too, or `tests/unit/openapi.js` fails.

---

## API helpers (`api/_*.js`)

| Module | Key exports / notes |
|--------|---------------------|
| `_db.js` | `getDb()` singleton, `getArtist(slug)` → null if not found, `insertAuditLog` silently swallows errors by design; `trimSongLogs` keeps each song's newest 20 history entries |
| `_auth.js` | `requireAuth(req, res, slug)` → artist object or writes 401/404 and returns null |
| `_session.js` | `bearerToken(headers)`, `sessionAccount(sql, headers, columns)` — the account behind a session, for routes about a person rather than a band (workspace list, account deletion, log out everywhere, a second workspace) |
| `_handler.js` | `wrap(handler)` — **required on every handler**; catches unhandled errors → 500; logs the body size, `large_response` warning over 2 MB |
| `_validate.js` | returns `null` (missing/empty), validated value, or `false` (invalid) |
| `_email.js` | `sendEmail({to,subject,text?,html?,attachments?})` — swap provider via `PROVIDER` block at top |
| `_pdf.js` | `buildSetlistPdf(setlist, songs, artistName)` → Buffer; `setlistTitle(setlist)` |
| `_r2.js` | `createPresignedUrl` (`{ pending: true }` uploads under `pending/`), `promoteUpload` (the confirm step: moves it to its key), `deleteFromR2` — swap storage via `STORAGE` block at top |
| `_media.js` | `MEDIA_CONFIGS` + `presignMedia` / `confirmMedia` / `deleteMedia` ; `makeMediaFn(config)` serves them as POST / PUT / DELETE on `/songs/:id/:type` (`member`) |
| `_env.js` | Every env var the API reads (required / recommended / pairs), `envReport()`, and `SCHEMA_VERSION` — the newest migration id in `schema.sql` |
| `_domain/song_import.js` | CSV song import: `parseSongCsv` (`,` `;` or tab, quoted line breaks, header aliases in EN/FR/DE), `checkRows` (same rules as a song created by hand; duplicate = same title ignoring case and spacing, in the band's live songs or an earlier row), `songImport` — `{csv}` or `{rows}` is checked only; `{rows, commit: true}` writes every row not skipped in one statement, or answers 422 while any row has an error or an unresolved duplicate, and 402 past the plan's song limit |
| `_domain/gema.js` | GEMA CSV parsers and `importWorks` / `importRightholders` — used by the pro-import route and `scripts/import_gema.js` |
| `_lyrics.js` | `suggestLyrics(sql, band, songId, ip)` — lyrics.ovh → lrclib → AI, shared by both lyrics-suggest routes |
| `_ai.js` | `suggestLyricsWithAI(title, artist, opts)` — swap provider via `AI` block at top; `format:'gemini'` default |
| `_logger.js` | `info/warn/error(event, data)` — dev→file, preview→stdout, prod→BetterStack, one send per request after the response (`waitUntil` in `_handler.js`), lines buffered per request; swap via `TRANSPORT` block |
| `_token.js` | `generateMagicToken(seed, purpose)`, `verifyMagicToken(token, seed, purpose)` — 30-min HMAC, purpose `login`/`reset`/`demo`. A `login` link signs in once (`magicLogin` claims a `magic-used:` key); a `reset` link dies with the password it changes; the `demo` link is shared and reusable (a `demo` token is a **member** session, signed with `demoSeed(artistId)`). There is no band password: every session is a named user (or the demo gate). `generateUserToken(id, role, ttl, passwordHash)` embeds a password fingerprint and the issue time: changing a password, or `users.sessions_valid_after` ("log out everywhere", `_domain/login.js` `logoutEverywhere`), revokes older sessions (`sessionValid`). |
| `_ownership.js` | `ownsRefs` — **every foreign id from a request body must pass it** (ids are one sequence across tenants); songs, gig, venue and organizer in one statement; `isOwnMediaUrl` gates R2 deletes |
| `_domain/gigs.js` | `removeGigFiles` — a band's gig posters out of the bucket, shared by the gig delete and the venue/organizer deletes that take gigs with them |
| `_domain/http.js` | the only req/res adapter (`handle`, `reply`, `ok`, `fail`) and `MSG`, the shared error texts |

---

## Code patterns

**Handler skeleton:**
```js
module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);   // req.query.artist, set by the router
  const [id, action] = req.query.path || [];   // item handlers: segments after the resource
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

**Errors** answer `{ error }`, a readable sentence; when the client needs to branch on it, also `code`, a stable machine string (`upgrade_required`, `song_limit`, `storage_limit`, the CSV import codes). Clients read `code || error`. Shared texts live in `MSG` (`api/_domain/http.js`).

**Mixed GET (public) / PUT (authed) on the same resource — auth-gate first to avoid double `getArtist`:**
```js
let artist;
if (req.method === 'PUT') {
  artist = await requireAuth(req, res, slug);
  if (!artist) return;
} else {
  artist = await getArtist(slug);
  if (!artist) return res.status(404).json({ error: MSG.artistNotFound });
}
```

**Batch inserts (avoid N round-trips):**
```js
await sql`INSERT INTO setlist_songs (setlist_id, song_id, position)
  SELECT * FROM unnest(${ids}::int[], ${songIds}::int[], ${positions}::int[])`;
```

**Driver:** postgres.js (`postgres` npm package). Connects to Neon over the standard wire protocol. `sql.begin(async tx => {...})` is available for transactions. The swap point is `DB.connect` in `api/_db.js` — the rest of the codebase is driver-agnostic.

**Round-trips:** with `prepare: false` (required on Neon's pooler) every query with parameters costs two round-trips, and the instance's few connections (`max: 4`) are shared by every request it serves at once. Save time by writing fewer statements — one CTE (`WITH s AS (INSERT … RETURNING *), l AS (INSERT INTO song_logs …) SELECT …`) instead of insert + log + re-select — not by adding parallelism.

**JSONB:**
- postgres.js serialises JS objects directly — do **not** `JSON.stringify()`.
- Use `extra || ${update.extra}` (JSONB `||`) for partial PATCH; full replacement overwrites keys like `isrc` that the UI doesn't manage.
- Batch writes pass the rows as one JSON parameter: `FROM jsonb_to_recordset(${sql.json(rows)}) AS v(id int, …)` (songs PATCH, GEMA import). Do not pass JS boolean arrays (`${[true]}::bool[]` fails in postgres.js) and do not `JSON.stringify` into a `::jsonb` cast (it is double-encoded).

---

## Database

Tables: `artists`, `songs`, `song_lyrics`, `gigs`, `schema_migrations`, `setlists`, `setlist_songs`, `song_logs`, `venues`, `organizers`, `gema_works`, `gema_rightholders`, `rate_limits`, `subscribers`. Full schema (idempotent) in `scripts/schema.sql`. See `DATABASE.md` for entity diagram and column reference.

Songs use a `deleted` flag (soft-delete; lyrics and arrangements stay, so a restore brings them back). `songs.language` is a column. `songs.extra` JSONB holds arbitrary per-song data (`isrc`, `listenUrl`, `sheetUrl`, `playbackUrl`, `capo`, …).

`songs.tags` (text[]) holds free-form theme tags, several per song. `cleanTags` (`api/_song_values.js`) normalises them on `POST`/`PATCH /songs`: trimmed, deduped case-insensitively, max 10 of max 50 chars, and a tag in a new casing takes the band's existing spelling; an update that omits `tags` keeps them. Client helpers in `core.js`: `songTags`, `bandTags`, `orderByFirstTag`, `tagGroupStarts`. The songs page filters by tags with a multi-select chips filter (`FILTER_TYPES.CHIPS` with `multi: true` in `list-view.js`); the setlist generator filters by tag and can group a generated set by each song's first tag, with headings in the result and the print — headings are not saved with the setlist.

**Lyrics live in `song_lyrics` (one row per song), never in a song list.** Lists carry `has_lyrics`; the text comes with one song's details (`GET /api/:artist/songs/:id` → `lyrics`), or for the CSV export with `GET /api/:artist/songs?lyrics=1`. The client loads it through `loadSongLyrics(slug, song)` in `session.js`. Shared song queries and the lyrics write are in `api/_domain/songs.js`; a song write with `lyrics` or `language` inside `extra` is refused (400, or a rejected row in a bulk `PATCH`).

`venues` carry CRM contact data: `phone`, `contact_name`, `generic_email`, plus `lat`/`lng` for the map.

`artists.config` JSONB drives the UI: `displayFields`, `filterFields`, `logoUrl`, and `platforms` (streaming/social links managed via `/hub`). Always use JSONB `||` merge (`config || ${update}`) when patching — never overwrite the full object.

**A workspace is private. Anonymous access is opt-in, one surface at a time** — `api/_auth.js` exports the two gates:

| Config key | Default | Opens |
|---|---|---|
| `publicCatalogue` | off | `canBrowseCatalogue()` — the songs list and detail, gig list and detail, and a song's gig appearances. The config payload also ships songs only when this is on. |
| `publicStage` | off | `canOpenStage()` — one setlist by id, one song by id, and that song's arrangements: exactly what a shared `/stage?id=N` link reads. |

Both compare by identity (`=== true`) because `config` is JSONB and a string `"true"` must not pass for the boolean.

**Everything else needs a session, with no setting involved:** venues (rows carry `contact_name`, `phone`, `generic_email` — this is why the old single flag was wrong), organizers, the setlists *list*, song logs and GEMA. Individual setlists are reachable for stage; the list is not, so nothing can be enumerated.

A stage link carries no token and ids are sequential, so with `publicStage` on anyone can walk that band's songs and setlists by id — that is why it is off by default. Every anonymous song read (catalogue list, `/api/config`, one song, a stage setlist) goes through `publicSong()` (`api/_domain/songs.js`), which drops `comment`. The `share_token` sketched in `scripts/schema.sql` would replace this with per-link access.

**Abuse limits** (`api/_ratelimit.js`): failed password sign-ins lock an address for 15 minutes after 10 from one IP, or 100 from all IPs together (`countLoginFailure`, read in `passwordLogin`'s first statement); the address-wide lock skips IPs the address signed in from in the last 30 days (`loginOkKey`), so a stranger cannot lock the owner out from their own network. The keys join address and IP with a space, and `passwordLogin` refuses an address that `validateEmail` rejects before counting anything, so no address can name another person's key. Mail to an address the caller chooses (invites, setlist shares) is capped per band and IP at the call site, and by `outboundMailLimited` per sender address and overall per day. Presigned uploads are capped per band per hour and per day, and per person (the session's address) per day across all their bands; all bands together past a daily count only raise an alarm (`presignLimited`, one statement via `countInWindows`) — storage is only counted on confirm. AI lyrics suggestions are capped per band and per person per day; the deployment-wide count raises an alarm, with a hard cost ceiling far above it (`api/_lyrics.js`).

**Free-form JSON** is capped by serialized size: song `extra` 32 KB per request, venue/organizer `social_links` and `extra` 16 KB (`F.object({ maxBytes })`), arrangement `rows` 128 KB. Anonymous `GET /api/config` carries only `plan.features` (the nav needs them), no limits or `usage`. A malformed `%` escape in an `/api` path answers 400.

**Song `extra.*Url` values** must be http(s); a URL into our bucket is only accepted when it is the one already stored (uploads go through presign → confirm). New media keys are `audio|sheets|playback/<artist id>/<uuid>-<name>`, and confirm checks that prefix. Every key check also refuses dot segments, empty segments and escaped slashes (`unsafeKey`, `api/_validate.js`), since the checks are prefixes. The songs page frames a sheet without a sandbox only when it is a PDF in our bucket (`mediaBase` in `/api/config`).

**Login email changes** refuse an address that already has an account anywhere (at confirm): memberships join on email, so the change would merge two people. The request is stored and counted against the sender's daily mail cap the same way for a taken and a free address, so neither the reply nor the export tells which addresses have an account; a taken address gets a notice instead of a link. A password change or "log out everywhere" also ends pending email-change and deletion links. **`apiFetch`** only sends the session to this site's `/api/`; `navigate()` only loads this site's pages; the workspace slug is read from the path only when it is lowercase letters, digits, `-` and `_`.

Venues and organizers are CRM-style reference tables linked to gigs via `venue_id`/`organizer_id` (FK `ON DELETE RESTRICT`). Both support soft-delete (`deleted` flag).

GEMA: `songs.language` is editable when no GEMA work is linked; the GEMA value shadows it when linked. `extra.isrc` is always read-only (set via script). The `||` PATCH merge preserves both.

Plan state lives in `artists.config`: `plan` (`free`|`pro`), `upgradedAt` (sticky ISO, set on self-serve upgrade — survives downgrade, the demand metric). Storage usage is the `artists.storage_used_bytes BIGINT` column (atomic `+ n` / `GREATEST(0, - n)`; song media only). Future paid keys (`plan_status`, `ls_subscription_id`, `ls_customer_id`, `renews_at`) are reserved for the parked Lemon Squeezy rollout.

---

## Plans, limits, billing & support

Per-band tier system. **`api/_plans.js` is the single source of truth** — edit the two `features` arrays to change what's free vs paid. `getPlan(artist)` is the **only entitlement seam** (reads `artists.config.plan`, unknown/missing → free); real billing later only changes what writes `config.plan`, nothing downstream.

- **Tiers:** Free = 30 MB storage + 100 songs, features `songs/setlists/gigs/hub`. Pro = 2 GB storage + 5,000 songs (both capped while Pro is a free self-serve switch) + `venues/organizers/pro-import`. Helpers: `hasFeature`, `storageLimitBytes`, `songLimit`, `planSummary`, `requireFeature(res, artist, key)`.
- **Enforcement is server-side** (`402` + machine codes): `requireFeature` → `upgrade_required` (venues/organizers/GEMA import); storage cap → `storage_limit` (at song-media upload-confirm, `confirmMedia` in `_media.js`, nets the replaced file); song cap → `song_limit` (song create, CSV import, restore — each counts under the band's `SONG_LIMIT_LOCK` advisory lock, `api/_domain/song_import.js`). Client mirrors for UX only.
- **Client gating:** `shell.js` adds `.plan-locked` to nav items the plan lacks (`NAV_FEATURE` map) and routes clicks to `/settings#plan`. `loadConfig()` exposes `cfg.plan`/`cfg.usage`.
- **Self-serve upgrade seam:** `POST /api/config/upgrade` — today flips `config.plan=pro` + sets `upgradedAt`, returns `{mode:'self-serve'}`; later returns `{mode:'checkout', url}` and lets a webhook set the plan. `settings.js renderPlan` branches on `mode`. `POST /api/config/downgrade` sets `plan=free` (keeps `upgradedAt`). `PATCH /api/config` strips `plan`/`upgradedAt` — plan state changes only through these actions or `admin-set-plan`. **This is the swap point for paid billing — no other code changes.**
- **Super-admin:** `/admin` page + `/api/admin/overview` / `/api/admin/set-plan`, gated by `SUPER_ADMIN_EMAILS` (allowlist via global user token, email from DB). Manual grants also via `scripts/plans.js`.
- **Support/donations (live now):** `SUPPORT_LINKS` constant in `footer.js` (provider-agnostic; empty-url entries skipped; plain text links, never the providers' hosted button images, which would send every visitor's IP to them; an optional `img` must be self-hosted; third-party `button.js` is **not** used, CSP blocks it). `renderSupportLinks(el)` renders them in the footer + the Settings donation panel shown after a self-serve upgrade. i18n: `settings.plan.donatePrompt`.
- **One footer everywhere:** `app/js/footer.js` + `app/css/footer.css` (languages left, donations centred, right: smartist.studio · Contact · Privacy · Impressum; two compact rows under 480px). `/impressum` redirects to smartist.studio/impressum (one legal notice). `/privacy` is `app/privacy.html`: the privacy policy, one `<section lang>` per locale shown by CSS on `<html lang>`; update it whenever data collection, a processor or a retention period changes. Leaflet and markercluster are self-hosted under `app/vendor/` for the same reason as the donate links. Pages without a workspace slug (login, root contact) and signup/onboarding show a "smartist studio" wordmark linking to the marketing site. Every page loads `footer.js` before the shared scripts; `injectShell()` calls `renderAppFooter()`, standalone pages carry `<footer data-app-footer></footer>`. `footer.css` has variable fallbacks because `demo.html` does not load `app.css`.
- **Docs:** `docs/architecture.md` (why things are built this way), `docs/deployment.md`, `docs/tenant-onboarding.md`, `docs/oauth-setup.md`, `docs/ci-cd.md`.

---

## Client-side rules

- **Every workspace endpoint goes through `apiFetch()`**, never bare `fetch()`. A workspace is private (see the two gates under Database) and answers 401 without a token, and a bare fetch then renders empty state instead of data. Only login, password reset, invite acceptance, OAuth start, `/api/config` and the contact form may use plain `fetch`. `tests/unit/api_fetch.js` enforces this; `stage.js`/`arrangement.js` run without `session.js` and add the header themselves.
- ESLint flags unused top-level functions and variables inside page scripts only when they are local (`vars: 'local'` on `app/**`): page functions are called from `data-on…` markup. Dead classes in a page's `<style>` block fail `tests/unit/page_styles.js`.
- Venues list is **paged** (`limit`/`offset` + A–Z `letter`), not append-on-scroll; sorting is server-side so it covers all rows. Bulk edit (`venues_bulk_edit` in localStorage, desktop only) reloads the table on every sort, page, filter or letter change, so it asks before discarding unsaved rows (`_confirmDiscardBulk`). `PATCH` writes the whole batch in one `unnest` statement and returns `{count, rejected:[{id,error}]}`; rejected rows are marked in the table.

- `loadConfig()` in `session.js` — stale-while-revalidate via `sessionStorage` key `artist_config_cache`. First call blocks on network; subsequent calls in the same tab return immediately.
- After any `PATCH /api/config` that changes `artists.config`, call `invalidateConfigCache()` so the next `loadConfig()` fetches fresh data.
- Auth token: `smartist_token` (`AUTH_TOKEN_KEY` in `session.js`) — in `sessionStorage`, or `localStorage` with "remember me"; `apiFetch()` sends it as `Authorization: Bearer <token>`. `clearToken()` removes both copies. Change-password returns a replacement token (the old one stops verifying) — store it where the old one was.
- **Do not call `loadLogs()` inside `renderTable()`** — `renderTable()` is also called by `discardAll()`. Logs only need refreshing after a real data change.
- Songs table: toolbar is `position:sticky`; `table-wrap` has JS-computed `maxHeight` for independent scroll. `thead th` uses `box-shadow` instead of `border-bottom` to avoid the sticky/border-collapse disappearing-border bug.
- OAuth login: Google/Facebook buttons appear on the login and signup pages only when `cfg.googleLogin`/`cfg.facebookLogin` are true (both variables of a provider set). On success the server sets the session in a short-lived HttpOnly `oauth_session` cookie (path `/api`, SameSite=Strict) and redirects to `/login#oauth=1&hint=…&next=…`; home.js redeems it once via `POST /api/auth/oauth-session`. No session ever travels in a URL. `state` is bound to an `oauth_nonce` cookie; Facebook signs into existing accounts only with `FACEBOOK_TRUST_EMAIL=true`. Setup: `docs/oauth-setup.md`.

---

## Dates and numbers

`formatDate(value, style)` and `formatTime(value)` in `core.js` are the only date formatters — no page calls `toLocaleDateString` itself (`tests/unit/page_scripts.js` enforces it). Styles: default `22.01.2026` (de) / `22/01/26` (en, fr), `'short'` without the year, `'long'` with the month spelled out. Values are read with UTC accessors because date columns arrive as UTC midnight. `stage.html` loads `core.js` and uses the same functions (without `i18n.js` the page's `lang` attribute picks the style). ISO strings stay raw in `<input type="date">` values and in the .ics export.

---

## Styling

`app/css/app.css` holds the tokens: `--font-ui` (system sans, interface text) and `--font-mono` (song key, tempo, dates, lyrics, slugs, stage view — anything read as a grid), the type scale (`--text-xs/sm/md/base`), `--radius`/`--radius-sm`, `--control-h` (36px) and `--row-h` (32px). Page-level `<style>` blocks use these tokens rather than their own hex values and pixel sizes. **Bump the `app.css?v=` query on every page when the stylesheet changes** — same rule as `i18n.js?v=`.

---

## Internationalisation (i18n)

The app ships in **English (default), French, German**. `stage.html` and `api-docs.html` are intentionally English-only.

- **`app/js/i18n.js`** — loaded in the `<head>` of every translated page, before any other script (so `window.i18n`/`window.t` exist before the shared and page scripts run). UMD-style: pure functions are `module.exports`-ed for Node tests; browser glue runs only when `typeof document !== 'undefined'`. The shared scripts *consume* it — `initPage()` (`shell.js`) and `home.init()` `await window.i18n.ready` before rendering.
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

All scripts: show DB hostname, require `y` confirmation before connecting. `loadEnv` strips surrounding quotes from values. Every script uses `scripts/_lib.js` (`loadEnv`, `confirmDb`, `connect` — postgres.js, like the API; SSL off only for localhost). postgres.js cannot send a JS boolean array: pass `'true'`/`'false'` as `::text[]::bool[]`.

**Schema changes:** append a dated block to `scripts/schema.sql` that ends with `INSERT INTO schema_migrations (id) VALUES ('<date>') ON CONFLICT DO NOTHING;`, and set `SCHEMA_VERSION` in `api/_env.js` to that date (a unit test checks they match). No `DO $$` blocks — `apply_schema.js` splits on `;`. Deployments apply it themselves: `package.json`'s `postinstall` runs `scripts/deploy_migrate.js` during the build's `npm install` (pending migrations only, against that project's `DATABASE_URL`; a failure fails the build; outside a Vercel build it does nothing). Not `vercel.json`: Vercel ignores `installCommand` for this app (no framework, no build step), and a `buildCommand` makes it expect a `public/` output directory while the app serves from the repository root. `.vercelignore` keeps `scripts/` out of deployments except the four files it needs.

```bash
node scripts/setup.js                                      # first-time: schema + band + its admin user
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
node scripts/db_backup.js [--label <l>] [--out <dir>] [--verify <local url>] [--recipient age1…]
                                                          # pg_dump + manifest; nightly via .github/workflows/backup.yml
node scripts/db_restore.js --dump <file> [--identity <key>] # into an EMPTY database, checked against the manifest
```

**Backups** (`docs/backup-restore.md`): Neon point-in-time restore first; `.github/workflows/backup.yml` dumps every production database nightly (restored into a scratch Postgres and compared before it is kept, then age-encrypted to R2) and mirrors every upload bucket, keeping deleted objects 30 days. `scripts/_backup.js` holds the shared pieces; the libpq password travels in the environment, never argv.

`ARTIST_SLUG` env var targets the artist; falls back to the first artist in the DB.
