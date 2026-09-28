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
| `smartist.band.example.com` | `smartist-myband` | `myband` | a separate Neon project |
| `example.com` (marketing) | separate static site | none | none |

The login screen is served at `/` by `vercel.json`, which is right for every
kind of deployment. A marketing page, if you want one, lives in its own repo.

### A demo band

A public demo is just another band inside the production database, at
`/demo/...`, reset on a schedule by `.github/workflows/demo-reset.yml` →
`scripts/demo_reset.js` from `scripts/demo_seed.json`. The reset is scoped to
one `artist_id` and never deletes table-wide; `artists` and `users` rows are
left alone. It needs the repository secret `DEMO_DATABASE_URL`, pointing at the
**production** database.

Visitors enter through the `/demo` gate, which gives them a **member** session
on that band (`DEMO_ARTIST_SLUG`, default `demo`): they can edit songs, gigs and
setlists, but not settings, members or uploads, and the gate sends no email. A
password login to the demo band is still a full admin session.

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
| `APP_SECRET` | yes | yes | `openssl rand -hex 32`, unique per project. Missing it takes the whole API down. |
| `DATABASE_URL` | yes | yes | Per environment. |
| `ARTIST_SLUG` | **no** | yes | Presence pins a deployment to one band. |
| `SUPER_ADMIN_EMAILS` | yes | optional | Needs a `users` row to match; `scripts/create_user.js` creates the first one. |
| `APP_ORIGIN` | yes | yes | Base of every emailed link. Without it links fall back to the request's `Host` header. |
| `R2_*`, `RESEND_*`, `GEMINI_API_KEY` | yes | yes | See `tenant-onboarding.md`. |
| `DEMO_ARTIST_SLUG` | optional | no | Band the `/demo` gate opens; default `demo`. |
| `FACEBOOK_TRUST_EMAIL` | optional | optional | Only with Facebook sign-in; see `oauth-setup.md`. |
| `BETTERSTACK_TOKEN` | production only | production only | |

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
