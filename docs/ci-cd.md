# CI/CD

GitHub Actions runs tests automatically on every push to `dev` or `main`, and on PRs to `main`.

## Workflow

`.github/workflows/ci.yml` has two jobs:

1. **Unit tests** — run immediately, no secrets needed, ~10 seconds
2. **Integration tests** — run after unit tests pass; deploy a preview to Vercel then run the full API test suite against it

## Required GitHub Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `VERCEL_TOKEN` | Create at vercel.com/account/tokens |
| `VERCEL_ORG_ID` | From `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | From `.vercel/project.json` |
| `ARTIST_PASSWORD` | Dev artist password (same as local `ARTIST_PASSWORD`) |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Vercel project → Settings → Deployment Protection → **Protection Bypass for Automation**. Preview deployments are protected, so without it every request gets Vercel's own 401; the integration job skips itself (with a warning) when this secret is missing. |

Go to **Settings → Secrets and variables → Variables → New repository variable**:

| Variable | Value |
|----------|-------|
| `ARTIST_SLUG` | Dev artist slug (same as local `ARTIST_SLUG`) |

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
- Users → `/users`
- Venues/organizers/gigs → their respective management pages
