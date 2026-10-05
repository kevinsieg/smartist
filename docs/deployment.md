# Deployment

How this code is deployed, and the few rules that keep several deployments
healthy. Step-by-step setup of one band's deployment is in
[`tenant-onboarding.md`](tenant-onboarding.md).

---

## Two kinds of deployment

The same code serves both; one environment variable decides which:

| | `ARTIST_SLUG` set | `ARTIST_SLUG` absent |
|---|---|---|
| Config reports | `singleTenant: true` | `singleTenant: false` |
| After login, no workspaces | straight to `/<slug>/dashboard` | `/onboarding` (create a band) |
| Visitor can sign up | no | yes |

`ARTIST_SLUG` is only a *default slug*, not a restriction: the API resolves the
band from the URL (`/api/:artist/...`), so a pinned deployment still answers for
other slugs. What it really controls is the **front door**. With it set, a
visitor lands in one fixed workspace and never sees signup.

**Get this right on a public deployment.** Leaving `ARTIST_SLUG` set there sends
every new visitor to one band's dashboard instead of the signup flow.

---

## One Vercel project per deployment

A typical setup:

| Domain | Vercel project | `ARTIST_SLUG` | Database |
|---|---|---|---|
| `app.example.com` (public, with signup) | `smartist` | unset | its own Neon project |
| `smartist.band.example.com` | `smartist-myband` | `myband` | a separate Neon project, or a row in a shared one |
| `example.com` (marketing) | separate static site | none | none |

Every Neon project has a `main` branch for Production and a `dev` branch for
Preview + Development ([`tenant-onboarding.md`](tenant-onboarding.md) walks
through all three models).

The login screen is served at `/` by `vercel.json`, which is right for every
kind of deployment. A marketing page, if you want one, lives in its own repo.

### A demo band

A public demo is just another band inside the production database, at
`/demo/...`, reset on a schedule by `.github/workflows/demo-reset.yml` →
`scripts/demo_reset.js` from `scripts/demo_seed.json`. The reset is scoped to
one `artist_id` and never deletes table-wide; `artists` and `users` rows are
left alone. It needs the repository secret `DEMO_DATABASE_URL`, pointing at the
**production** database. The workflow runs only in the upstream repository
(its job's `if:` checks `github.repository`); on a fork, change that check to
your own owner/name first, or the job skips itself.

Visitors enter through the `/demo` gate, which gives them a **member** session
on that band (`DEMO_ARTIST_SLUG`, default `demo`): they can edit songs, gigs and
setlists, but not settings, members or uploads, and cannot email setlists
(403 `demo_readonly`): the gate hands a session to anyone. Its
token is signed with a key derived from `APP_SECRET`, so the demo band needs no
password; the band's own users sign in with their accounts as usual.

It lives in production rather than on the development branch because the test
suite writes `[TEST]` rows to development, and schema changes land there first.

A demo subdomain cannot be its own deployment on the same Vercel project:
environment variables are per project, not per domain. Use a host-conditional
redirect in `vercel.json` to `/demo` instead.

---

## Environment variables

Vercel scopes variables **per project**. A variable the code requires must be
set on **every** project that runs this repo, or that project fails on every
request:

```bash
vercel project ls                            # every project
vercel env ls production --project <name>    # what that one actually has
```

| Variable | Public deployment | Single-band deployment | Notes |
|---|---|---|---|
| `APP_SECRET` | yes | yes | `openssl rand -hex 32`, unique per project. Without it nobody can sign in (500 on sign-in, 401 on every session). |
| `DATABASE_URL` | yes | yes | Per environment. |
| `ARTIST_SLUG` | **no** | yes | Presence pins a deployment to one band. |
| `SUPER_ADMIN_EMAILS` | yes | optional | Needs a `users` row to match: sign up with that address (public), or the admin from `setup.js`. |
| `APP_ORIGIN` | yes | yes | Base of every emailed link. Without it links fall back to the request's `Host` header. |
| `R2_*`, `RESEND_*`, `GEMINI_API_KEY` | yes | yes | See `tenant-onboarding.md`. |
| `DEMO_ARTIST_SLUG` | optional | no | Band the `/demo` gate opens; default `demo`. |
| `FACEBOOK_TRUST_EMAIL` | optional | optional | Only with Facebook sign-in; see `oauth-setup.md`. |
| `BETTERSTACK_TOKEN` | production only | production only | |
| `SKIP_PREVIEW_BUILDS` | no | `1` | Read only by `ignoreCommand` in `vercel.json`: with `1` the project builds `dev` and `main` and skips every other branch. Vercel Hobby allows 100 deployments a day; one project building PR previews is enough. |

**Variables only reach new builds.** Adding one to a live deployment changes
nothing until it is rebuilt: `vercel ls <project>`, then `vercel redeploy <the
Production URL>`.

---

## Rotating a database connection string

A `DATABASE_URL` usually lives in more than one place. For each database, list
every place its string is stored before rotating:

- each Vercel project and environment that uses it (`vercel env ls --project <name>`),
- GitHub repository secrets (`gh secret list`), notably `DEMO_DATABASE_URL`,
- your local `.env`.

Then:

1. Rotate in the Neon console.
2. Update every place above, **before** anything redeploys.
3. Redeploy each affected Vercel project (variables are baked in at build time).
4. Update local `.env` by hand. Do not `vercel env pull` over it.

Preview and Development entries created by the Neon–Vercel integration may
update on their own; check them afterwards rather than assuming either way.

## Monitoring

Three checks per production deployment, all in Better Stack:

- **Uptime.** A monitor on `https://<domain>/api/config?action=health`, every
  3 minutes, alerting when the URL is unavailable. The endpoint answers 503
  when a required variable is missing, the database is unreachable or the
  schema is behind, so a status check is enough; no keyword needed.
- **Logs stopped arriving.** Each health request writes a `request` log line,
  so the uptime monitor keeps a steady stream flowing into the deployment's
  log source even at night. An alert on that source fires when fewer than one
  line arrives in 30 minutes. It catches the transport failing silently (a
  wrong `BETTERSTACK_TOKEN`, or lines lost when the function freezes after the
  response) as well as the deployment being down.
- **Responses near the size limit.** Vercel refuses response bodies over
  4.5 MB, and the song and setlist lists and the export are unpaged. Every
  `request` line carries the body size (`bytes`); a body over 2 MB also logs a
  `large_response` warning naming the endpoint (and so the band). Alert on
  that event to page the endpoint before it starts failing.

The health check itself cannot tell whether logs arrive: the send happens after
the response, handed to Vercel's `waitUntil` (`api/_handler.js`), so the request
never waits for the log service.

## Backups

Neon's point-in-time restore, plus a nightly encrypted dump of every
production database and a mirror of every upload bucket
(`.github/workflows/backup.yml`). Setup, restore procedures and the drill:
[`backup-restore.md`](backup-restore.md). A new deployment adds its database
and bucket to the backup secrets.

## Unconfirmed uploads

Song media is uploaded straight to the bucket with a presigned URL (size signed
in, at most 50 MB) and counted once the app confirms it. An upload that is
never confirmed stays in the bucket, uncounted. Do **not** add a bucket
lifecycle rule for this: confirmed files live under the same prefixes
(`audio/`, `sheets/`, `playback/`) and would be deleted too.
`node scripts/plans.js --recount` recomputes each band's usage from the files
its songs reference.
