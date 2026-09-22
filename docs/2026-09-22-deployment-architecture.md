# Deployment architecture

Target state for the four Vercel projects, the databases behind them, and how a
deployment decides whether it serves one band or the public.

Written 2026-09-22, after `smartist-klang` and `smartist-demo` were found
returning 500 on every route for months because `APP_SECRET` was set on only one
project. The cause was not the missing variable — it was that nobody could say,
from any document, what the projects were or what each one needed.

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

**This is the single most important setting to get right on the public
deployment.** Leaving `ARTIST_SLUG` on it would send every new visitor to the
demo band's dashboard instead of the signup flow.

---

## Target state

| Domain | Vercel project | Repo | `ARTIST_SLUG` | Database |
|---|---|---|---|---|
| `smartist.studio` | the renamed `smartist-demo` | `smartist` | **unset** | `ep-summer-smoke` main |
| `demo.smartist.studio` | same project, second domain | `smartist` | `demo` | `ep-summer-smoke` main |
| `smartist.salmons.fr` | `smartist-salb` | `smartist` | `salb` | `ep-fancy-mud` |
| `smartist.kevinklang.de` | `smartist-klang` | `smartist` | `klang` | `ep-fancy-mud` |

`smartist.studio` is the product: anyone can sign up, each signup creates a band,
and `/workspaces` switches between them. The marketing content moves into the app
repo's own landing page (`app/landing.html`, served at `/`), and the separate
`kevinsieg/smartist-studio` repo is retired — one repo, one place to look.

`demo.smartist.studio` stays as a front door to the demo band. It is the same
deployment; only the domain differs.

### Databases

| Database | Serves | Rules |
|---|---|---|
| `ep-fancy-mud` | `salb`, `klang` | Kevin's own data. One database, no dev branch, not shared with anything public. |
| `ep-summer-smoke` main | public signups **and** the `demo` band | Real user data. Backups matter here. |
| `ep-summer-smoke` dev | development and the test suite | Never public. The suite writes `[TEST]` rows to it. |

The demo lives as a **band inside the production database**, reset on a schedule,
rather than on the development branch. The development branch is where the test
suite writes and where schema changes land first: pointing the public demo at it
would show visitors test rows and break the demo every time a migration is in
flight.

The cost of this choice is that visitor writes land in the same database as real
customer data. That is acceptable because every query is already scoped by
`artist_id` and the demo band is just another tenant — but it does mean the reset
job must be scoped by slug and can never be a table-wide `DELETE`.

---

## Access and accounts

`/admin` (`SUPER_ADMIN_EMAILS`) needs two things: a session from a **user token**,
and that user's `users.email` on the allowlist (`api/_domain/admin.js:7-14`).

Both of Kevin's personal deployments have **zero `users` rows** — they log in
through the legacy band-password path, which returns no token at all
(`auth.js:161`). So on those two projects the allowlist can never match, and
setting `SUPER_ADMIN_EMAILS` there does nothing today.

`SUPER_ADMIN_EMAILS` therefore belongs on the **public deployment**, where real
accounts exist. Setting it on the personal projects only becomes useful once
those workspaces have `users` rows, which also means leaving the legacy login
behind. There is currently no supported path to create the first account for an
existing band: signup creates a *new* band, and invite needs an authenticated
admin. That gap needs a script before the personal projects can move.

---

## Required environment variables

Per project, because Vercel scopes them per project. A variable the code requires
must be set on **every** project:

```bash
vercel project ls                            # every project running this code
vercel env ls production --project <name>    # what that one actually has
```

| Variable | Public | Personal | Notes |
|---|---|---|---|
| `APP_SECRET` | yes | yes | `openssl rand -hex 32`, unique per project. Missing it takes the whole API down — see `tenant-onboarding.md`. |
| `DATABASE_URL` | yes | yes | Per environment. |
| `ARTIST_SLUG` | **no** | yes | Presence is what pins a deployment to one band. |
| `SUPER_ADMIN_EMAILS` | yes | not yet | Needs a `users` row to match. |
| `APP_ORIGIN`, `R2_*`, `RESEND_*`, `GEMINI_API_KEY` | yes | yes | As in `tenant-onboarding.md`. |
| `BETTERSTACK_TOKEN` | production only | production only | |

---

## Migration

Ordered so that nothing is public before it works. Steps 1–2 are independent of
the rest and fix a live outage.

1. **Set `APP_SECRET`** on `smartist-klang` and `smartist-demo`, then redeploy
   both. They are down until this is done.
2. **Apply the schema** to `ep-summer-smoke` main:
   `env DATABASE_URL='<url>' node scripts/apply_schema.js`.
   `ep-fancy-mud` was done on 2026-09-21.
3. **Rename the Vercel project** `smartist-demo` → something honest
   (`smartist-app`). Renaming does not change domains or deployments.
4. **Seed the `demo` band** in the production database and write
   `scripts/reset_demo.js` — scoped to the demo slug, never a table-wide delete.
   Schedule it from a GitHub Action rather than a Vercel cron: a cron costs a
   serverless function, and the Hobby plan allows 12, of which 11 are used and
   the twelfth is reserved for the billing webhook.
5. **Move the marketing content** into `app/landing.html`, and check what
   `smartist.studio` serves today is not lost.
6. **Move the domain.** Remove `smartist.studio` from the `smartist-studio`
   project, add it to the app project, update `APP_ORIGIN`. Short DNS gap.
7. **Remove `ARTIST_SLUG`** from the app project's production environment and
   redeploy. Only after this does signup become the front door.
8. **Set `SUPER_ADMIN_EMAILS`** on the app project and confirm `/admin` loads.
9. **Retire** the `kevinsieg/smartist-studio` repo (archive, don't delete).

Steps 6 and 7 are the only ones a visitor can see going wrong, and they are
reversible: re-adding the domain or the variable restores the previous behaviour.

---

## Open questions

- **Backups.** `ep-summer-smoke` main will hold other people's data. Neon's
  point-in-time restore window should be checked against what is acceptable to
  lose, before the first real signup.
- **First account on the personal projects.** Needs `scripts/create_user.js`
  before `salb` and `klang` can leave the legacy band-password login.
- **Neon credentials.** Both production strings have been pasted into terminal
  history and chat. Rotate them.
- **The demo reset cadence** is unset. Nightly is the assumption above.
