# CI/CD

GitHub Actions runs tests automatically on every push to `dev` or `main`, and on PRs to `main`.

## Workflow

`.github/workflows/ci.yml` has four jobs, all on Node 24 (the `engines` version in `package.json`, which Vercel also reads):

1. **Unit tests** — ESLint (`npm run lint`), type check (`npm run typecheck`), then the unit suites; run immediately, no secrets needed, ~10 seconds
2. **Integration + browser tests (local Postgres)** — after unit tests; no secrets needed. A `postgres:16` service gets `scripts/schema.sql` applied twice (it must stay idempotent) and checked with `apply_schema.js --check`, `tests/harness/seed.js` creates a Pro band with one admin and two songs, `tests/harness/server.js` serves the handlers with the `vercel.json` rewrites, and `tests/api.js` runs against it. Then `tests/smoke.js` drives Chromium through the app: sign in through the login form, every workspace page, the nav links (SPA navigation) and a stage link; any uncaught exception, console error or API 5xx fails it. `tests/smoke-root.js` then starts a second server without `ARTIST_SLUG`, as production runs, and checks the root flows: signing in at `/login` and the mailed sign-in and reset links. It also dumps the seeded database with `scripts/db_backup.js --verify`, restoring it into an empty database and comparing it, the path the nightly backup takes. This is the job that catches a schema, handler or page-script change before it reaches a preview.
3. **Live code on the new schema** — only when `scripts/schema.sql` differs from `main`. Applies this branch's schema to a fresh `postgres:16`, then seeds, serves and runs the API suite of `main` (a worktree) against it. Deployments migrate in their build a minute or two before the new code is live; this is that window. A column dropped while `main` still uses it fails here.
4. **Integration tests (Vercel preview)** — after unit tests; deploy a preview to Vercel then run the same suite against it, through the real router and the dev database

Run the same thing locally with `npm run test:all` (unit, then API and browser
tests against the stack `scripts/dev_up.sh` starts: its own Postgres, schema,
seeded band, server on `:3000`). See `tests/README.md`. The seed script refuses
any database that is not on localhost.

## Required GitHub Secrets

Only the Vercel preview job needs these; without them it skips itself.

Go to **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `VERCEL_TOKEN` | Create at vercel.com/account/tokens |
| `VERCEL_ORG_ID` | From `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | From `.vercel/project.json` |
| `ARTIST_EMAIL` | Login email of a user in the dev test workspace (same as local `ARTIST_EMAIL`). A secret so it is masked in the public Actions logs. |
| `ARTIST_PASSWORD` | That user's password (same as local `ARTIST_PASSWORD`) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Vercel project → Settings → Deployment Protection → **Protection Bypass for Automation**. Preview deployments are protected, so without it every request gets Vercel's own 401; the integration job skips itself (with a warning) when this secret is missing. |

Go to **Settings → Secrets and variables → Variables → New repository variable**:

| Variable | Value |
|----------|-------|
| `ARTIST_SLUG` | Dev test workspace slug (same as local `ARTIST_SLUG`); it must be on the Pro plan, or the venue and organizer tests only check the 402 |

## Test cleanup

All write tests clean up after themselves:

| Table | Cleanup method |
|-------|---------------|
| Songs | Soft-deleted then hard-deleted within the test run |
| Arrangements | Hard-deleted within the arrangement write tests |
| Setlists | `DELETE /api/:artist/setlists/:id` — original and duplicate both deleted |
| Venues | `DELETE /api/:artist/venues/:id { hard: true }` |
| Organizers | `DELETE /api/:artist/organizers/:id { hard: true }` |
| Gigs | `DELETE /api/:artist/gigs/:id { hard: true }` |
| Users | `DELETE /api/:artist/auth` at end of multi-user auth tests |

If a test run is interrupted mid-way, any `[TEST]` records left in the dev DB can be removed manually:
- Setlists → `/setlist-history`
- Users → `/<slug>/settings` (Members)
- Venues/organizers/gigs → their respective management pages
