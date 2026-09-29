# Smartist — DIY Artist Tools

Song catalogue, setlist, gigs and venues management for musicians. Runs as a Vercel serverless application backed by a PostgreSQL database.

Hosted at [app.smartist.studio](https://app.smartist.studio); this repository is the full source. Why it is built the way it is: [`docs/architecture.md`](docs/architecture.md). Running several deployments: [`docs/deployment.md`](docs/deployment.md).

---

## Features

**Setlist generator** (`/setlist`) — filter songs by any field, energy slider, generate a random set to a target duration, optimise performance arc, drag-and-drop reorder, save to a gig.

**Song catalogue** (`/songs`) — in-cell editing, play count, song appearances, file attachments (audio, sheet music, playback track), AI-assisted lyrics suggest, change log with one-click restore.

**Setlist history** (`/setlist-history`) — browse all saved setlists by year, share as PDF by email, duplicate, open in stage view.

**Stage view** (`/stage?id=N`) — dark full-screen display with large song titles and key badges. Needs a session unless the band turns on *public stage links* in Settings (off by default).

**PRO** (`/pro-import`) — import PRO CSV exports (GEMA, Suisa, …) with dry-run preview and auto-matching against songs. `/gema-import` redirects to `/pro-import`.

---



## Architecture


| Layer        | Tech                                                               |
| ------------ | ------------------------------------------------------------------ |
| Hosting      | Vercel (serverless functions + static files, no build step)        |
| Database     | PostgreSQL — Neon serverless (free tier)                           |
| Auth         | Stateless HMAC-signed Bearer tokens (bcrypt passwords, Google sign-in, 30-min email links) |
| File storage | Cloudflare R2 (audio, sheet music, playback tracks)                |
| Email        | Resend REST API                                                    |
| PDF          | PDFKit                                                             |
| AI lyrics    | Google Gemini with web search grounding                            |


---



## Project setup



### Infrastructure overview


| Service       | Project / resource                | Purpose                                     |
| ------------- | --------------------------------- | ------------------------------------------- |
| Vercel        | one project                       | Hosts this app — linked to this GitHub repo |
| Neon          | one project (dev database)        | Development database                        |
| Neon          | one project (production database) | Production database                         |
| Cloudflare R2 | one bucket (production)           | Production file storage                     |
| Cloudflare R2 | one bucket (development)          | Development file storage                    |


---



## Environments



### Branch model


| Git branch        | Vercel environment | Domain                           | Database                |
| ----------------- | ------------------ | -------------------------------- | ----------------------- |
| `dev` *(default)* | Preview            | `<project>-git-dev-*.vercel.app` | Neon dev project        |
| `main`            | Production         | your custom domain               | Neon production project |


- Push to `dev` → Vercel auto-deploys to the Preview URL
- Push to `main` is blocked — only PR merges from `dev` trigger a production deployment



### Promotion workflow

```
work on dev  →  git push origin dev  →  verify on preview URL
→  open PR: dev → main  →  review + merge  →  Vercel deploys to production
```

If the PR includes a schema change, apply it to **every** production database before merging, then check the deployments:

```bash
DATABASE_URL=<prod-url> node scripts/apply_schema.js           # idempotent, asks before it connects
DATABASE_URL=<prod-url> node scripts/apply_schema.js --check   # "up to date"
curl https://<deployment>/api/config?action=health              # "schema":"current"
```



### Environment variables

Set these in the Vercel dashboard (Settings → Environment Variables). `.env.example` documents every one of them.

**Tenancy.** With `ARTIST_SLUG` set, a deployment serves that one band (its URLs, login page and config all resolve to it). Leave it unset for a multi-tenant deployment: anyone can sign up at `/signup`, and each band lives at `/<slug>/…`.

**Shared across all environments** — check "All Environments":


| Variable         | Value                                                                                |
| ---------------- | ------------------------------------------------------------------------------------ |
| `APP_SECRET`     | **Required.** HMAC key for session tokens — `openssl rand -hex 32`, a different value per deployment. Without it every API route returns 500. |
| `ARTIST_SLUG`    | Your artist's slug (e.g. `myband`) — omit for a multi-tenant deployment              |
| `R2_ACCOUNT_ID`  | Cloudflare account ID (found on R2 overview page, right sidebar — not the API token) |
| `RESEND_API_KEY` | Resend API key                                                                       |
| `RESEND_FROM`    | Sender address                                                                       |
| `GEMINI_API_KEY` | Google AI Studio key                                                                 |

**Optional:**

| Variable                                     | Effect |
| -------------------------------------------- | ------ |
| `CONTACT_EMAIL`                              | Where contact-form messages go (default `hi@smartist.studio`) |
| `SUPER_ADMIN_EMAILS`                         | Comma-separated logins allowed into `/admin` (each needs a `users` row) |
| `DEMO_ARTIST_SLUG`                           | Band the public `/demo` gate opens (default `demo`); demo visitors get a **member** session |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`  | Enables "Sign in with Google" — see `docs/oauth-setup.md` |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`    | Enables Facebook sign-in (new accounts only) |
| `FACEBOOK_TRUST_EMAIL=true`                  | Let Facebook sign into existing accounts and set up new ones by email. Facebook does not say whether an address is verified — read `docs/oauth-setup.md` first |


**Per-environment** — add two entries for each (one scoped to Production, one to Preview + Development):


| Variable               | Production                                                   | Preview + Development                          |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `DATABASE_URL`         | Production Neon connection string                            | Dev Neon connection string                     |
| `APP_ORIGIN`           | `https://yourdomain.com`                                     | Preview URL (`<project>-git-dev-*.vercel.app`) |
|                        | *Set it:* links in password-reset, invite and sign-up emails are built from it (fallback: the request's `Host`) | |
| `R2_BUCKET_NAME`       | Production bucket name                                       | Dev bucket name                                |
| `R2_ACCESS_KEY_ID`     | Prod R2 Access Key ID                                        | Dev R2 Access Key ID                           |
| `R2_SECRET_ACCESS_KEY` | Prod R2 Secret Access Key                                    | Dev R2 Secret Access Key                       |
| `R2_PUBLIC_URL`        | Prod bucket public URL (e.g. `https://media.yourdomain.com`) | Dev bucket public URL                          |


**Production only** — leave unset in Preview/Development:


| Variable            | Notes                                                |
| ------------------- | ---------------------------------------------------- |
| `BETTERSTACK_TOKEN` | Preview logs go to Vercel function dashboard instead |


---



## Quick start (new deployment)



### 1. Create a Vercel project

Link it to this GitHub repo. Framework: **Other** (no build step). Set the production branch to `main`.

### 2. Create databases

- **Production:** use an existing Neon project or create one
- **Development:** create a second Neon project; copy the pooler connection string

Run the setup wizard once per database to create the schema, the band and its admin login (email + password):

```bash
DATABASE_URL=<connection-string> node scripts/setup.js
```



### 3. Create R2 buckets

Create two Cloudflare R2 buckets (production + dev). For each:

1. Enable public access via a **custom domain** (R2 bucket → Settings → Custom Domains) — this becomes `R2_PUBLIC_URL`
2. Generate an API token under **R2 → Manage R2 API Tokens** (not Profile → API Tokens) with **Object Read & Write** scoped to that bucket
3. The token gives you an **Access Key ID** and **Secret Access Key** — these are `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`
4. Set the CORS policy on the bucket (R2 bucket → Settings → CORS Policy) — use explicit header names, not `"*"` (R2 ignores the wildcard for `Access-Control-Allow-Headers`):

```json
[
  {
    "AllowedOrigins": ["https://yourdomain.com"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Authorization", "X-Amz-Content-Sha256", "X-Amz-Date", "X-Amz-Security-Token"],
    "MaxAgeSeconds": 3600
  }
]
```

> **Note:** `R2_ACCOUNT_ID` is the Cloudflare Account ID (visible on the R2 overview page), not any API token value. `cfat_…` tokens from Profile → API Tokens are for the Cloudflare REST API and will not work for S3-compatible R2 access.



### 4. Set environment variables

Add all variables from the table above in the Vercel dashboard. See `.env.example` for format and free-tier links.

### 5. Push the dev branch

```bash
git push -u origin dev
```

Vercel will deploy the Preview environment. Copy the stable preview URL (`smartist-git-dev-*.vercel.app`) and add it as `APP_ORIGIN` for Preview + Development.

### 6. Run locally

Needs Node 22 and the Vercel CLI (`npm i -g vercel`).

```bash
npm ci                       # API dependencies (the only install; tests/ has none of its own)
npm run test:unit            # unit tests — no database needed
npm run test:all             # + API and browser tests on a local stack (own Postgres, no Vercel login)
vercel env pull .env.local   # pulls Preview vars — copy values into .env (vercel dev reads .env, not .env.local)
vercel dev                   # starts local server on port 3000, against the dev database
```

`npm run dev:up` starts the same local stack as CI (see `tests/README.md`) and
prints its sign-in: open `http://localhost:3000/login` with `dev@example.test` /
`local-password`.

Seed the dev database with fake gigs, setlists, songs, and sample GEMA rows (targets the artist from `ARTIST_SLUG`, or the first artist in the DB if unset — run `setup.js` first):

```bash
node scripts/seed.js --force
```

Set `ARTIST_SLUG` in `.env` or `.env.local` to match the artist you created with `setup.js`. Restart `vercel dev` if you change env files.

---



## Artist config

The `config` column on `artists` (JSONB) controls which fields appear in the UI. The setup wizard builds it interactively. To update it directly:

```sql
UPDATE artists SET config = config || '{
  "logoUrl": "https://yourdomain.com/img/band-logo.png",
  "displayFields": [
    { "field": "title",      "label": "Song"   },
    { "field": "key",        "label": "Key"    },
    { "field": "genre",      "label": "Genre"  },
    { "field": "length_min", "label": "Length" },
    { "field": "extra.capo", "label": "Capo"   }
  ],
  "filterFields": [
    { "field": "key",        "label": "Key"    },
    { "field": "genre",      "label": "Genre"  },
    { "field": "extra.capo", "label": "Capo", "type": "integer" }
  ]
}'::jsonb WHERE slug = 'yourband';
```


| Key                | Description                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `logoUrl`          | URL to the band logo shown in the nav and print header                                                   |
| `displayFields`    | Ordered columns in the songs table. `field` can be a standard column or `extra.<name>` for custom fields |
| `filterFields`     | Filter buttons in the setlist generator. Add `"type": "integer"` for numeric range inputs                |
| `gemaIpNameNumber` | Your GEMA IP-Name-Nr — pre-fills the GEMA import and classifies your own compositions                    |


---



## Database schema

See [DATABASE.md](DATABASE.md) for the full model, design decisions, and query patterns.


| Table               | Purpose                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `artists`           | Slug, name, UI config (JSONB); `password_hash` is unused (retired band password) |
| `songs`             | Catalogue — standard fields + `extra` JSONB; soft-delete via `deleted` flag |
| `venues`            | CRM venue directory — soft-delete, linked to gigs via FK                    |
| `organizers`        | CRM organizer/promoter directory — soft-delete, linked to gigs via FK       |
| `gigs`              | Performance events linked to venues and organizers                          |
| `setlists`          | Saved setlists, optionally linked to a gig                                  |
| `setlist_songs`     | Junction: setlist ↔ songs with position ordering                            |
| `song_logs`         | Append-only audit log — full JSON snapshot per change                       |
| `gema_works`        | GEMA work registrations, auto-linked to songs by title                      |
| `gema_rightholders` | Rightholders (composers, publishers) per work                               |
| `song_arrangements` | Versioned arrangement charts per song (used by stage view)                  |
| `users`             | Logins per workspace — email is the identity across workspaces, role per band |
| `subscribers`       | Contact-form / demo-gate addresses and pending sign-up tokens                |
| `rate_limits`       | Sliding-window counters for login, reset, invite and upload endpoints        |


---



## API

All endpoints live under `/api/:artist/`. Auth uses `Authorization: Bearer <token>` — a session token from login (email + password, or Google/Facebook). Full OpenAPI 3.0 spec at `/openapi.json`; interactive docs at `/api/docs`.

A workspace is private. **Auth** column: ✓ = session required; *catalogue* / *stage* = also open without a session when the band turned on *public catalogue* / *public stage links* in Settings (both off by default); — = no session needed.

| Method | Endpoint                          | Auth | Purpose                                                                                      |
| ------ | --------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| GET    | `/api/config`                     | —    | Band name and branding; songs and counts only with a session or a public catalogue           |
| POST   | `/api/:artist/auth`               | —    | Log in, get a session token                                                                  |
| POST   | `/api/:artist/request-reset`      | —    | Email a link to set a new password                                                           |
| GET    | `/api/:artist/songs`              | ✓ / catalogue | Songs with play stats and GEMA data                                                 |
| POST   | `/api/:artist/songs`              | ✓    | Create song; also handles lyrics save/delete and media upload via body fields                |
| PATCH  | `/api/:artist/songs`              | ✓    | Batch update songs (`extra.*Url` values must be http(s))                                     |
| GET    | `/api/:artist/songs/:id`          | ✓ / catalogue / stage | Single song (used by stage view)                                            |
| DELETE | `/api/:artist/songs/:id`          | ✓    | Soft-delete song                                                                             |
| POST   | `/api/:artist/songs/:id/restore`  | ✓    | Restore from audit log                                                                       |
| GET    | `/api/:artist/songs/:id/setlists` | ✓ / catalogue | Setlists that include this song                                                     |
| GET    | `/api/:artist/songs/:id/gema`     | ✓    | GEMA works + rightholders for this song                                                      |
| GET    | `/api/:artist/setlists`           | ✓    | List setlists with song count                                                                |
| POST   | `/api/:artist/setlists`           | ✓    | Create (`{song_ids}`), duplicate (`{duplicate_id}`), or share by email (`{share_id, email}`) |
| GET    | `/api/:artist/setlists/:id`       | ✓ / stage | Setlist detail with ordered songs                                                       |
| PUT    | `/api/:artist/setlists/:id`       | ✓    | Update metadata + song list                                                                  |
| GET    | `/api/:artist/gigs`               | ✓ / catalogue | List gigs with venue and organizer names (`?format=ics` for a calendar feed)        |
| POST   | `/api/:artist/gigs`               | ✓    | Create gig                                                                                   |
| GET    | `/api/:artist/gigs/:id`           | ✓ / catalogue | Single gig; add `?refs` for linked setlists, venue, organizer                       |
| PUT    | `/api/:artist/gigs/:id`           | ✓    | Update gig                                                                                   |
| DELETE | `/api/:artist/gigs/:id`           | ✓    | Soft-delete or hard-delete gig                                                               |
| GET    | `/api/:artist/venues`             | ✓    | List venues (paginated, filterable) — Pro plan                                               |
| POST   | `/api/:artist/venues`             | ✓    | Create venue                                                                                 |
| GET    | `/api/:artist/venues/:id`         | ✓    | Single venue; add `?refs` for linked gigs                                                    |
| PUT    | `/api/:artist/venues/:id`         | ✓    | Update venue                                                                                 |
| DELETE | `/api/:artist/venues/:id`         | ✓    | Soft-delete or hard-delete venue                                                             |
| GET    | `/api/:artist/organizers`         | ✓    | List organizers (paginated, filterable) — Pro plan                                           |
| POST   | `/api/:artist/organizers`         | ✓    | Create organizer                                                                             |
| GET    | `/api/:artist/organizers/:id`     | ✓    | Single organizer; add `?refs` for linked gigs                                                |
| PUT    | `/api/:artist/organizers/:id`     | ✓    | Update organizer                                                                             |
| DELETE | `/api/:artist/organizers/:id`     | ✓    | Soft-delete or hard-delete organizer                                                         |
| GET    | `/api/:artist/export`             | ✓    | Full data export: ZIP of one CSV per table (empty/internal columns dropped)                  |

IDs in request bodies (`song_ids`, `gig_id`, `venue_id`, `organizer_id`) must belong to the same band; anything else is refused with 400.


---



## Scripts

See [scripts/README.md](scripts/README.md) for usage details.


| Script                        | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `scripts/setup.js`            | Interactive wizard: schema + band + its admin user + field config        |
| `scripts/apply_schema.js`     | Apply `schema.sql` to the database in `DATABASE_URL` (idempotent)        |
| `scripts/seed.js`             | Populate the dev database with test data (wipe + reseed with `--force`)  |
| `scripts/create_user.js`      | First login for a band, or set an account's password from the CLI        |
| `scripts/plans.js`            | List bands with plan and usage; grant a plan; recount storage            |
| `scripts/import_songs.js`     | Bulk-import songs from a JSON file (`--artist <slug>`)                   |
| `scripts/import_venues.js`    | Bulk-import venues from a CSV file (`--artist <slug>`)                   |
| `scripts/import_gema.js`      | Import GEMA CSV exports (Werkinformationen, Identifikatoren, Beteiligte) |
| `scripts/delete_artist.js`    | Delete one artist and all its data (`--artist <slug>`, asks to confirm)  |
| `scripts/demo_reset.js`       | Snapshot / restore the public demo band (`scripts/demo_seed.json`)       |
| `scripts/schema.sql`          | The schema, idempotent — apply with `apply_schema.js`                    |

---

## Translations

The app ships in English, French and German. The French and German strings were a machine-translated first pass; corrections from native speakers are welcome (`app/i18n/*.json`, identical key sets enforced by `node tests/unit.js`).

## License

[GNU Affero General Public License v3.0](LICENSE) or later. You may use, change and self-host smartist freely; if you run a modified version as a service for others, you must offer them its source.
