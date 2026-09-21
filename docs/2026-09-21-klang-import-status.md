# Klang data import — status, 2026-09-21

Where the work stands, what is verified, and what is still open. Companion to
`2026-09-17-klang-gigdb-import-design.md` (decisions) and `-plan.md` (task list).

## State

- **Merged:** PR [#42](https://github.com/kevinsieg/smartist/pull/42) landed on `dev` (squash commit `a3ab935`); the `feat/klang-data-import` branch is gone. Not deployed to production yet.
- **Demo DB** (smartist-demo dev branch, the `DATABASE_URL` in `.env`): artist `klang`, Pro plan, private, holding the full import — 129 songs, 32 GEMA works, 159 gigs, 78 setlists, 1996 venues, 104 organizers.
- **Production is untouched.** No schema change, no import.

## Pipeline (all gitignored, lives in `data/`)

| Script | Purpose |
|---|---|
| `clean.js` | CSV → `data/clean/*.json` + `REPORT.md`. Re-runnable, must end with `errors=0`. |
| `check_venues.js` | Website reachability (3 passes + manual verdicts baked in). |
| `enrich_venues.js` | Postcode/state (OpenPLZ) and coordinates (Nominatim), cached in `geo_cache.json`. |
| `find_videos.js` | Reference video per song: YouTube search + oEmbed verification. |
| `import.js` | `--artist klang [--dry-run]`, one transaction, idempotent, dry-run rolls back. |
| `setup_klang_demo.js` | Creates the throwaway demo artist (prints a generated password). |

Re-running the import reports 0 changes; a second run is the idempotency check.

## Verified

- 324 unit tests, 5 client suites.
- 181 integration tests (`tests/api.js`) against the demo workspace with the real data.
- `/code-review high` over the branch: 9 findings, all fixed in `c9e0046`.

## Open

1. **Prod rollout** (the main one): Neon backup branch → deploy the branch → `apply_schema.js` → `import.js --dry-run` → real run. The prod `klang` workspace already has data, so the dry run's "filled" counts want a read before committing.
2. **Two integration tests fail here**, both from dev's email-change feature: `POST confirm-email-change with a garbage token` expects 400, gets 401. Probably environmental — the suite authenticates with the workspace password (bootstrap token, no `users` row) while the endpoint wants a named user. Unverified: run the same suite against plain `origin/dev` to tell test assumption from bug.
3. **`REPORT.md` items for Kevin**: 16 venues whose town was derived from the venue name, 19 venue websites that answer only with server errors, 35 songs without a verified video (33 unreleased own songs + "King of the Bongo", "Over in the Gloryland"), 523 venues whose town has several postcodes, 103 venues with no town.
4. **Nice to have**: keyboard editing and fill-down in venue bulk edit; saved filters (never contacted, no email, stale); the map still loads all 1996 venues in one `?all=1` request and needs clustering.

## Local environment

- `.env` has **`ARTIST_SLUG="klang"`** — changed during testing so the login page targets the demo workspace. **Set it back to `demo`** when done. `.env` is maintained by hand; never overwrite it.
- The demo workspace is disposable: `node scripts/delete_artist.js --artist klang` removes it and everything attached.
- Login for the demo workspace uses a generated password printed by `setup_klang_demo.js`; re-run it after a delete to get a fresh one.
