# Deployment architecture

Target state for the Vercel projects, the databases behind them, and how a
deployment decides whether it serves one band or the public.

Written 2026-09-22, after `smartist-klang` and the then-`smartist-demo` were
found returning 500 on every route for months because `APP_SECRET` was set on
only one project. The cause was not the missing variable — it was that nobody
could say, from any document, what the projects were or what each one needed.

---

## Naming

Renamed 2026-09-22 so the names say what the things are:

| Was | Now | Is |
|---|---|---|
| Vercel `smartist-studio` | `smartist-website` | the marketing site, its own repo |
| Vercel `smartist-demo` | `smartist` | the product |
| Neon `smartist` | `smartist-kevin` | Kevin's own data only |
| Neon `smartist-demo` | `smartist` | the public product's data |

The Vercel renames are done. The Neon renames are dashboard actions (Project
Settings → General → Name) and may still be pending — there is no Neon CLI in
this repo's toolchain.

Renaming a Vercel project changes its `*.vercel.app` URLs. Custom domains,
deployment IDs and `VERCEL_PROJECT_ID` (what CI uses) are unaffected.

---

## Two kinds of deployment

The same code serves both, and one environment variable decides which:

| | `ARTIST_SLUG` set | `ARTIST_SLUG` absent |
|---|---|---|
| Config reports | `singleTenant: true` | `singleTenant: false` |
| Login with no `users` rows | legacy band password | n/a — real accounts only |
| After login, no workspaces | straight to `/<slug>/dashboard` | `/onboarding` (create a band) |
| Visitor can sign up | no | yes |

`ARTIST_SLUG` is only a *default slug*, not a restriction — the API resolves the
band from the URL (`/api/:artist/...`), so a pinned deployment still answers for
other slugs. What it really controls is the **front door**: with it set, a
visitor is dropped into one fixed workspace and never sees signup
(`home.js:113`).

**This is the most important setting to get right on the public deployment.**
Leaving `ARTIST_SLUG` on it would send every new visitor to one band's dashboard
instead of the signup flow.

---

## Target state

| Domain | Vercel project | Repo | `ARTIST_SLUG` | Database |
|---|---|---|---|---|
| `smartist.studio` | `smartist-website` | `smartist-website` | — | none (static) |
| `app.smartist.studio` | `smartist` | `smartist` | **unset** | Neon `smartist` main |
| `demo.smartist.studio` | redirect → `app.smartist.studio/demo/dashboard` | — | — | — |
| `smartist.salmons.fr` | `smartist-salb` | `smartist` | `salb` | Neon `smartist-kevin` |
| `smartist.kevinklang.de` | `smartist-klang` | `smartist` | `klang` | Neon `smartist-kevin` |

Marketing and product stay separate: `smartist.studio` is the public front door
and deploys independently of the app, which is the point of it having its own
repo. The application lives at `app.smartist.studio`, where anyone can sign up,
each signup creates a band, and `/workspaces` switches between them.

### One landing page, not two

The marketing page existed in **both** repos and they diverged. The `smartist`
repo's copy was restyled in September (system sans, lighter paper) but still
advertised a "Tour planning" feature that does not exist; the `smartist-website`
copy had the accurate feature list, the favicons, the OG image and the app
mockups, but was still in the old Courier design from May. Neither was simply
"the good one".

Resolved by keeping the `smartist-website` copy — it had more to lose — porting
the September restyle onto it, and **deleting `app/landing.html`**. Two copies
of a page is what let one rot for four months; the split between repos was not
the problem.

So the app repo now has no marketing page at all, and `vercel.json` serves the
login screen at `/`:

```json
{ "source": "/", "destination": "/app/index.html" }
```

That is correct for every deployment of this repo: a band's domain, the public
app (where marketing lives at `smartist.studio`), and a self-hosted install.

This also removes a redirect that could not work. `app/landing.html` used to
send single-band deployments to `/login` from an inline script that first called
`/api/config?light=1`. It cost a flash of the marketing page on first visit, and
on `smartist-klang` it never fired at all, because that call is one of the routes
returning 500 without `APP_SECRET` — which is why that domain showed marketing
permanently. A static rewrite needs no JavaScript and no API.

### Why the demo is a redirect, not a deployment

`demo.smartist.studio` and `app.smartist.studio` would be two domains on the
**same Vercel project**, and environment variables are scoped per project, not
per domain. The demo domain therefore cannot set `ARTIST_SLUG=demo` while the
app domain leaves it unset — one project, one value.

It does not need to. The app already resolves the band from the URL path, so the
demo band lives at `/demo/...` like any other workspace. `demo.smartist.studio`
becomes a domain-level redirect to `app.smartist.studio/demo/dashboard`, which
needs no project, no environment and no function.

### Databases

| Neon project | Branch | Serves | Rules |
|---|---|---|---|
| `smartist-kevin` | main | `salb`, `klang` | Kevin's own data. One branch, no dev, not shared with anything public. |
| `smartist` | main | public signups **and** the `demo` band | Real user data. Backups matter here. |
| `smartist` | dev | development and the test suite | Never public. The suite writes `[TEST]` rows to it. |

The demo lives as a **band inside the production branch**, reset on a schedule,
rather than on the development branch. Development is where the test suite writes
and where schema changes land first: pointing the public demo at it would show
visitors test rows and break the demo whenever a migration is in flight.

The cost is that visitor writes share a database with real customer data. That is
acceptable because every query is already scoped by `artist_id` and the demo band
is just another tenant — but the reset job must be scoped by slug and can never
be a table-wide `DELETE`.

---

## Access and accounts

