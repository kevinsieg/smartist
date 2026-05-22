# CLAUDE.md

Artist management app — Vercel serverless (no build step) + Neon PostgreSQL. See `README.md` for infrastructure names, env vars, and setup steps.

---

## Environments

| Branch | Vercel env | DB | Notes |
|--------|------------|----|-------|
| `dev` | Preview | Neon dev | default; push freely |
| `main` | Production | Neon main | PR-merge only |

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
| `/songs` | `app/js/songs.js` |
| `/gema-import` | `app/js/gema-import.js` |
| `/gigs` | `app/js/gigs.js` |
| `/venues` | `app/js/venues.js` |
| `/organizers` | `app/js/organizers.js` |
| `/hub` | `app/js/hub.js` |
| `/stage?id=N` | `app/js/stage.js` — **no `common.js`; no nav** |

`app/js/common.js` is loaded by every page except `stage.html`. **Do not put `<header>` or `<footer>` in page HTML** — `injectShell()` in `common.js` builds them at script-load time. `stage.js` calls `fetch('/api/config')` directly instead of `loadConfig()` (which lives in `common.js`).

**Key common.js exports:**
- `loadConfig()` — stale-while-revalidate; blocks on first call, cached in `sessionStorage` thereafter
- `invalidateConfigCache()` — call after any `PATCH /api/config` that mutates `artists.config` so the next `loadConfig()` fetches fresh data
- `createSortableList(options)` — reusable column-driven table with sort buttons and filter input. Column shape: `{ field, label, width, sortable, filterable, muted, type, render, actions }`. Multiple instances sharing one filter input register via `filterInputId` (uses `_slFilterRegistry` internally). Returns `{ setData(rows), refresh() }`.

---

## Serverless functions (12 — Hobby plan limit)

| File | Routes |
|------|--------|
| `api/config.js` | `GET /api/config`; `PATCH /api/config` (update name/config); `POST /api/config` (subscribe/demo/contact); `GET ?action=google-url\|facebook-url` (OAuth start); `GET ?action=oauth-callback` (via `/auth/callback` rewrite); `GET ?action=photo-url` (presigned upload) |
| `api/[artist]/auth.js` | `POST /api/:artist/auth`; `POST /api/:artist/request-reset` (via rewrite) |
| `api/[artist]/gigs.js` | `GET/POST /api/:artist/gigs` |
| `api/[artist]/gigs/[id].js` | `GET/PUT/DELETE /api/:artist/gigs/:id` |
| `api/[artist]/organizers.js` | `GET/POST /api/:artist/organizers` |
| `api/[artist]/organizers/[...path].js` | `GET/PUT/DELETE /api/:artist/organizers/:id` |
| `api/[artist]/setlists.js` | `GET /api/:artist/setlists`; `POST` — create `{song_ids}`, duplicate `{duplicate_id}`, share `{share_id,email}` |
| `api/[artist]/setlists/[...path].js` | `GET/PUT /api/:artist/setlists/:id`; `GET /api/:artist/setlists/export` (via rewrite) |
| `api/[artist]/songs.js` | `GET/POST/PATCH /api/:artist/songs`; `GET /api/:artist/song-logs` (via rewrite) |
| `api/[artist]/songs/[...path].js` | `DELETE` / `restore` / `setlists` / `gema` / `lyrics` / `lyrics-suggest` / `audio` / `sheet` / `playback` / `gema-import` (via rewrite) |
| `api/[artist]/venues.js` | `GET/POST /api/:artist/venues` |
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
| `_media.js` | `makeMediaFn(config)` for use inside catch-alls; `makeMediaHandler` for standalone files |
| `_ai.js` | `suggestLyricsWithAI(title, artist, opts)` — swap provider via `AI` block at top; `format:'gemini'` default |
| `_logger.js` | `info/warn/error(event, data)` — dev→file, preview→stdout, prod→BetterStack; swap via `TRANSPORT` block |
| `_token.js` | `generateMagicToken(hash)`, `verifyMagicToken(token, hash)` — 30-min HMAC |

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

**JSONB:**
- Neon serialises JS objects directly — do **not** `JSON.stringify()`.
- Use `extra || ${update.extra}` (JSONB `||`) for partial PATCH; full replacement overwrites keys like `isrc` and `language` that the UI doesn't manage.

---

## Database

Tables: `artists`, `songs`, `gigs`, `setlists`, `setlist_songs`, `song_logs`, `venues`, `organizers`, `gema_works`, `gema_rightholders`, `rate_limits`, `subscribers`. Full schema (idempotent) in `scripts/schema.sql`. See `DATABASE.md` for entity diagram and column reference.

Songs use a `deleted` flag (soft-delete). `songs.extra` JSONB holds arbitrary per-song data (`isrc`, `language`, `listenUrl`, `sheetUrl`, `playbackUrl`, `lyrics`, `capo`, …).

`artists.config` JSONB drives the UI: `displayFields`, `filterFields`, `logoUrl`, and `platforms` (streaming/social links managed via `/hub`). Always use JSONB `||` merge (`config || ${update}`) when patching — never overwrite the full object.

Venues and organizers are CRM-style reference tables linked to gigs via `venue_id`/`organizer_id` (FK `ON DELETE RESTRICT`). Both support soft-delete (`deleted` flag).

GEMA: `extra.language` is editable when no GEMA work is linked; the GEMA value shadows it when linked. `extra.isrc` is always read-only (set via script). The `||` PATCH merge preserves both.

---

## Client-side rules

- `loadConfig()` in `common.js` — stale-while-revalidate via `sessionStorage` key `artist_config_cache`. First call blocks on network; subsequent calls in the same tab return immediately.
- After any `PATCH /api/config` that changes `artists.config`, call `invalidateConfigCache()` so the next `loadConfig()` fetches fresh data.
- Auth token: `sessionStorage.setlist_token` → `Authorization: Bearer <token>` on every mutating request.
- **Do not call `loadLogs()` inside `renderTable()`** — `renderTable()` is also called by `discardAll()`. Logs only need refreshing after a real data change.
- Songs table: toolbar is `position:sticky`; `table-wrap` has JS-computed `maxHeight` for independent scroll. `thead th` uses `box-shadow` instead of `border-bottom` to avoid the sticky/border-collapse disappearing-border bug.
- OAuth login: Google/Facebook buttons appear on the login page only when `cfg.googleLogin`/`cfg.facebookLogin` are true (set from env vars). On success the server redirects to `/?magic=<token>` reusing the existing magic-link flow. Required env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `ARTIST_ADMIN_EMAIL`.

---

## Scripts

All scripts: show DB hostname, require `y` confirmation before connecting. `loadEnv` strips surrounding quotes from values.

```bash
node scripts/setup.js                                      # first-time: schema + artist row
node scripts/seed.js [--force]                             # dev DB test data; --force wipes first
node scripts/import_songs.js --artist <slug> songs.json
node scripts/import_gema.js  --artist <slug> [--ids <csv>] [--info <csv>] [--beteiligte <csv>] [--dry-run]
```

`ARTIST_SLUG` env var targets the artist; falls back to the first artist in the DB.

---

## Tests

```bash
node tests/unit.js                        # validate + token helpers; runs in CI
cd tests && ARTIST_PASSWORD=… npm test      # full integration suite against vercel dev (port 3000)
npm run test:dev                          # against Vercel Preview URL
```

Write tests (require `ARTIST_PASSWORD`) create two `[TEST]` setlists that persist. Remove them manually from `/setlist-history` if needed.
