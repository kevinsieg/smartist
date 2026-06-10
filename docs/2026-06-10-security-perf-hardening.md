# 2026-06-10 — Security & performance hardening (multi-tenant)

Post-signup-launch hardening pass. All changes in one commit on `dev`.

## Production deploy checklist

1. Merge/push as usual (Vercel deploys).
2. **Run schema updates on the prod DB** (adds `users_email_idx`, idempotent):

   ```bash
   DATABASE_URL=<prod-neon-url> node scripts/apply_schema.js
   ```

   The script shows the DB hostname and asks for confirmation before connecting.
   Unlike `setup.js` it always re-runs the full (idempotent) `schema.sql`, so new
   indexes/columns reach existing databases.
3. Spot-check on the deployed preview: `X-Robots-Tag` is `index, follow` on `/`
   and `/signup` (later vercel.json header rules override the global noindex —
   verify Vercel applies them in order), and the CSP header doesn't break the
   venues map or R2 uploads.

## Security fixes

| Issue | Fix |
|-------|-----|
| **Cross-tenant authz hole (critical)** — user tokens carried only `{userId, role}`; `requireAuth` accepted any valid token for any artist | `api/_auth.js` resolves membership via email-linked `users` rows for the requested artist; role comes from the DB row (per-workspace, revocable), not the token |
| Fake-header bypass — `viewMode = !req.headers.authorization` | `getAccess(req, slug)` → `{ artist, user }` with real token validation; used by all GET handlers |
| Venues `?all=1` / `?slim` / `/:id` fully public (incl. CRM comments) | Public-status filter + comment stripped for anonymous; map payload trimmed to 12 columns |
| Organizers fully public (PII: emails, phones) | All organizer reads require auth |
| Gig comments public (list, single, ICS feed) | Stripped server-side for anonymous; never in the ICS feed (webcal URL is guessable, can't auth) |
| CDN cache leak — authed responses cached publicly | `Cache-Control: public` only set on view-mode (anonymous) responses |
| Stored XSS via `javascript:` URLs in hrefs | `safeUrl()` moved to common.js; applied in gigs, songs, hub |
| Tokens in query strings (logs/history) | Magic/invite/OAuth links now use URL fragments (`/login#magic=…`); home.js reads hash-or-query so old emails keep working |
| No CSP | Added in vercel.json: scripts self+jsdelivr, `object-src 'none'`, `frame-ancestors 'none'` (`unsafe-inline` retained — codebase uses inline handlers) |
| Leaflet CDN without SRI | sha384 integrity hashes in venues.html and map.js loader |
| workspaces.js syntax error (curly quotes) | Page was completely broken since commit; fixed |

## Private workspace setting

`artists.config.private = true` → all public GETs return 401 for anonymous
visitors (songs incl. song-logs/GEMA/arrangements/setlist-appearances, setlists
list+detail, gigs, venues). `GET /api/config` still serves name/config (login
page branding) but omits songs and counts. Toggle: profile page → Privacy.
Caveat: anonymous visitors may see cached public data up to ~60s after toggling
(CDN `s-maxage`).

Public view mode (default) is unchanged: songs and setlists remain browsable
per-tenant by direct URL.

## Performance

- `GET /api/config?light=1` skips the songs payload (full rows incl. lyrics +
  GEMA lateral join). `initPage` uses light by default; gigs opts out
  (`{ fullConfig: true }`, song filter needs titles); setlist/stage keep full.
  Light/full cached under separate sessionStorage keys; `invalidateConfigCache()`
  clears both.
- Dashboard song count now comes from `counts.songs` (added to the counts query).
- `getAccess` resolves the artist once per GET; data queries use `artist.id`
  instead of repeated slug subqueries.
- `users_email_idx` (membership check runs on every authed request).
- Clients now send the auth token on reads (`apiFetch` / explicit headers in
  map.js + stage.js) — required for member-only data (comments, non-public
  venues, private workspaces).

## initPage contract (changed earlier this session)

- Requires login; unauthenticated → login redirect.
- Config load failure → `/home` with a one-shot `ws_skip_autoredirect`
  sessionStorage flag so workspaces.js doesn't bounce straight back (loop guard).
- Page callback (`onReady`) errors are logged, not redirected.
- viewMode parameter removed — dead plumbing stripped from gigs/hub/organizers/
  pro-import/venues/users and map.js.

## Tests

- `node tests/unit.js` — 174 pass (auth tests now assert membership binding +
  role-from-DB).
- `cd tests && npm test` — 77 pass against `vercel dev` (organizers tests assert
  the new 401 contract).
- **New** `tests/e2e-signup.js` (`npm run test:e2e`): plants a signup token in
  the DB, runs verify → signup → session token works on the new workspace →
  token rejected on a foreign workspace (cross-tenant regression) → cleanup.
  Needs `DATABASE_URL` + a running server.

## Also fixed in passing

- Profile page: every `PATCH /api/config` was missing `?slug=` (broken in
  multi-tenant) and read the token from sessionStorage only (broken for
  remember-me). Both fixed; profile now loads light config.
- `home.js`: `history.replaceState` wiped `?next=` before `renderLoggedIn` read
  it — captured in `_loginNext` now.
- `schema.sql` had semicolons inside inline comments that truncated statements
  in the naive `split(';')` parsers (setup.js fresh-install path was affected);
  comments defused and `apply_schema.js` strips comments quote-aware.
