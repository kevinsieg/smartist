# Tests

Two test layers — unit tests (no infrastructure) and integration tests (need a live server).

---

## Unit tests

Test pure helper functions with no server, database, or network required. Run anywhere Node 24 is available.

```bash
npm run test:unit           # from repo root — unit.js plus the client-script suites (*-client.js)

# Individual suites (useful when working on one module)
node tests/unit/validate.js
node tests/unit/token.js
node tests/unit/pdf.js
node tests/unit/r2.js
node tests/unit/lyrics.js
node tests/unit/ratelimit.js
node tests/unit/gema.js
node tests/unit/ai.js
node tests/unit/handler.js
node tests/history-client.js
```

**What is covered:**

| Suite | Module | Functions |
|-------|--------|-----------|
| `tests/unit/validate.js` | `api/_validate.js` | `validateSongIds`, `validateStr`, `validateNum`, `validateEmail` |
| `tests/unit/token.js` | `api/_token.js` | `generateMagicToken`, `verifyMagicToken` |
| `tests/unit/pdf.js` | `api/_pdf.js` | `setlistTitle` |
| `tests/unit/r2.js` | `api/_r2.js` | `keyFromUrl`, `filenameFromUrl` |
| `tests/unit/lyrics.js` | `api/_lyrics.js` | `LYRICS_SOURCES`, `plainFromSynced` |
| `tests/unit/ratelimit.js` | `api/_ratelimit.js` | `clientIp` |
| `tests/unit/gema.js` | `api/_domain/gema.js` | CSV parsers, GEMA normalizers |
| `tests/unit/ai.js` | `api/_ai.js` | `suggestLyricsWithAI` skip/error handling and Gemini response cleanup |
| `tests/unit/handler.js` | `api/_handler.js` | `wrap` logging and error sanitization |
| `tests/history-client.js` | `app/js/setlist-history.js` | response parsing helpers |
| `tests/unit/tenant_isolation.js` | handlers, `api/_ownership.js`, `api/_token.js` | cross-band ids refused, script links refused, demo token is a member session, token purposes, sessions end on password change |
| `tests/unit/*_handlers.js`, `auth.js`, `oauth_callback.js`, … | API handlers with a stubbed database | auth, roles, reset, signup, deletion, OAuth callback (incl. the `oauth_nonce` cookie), storage accounting |
| `tests/*-client.js` | page scripts in `app/js/` | run in a stubbed DOM (songs, gigs, map, workspaces, logout, …) |

Unit tests run automatically on every push via GitHub Actions (`.github/workflows/ci.yml`).

---

## Integration tests

Full API coverage against a running server, and a browser smoke test.

### Local stack (recommended)

`scripts/dev_up.sh` starts what CI runs: a throwaway Postgres, the schema, a
seeded Pro band with one admin, and the API + pages on `:3000`
(`tests/harness/server.js`). It never touches a remote database.

```bash
npm run test:api     # starts the stack if needed, then tests/api.js
npm run test:smoke   # browser: sign in, every page, SPA nav, stage; then the multi-tenant
                     # root (smoke-root.js: /login, mailed sign-in and reset links). Needs playwright
npm run test:all     # unit + api + smoke
npm run dev:up       # just start it and print the env; npm run dev:down stops it
npm run dev:restart  # after changing api/ code
```

Needs Postgres binaries (`initdb`, `pg_ctl`) and, for the smoke test,
`npm i -g playwright && npx playwright install chromium`. Claude Code on the web
sessions start with the stack already up (`.claude/hooks/session-start.sh`).

### Against vercel dev or a deployment

The suite loads `.env.local` then `.env` from the **repo root**; each key is applied only if not already set, and values exported in the shell win. Quote-wrapped lines (from `vercel env pull`) are stripped.

Workspaces are private, so every read and write test runs with a session: the suite signs in as a user of the band.

```
ARTIST_SLUG=yourband
ARTIST_EMAIL=you@example.com
ARTIST_PASSWORD=yourpassword
```

```bash
cd tests && npm test                       # vercel dev on port 3000
npm run test:dev                           # the dev Preview deployment
npm run test:prod                          # production (anonymous checks unless signed in)
BASE_URL=https://your-preview.vercel.app node tests/api.js
```

### What is tested

**Anonymous (always run)**

| Area | Checks |
|------|--------|
| `GET /api/config` | slug and name; songs only for a public catalogue; `gemaIpNameNumber`/`upgradedAt` hidden |
| Privacy | songs, song logs, gigs (+ .ics), setlists, venues and GEMA answer 401 without a token — except what the band opted into (`publicCatalogue`, `publicStage`) |
| Auth rejections | every write endpoint returns 401 without a token; wrong password returns 401; a password without an email → 400 `band_password_retired`; PUT /setlists/:id → 401 |

**Signed in (requires `ARTIST_EMAIL` and `ARTIST_PASSWORD`)**

| Area | Checks |
|------|--------|
| `GET /api/config` | ships the songs array |
| `GET /api/:artist/songs` | array with play_count and last_played_at |
| `GET /api/:artist/songs/:id/setlists` | appearances list |
| `GET /api/:artist/song-logs` | audit log with action and song_data |
| `GET /api/:artist/gigs` | array; single gig by id |
| `GET /api/:artist/setlists` | array with song_count; single setlist with ordered songs |
| Validation | id=0 → 400, non-integer id → 400, missing required fields → 400, unknown id → 404 |
| `POST /api/login` | email + correct password → 200 |
| Song lifecycle | create → patch → delete → restore → delete (DB left clean) |
| `POST /api/:artist/songs` | missing title → 400 |
| Lyrics suggest | rejects songs without an artist before calling external providers |
| Setlist lifecycle | `POST` (create) → 201, `POST` (share) validates email + unknown id, `PUT` updates title, `POST` (duplicate) → 201 with new id + matching song count |
| `POST /api/:artist/setlists` | missing song_ids → 400 |
| File upload validation | extension, MIME type, size, presigned URL prefix checks (keys are `audio|sheets|playback/<artist id>/…`) |
| Lyrics lifecycle | PUT, GET verify, DELETE, idempotent DELETE |
| `GET /api/:artist/export` | 200, a `.zip` attachment holding `artist.csv`, `songs.csv`, … |

> **Note:** write tests create `[TEST]` rows (songs, setlists, venues, organizers, gigs, a user) and delete them again at the end. An interrupted run can leave some behind — remove them from the matching page.

> **Protected previews:** Vercel Deployment Protection answers every request with its own 401. Set `VERCEL_AUTOMATION_BYPASS_SECRET` (the project's *Protection Bypass for Automation* secret) and the suite sends it as `x-vercel-protection-bypass`.

### Exit codes

- `0` — all tests passed
- `1` — one or more tests failed or `ARTIST_SLUG` is not set