`/admin` (`SUPER_ADMIN_EMAILS`) needs two things: a session from a **user token**,
and that user's `users.email` on the allowlist (`api/_domain/admin.js:7-14`).

Both personal deployments have **zero `users` rows** — they log in through the
legacy band-password path, which returns no token at all (`auth.js:161`). So on
those two the allowlist can never match, and setting `SUPER_ADMIN_EMAILS` there
does nothing today.

`SUPER_ADMIN_EMAILS` therefore belongs on the **`smartist` project**, where real
accounts exist. It becomes useful on the personal projects only once those
workspaces have `users` rows, which also means leaving the legacy login behind.
There is currently no supported path to create the first account for an existing
band: signup creates a *new* band, and invite needs an authenticated admin. That
gap needs a script before the personal projects can move.

---

## Required environment variables

Per project, because Vercel scopes them per project. A variable the code requires
must be set on **every** project running this repo:

```bash
vercel project ls                            # every project
vercel env ls production --project <name>    # what that one actually has
```

| Variable | `smartist` | `smartist-salb` / `smartist-klang` | Notes |
|---|---|---|---|
| `APP_SECRET` | yes | yes | `openssl rand -hex 32`, unique per project. Missing it takes the whole API down. |
| `DATABASE_URL` | yes | yes | Per environment. |
| `ARTIST_SLUG` | **no** | yes | Presence is what pins a deployment to one band. |
| `SUPER_ADMIN_EMAILS` | yes | not yet | Needs a `users` row to match. |
| `APP_ORIGIN`, `R2_*`, `RESEND_*`, `GEMINI_API_KEY` | yes | yes | As in `tenant-onboarding.md`. |
| `BETTERSTACK_TOKEN` | production only | production only | |

`smartist-website` is static and needs none of these.

---

## Migration

Ordered so that nothing is public before it works. Steps 1–2 are independent of
the rest and fix a live outage.

1. **Set `APP_SECRET`** on `smartist-klang` and `smartist`, then redeploy both.
   They are down until this is done.
2. **Apply the schema** to the Neon `smartist` main branch:
   `env DATABASE_URL='<url>' node scripts/apply_schema.js`.
   `smartist-kevin` was done on 2026-09-21.
3. **Rename the Neon projects** in the dashboard (see Naming above).
4. ~~**Seed the `demo` band** and write a reset job.~~ **Done.** The band was
   already seeded (47 songs, 29 gigs, 31 setlists, 33 venues, 30 organizers).
   `scripts/demo_reset.js` snapshots it to `scripts/demo_seed.json` and restores
   it, scoped to one `artist_id` with no table-wide delete, leaving the `artists`
   row and `users` untouched. Ids are preserved and sequences bumped past the
   restored maximum, so the next insert from the app cannot collide.
   `.github/workflows/demo-reset.yml` runs it at 03:00 UTC and on demand; it
   needs the repository secret **`DEMO_DATABASE_URL`**.
5. **Add `app.smartist.studio`** to the `smartist` project, point `APP_ORIGIN`
   at it, and redeploy.
6. **Remove `ARTIST_SLUG`** from the `smartist` project's production environment
   and redeploy. Only after this does signup become the front door.
7. **Turn `demo.smartist.studio` into a redirect** to
   `app.smartist.studio/demo/dashboard`.
8. **Set `SUPER_ADMIN_EMAILS`** on the `smartist` project and confirm `/admin`
   loads.
9. **Point the marketing site's calls to action** at `app.smartist.studio`.

Step 6 is the only one a visitor can see going wrong, and it is reversible:
re-adding the variable restores the previous behaviour.

---

## Open questions

- **Backups.** The Neon `smartist` main branch will hold other people's data.
  Its point-in-time restore window should be checked against what is acceptable
  to lose, before the first real signup.
- ~~**First account on the personal projects.**~~ Done — `kontakt@kevinklang.de`
  is an admin on both klang and salb, and `SUPER_ADMIN_EMAILS` is set on all
  three app projects. **The klang password is a temporary one set from the CLI
  and needs changing in /profile.**
- **Neon credentials.** Both production strings have been pasted into terminal
  history and chat repeatedly. Rotate them.
- **The demo reset cadence** is unset. Nightly is the assumption above.
- **The marketing page is now English only.** `app/landing.html` carried 68
  `landing.*` keys translated into French and German; the `smartist-website`
  page has no i18n. Those keys stay in the locale files because
  `dashboard.html` and `demo.html` still use them, but the public marketing
  page no longer has FR/DE. Porting the translations to the website repo is a
  separate piece of work.
- **Google and Facebook sign-in** is not configured on the `smartist` project,
  so email is the only way to create an account. Fresh OAuth apps are the plan:
  `2026-09-22-oauth-setup.md`.
- **Password reset and invites are dead on klang and salmons.** Those use a
  different Resend account, and `kevinklang.de` is not verified in it. Only
  smartist.studio's account was fixed. Nothing is broken for anyone already
  signed in, but nobody can recover an account on those two deployments.
- **Facebook addresses are trusted without a verification check**, unlike
  Google. Fine on a single-band deployment, worth revisiting now that signup is
  public — see the OAuth doc.
- **`arrangement.js` calls `apiFetch()` and `setStatus()`**, neither of which
  exists on stage. Unreachable today because those editing paths are not used in
  the read-only view; recorded in `tests/unit/page_scripts.js` rather than fixed.
- **Cross-domain workspace links.** `/workspaces` links are relative, so opening
  salb from smartist.kevinklang.de shows that band on the other band's domain.
  Works, but needs a decision about what those domains mean.
- **The plans section on smartist.studio** never mentions the hosted free tier,
  so a visitor reads it as self-host-or-pay.
