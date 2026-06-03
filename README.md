# Smartist — DIY Artist Tools

Song catalogue, setlist, gigs and venues management for musicians. Runs as a Vercel serverless application backed by a PostgreSQL database.

---

## Features

**Setlist generator** (`/setlist`) — filter songs by any field, energy slider, generate a random set to a target duration, optimise performance arc, drag-and-drop reorder, save to a gig.

**Song catalogue** (`/songs`) — in-cell editing, play count, song appearances, file attachments (audio, sheet music, playback track), AI-assisted lyrics suggest, change log with one-click restore.

**Setlist history** (`/setlist-history`) — browse all saved setlists by year, share as PDF by email, duplicate, open in stage view.

**Stage view** (`/stage?id=N`) — dark full-screen display with large song titles and key badges. No auth required.

**PRO** (`/pro-import`) — import PRO CSV exports (GEMA, Suisa, …) with dry-run preview and auto-matching against songs. `/gema-import` redirects to `/pro-import`.

---

## Architecture

| Layer | Tech |
|-------|------|
| Hosting | Vercel (serverless functions + static files, no build step) |
| Database | PostgreSQL — Neon serverless (free tier) |
| Auth | Stateless Bearer token — bcrypt password or 30-min HMAC magic link |
| File storage | Cloudflare R2 (audio, sheet music, playback tracks) |
| Email | Resend REST API |
| PDF | PDFKit |
| AI lyrics | Google Gemini with web search grounding |

---

## Project setup

### Infrastructure overview

| Service | Project / resource | Purpose |
|---|---|---|
| Vercel | one project | Hosts this app — linked to this GitHub repo |
| Neon | one project (dev database) | Development database |
| Neon | one project (production database) | Production database |
| Cloudflare R2 | one bucket (production) | Production file storage |
| Cloudflare R2 | one bucket (development) | Development file storage |

---

## Environments

### Branch model

| Git branch | Vercel environment | Domain | Database |
|---|---|---|---|
| `dev` *(default)* | Preview | `<project>-git-dev-*.vercel.app` | Neon dev project |
| `main` | Production | your custom domain | Neon production project |

- Push to `dev` → Vercel auto-deploys to the Preview URL
- Push to `main` is blocked — only PR merges from `dev` trigger a production deployment

### Promotion workflow

```
work on dev  →  git push origin dev  →  verify on preview URL
→  open PR: dev → main  →  review + merge  →  Vercel deploys to production
```

If the PR includes a schema change, apply it to the production database after merging:
```bash
psql $PROD_DATABASE_URL < scripts/schema.sql
```

### Environment variables

Set these in the Vercel dashboard (Settings → Environment Variables).

**Shared across all environments** — check "All Environments":

| Variable | Value |
|---|---|
| `ARTIST_SLUG` | Your artist's slug (e.g. `myband`) |
| `R2_ACCOUNT_ID` | Cloudflare account ID (found on R2 overview page, right sidebar — not the API token) |
| `RESEND_API_KEY` | Resend API key |
| `RESEND_FROM` | Sender address |
| `GEMINI_API_KEY` | Google AI Studio key |

**Per-environment** — add two entries for each (one scoped to Production, one to Preview + Development):

| Variable | Production | Preview + Development |
|---|---|---|
| `DATABASE_URL` | Production Neon connection string | Dev Neon connection string |
| `APP_ORIGIN` | `https://yourdomain.com` | Preview URL (`<project>-git-dev-*.vercel.app`) |
| `ARTIST_ADMIN_EMAIL` | `you@yourdomain.com` | `you+dev@yourdomain.com` |
| `R2_BUCKET_NAME` | Production bucket name | Dev bucket name |
| `R2_ACCESS_KEY_ID` | Prod R2 Access Key ID | Dev R2 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Prod R2 Secret Access Key | Dev R2 Secret Access Key |
| `R2_PUBLIC_URL` | Prod bucket public URL (e.g. `https://media.yourdomain.com`) | Dev bucket public URL |

**Production only** — leave unset in Preview/Development:

| Variable | Notes |
|---|---|
| `BETTERSTACK_TOKEN` | Preview logs go to Vercel function dashboard instead |

---

## Quick start (new deployment)

### 1. Create a Vercel project

Link it to this GitHub repo. Framework: **Other** (no build step). Set the production branch to `main`.

### 2. Create databases

- **Production:** use an existing Neon project or create one
- **Development:** create a second Neon project; copy the pooler connection string

Run the setup wizard once per database to create the schema and band row:

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

```bash
vercel env pull .env.local   # pulls Preview vars — copy values into .env (vercel dev reads .env, not .env.local)
vercel dev                   # starts local server on port 3000
```

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

| Key | Description |
|-----|-------------|
| `logoUrl` | URL to the band logo shown in the nav and print header |
| `displayFields` | Ordered columns in the songs table. `field` can be a standard column or `extra.<name>` for custom fields |
| `filterFields` | Filter buttons in the setlist generator. Add `"type": "integer"` for numeric range inputs |
| `gemaIpNameNumber` | Your GEMA IP-Name-Nr — pre-fills the GEMA import and classifies your own compositions |

---

## Database schema

See [DATABASE.md](DATABASE.md) for the full model, design decisions, and query patterns.

| Table | Purpose |
|-------|---------|
| `artists` | Slug, name, bcrypt password hash, UI config (JSONB) |
| `songs` | Catalogue — standard fields + `extra` JSONB; soft-delete via `deleted` flag |
| `venues` | CRM venue directory — soft-delete, linked to gigs via FK |
| `organizers` | CRM organizer/promoter directory — soft-delete, linked to gigs via FK |
| `gigs` | Performance events linked to venues and organizers |
| `setlists` | Saved setlists, optionally linked to a gig |
| `setlist_songs` | Junction: setlist ↔ songs with position ordering |
| `song_logs` | Append-only audit log — full JSON snapshot per change |
| `gema_works` | GEMA work registrations, auto-linked to songs by title |
| `gema_rightholders` | Rightholders (composers, publishers) per work |

---

## API

All endpoints live under `/api/:artist/`. Auth uses `Authorization: Bearer <token>` (artist password or 30-min magic token). Full OpenAPI 3.0 spec at `/openapi.json`; interactive docs at `/api/docs`.

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/config` | — | Artist config + all active songs |
| POST | `/api/:artist/auth` | — | Verify password, get token |
| POST | `/api/:artist/request-reset` | — | Send magic login link by email |
| GET | `/api/:artist/songs` | — | Songs with play stats and GEMA data |
| POST | `/api/:artist/songs` | ✓ | Create song; also handles lyrics save/delete and media upload via body fields |
| PATCH | `/api/:artist/songs` | ✓ | Batch update songs |
| GET | `/api/:artist/songs/:id` | — | Single song (used by stage view) |
| DELETE | `/api/:artist/songs/:id` | ✓ | Soft-delete song |
| POST | `/api/:artist/songs/:id/restore` | ✓ | Restore from audit log |
| GET | `/api/:artist/songs/:id/setlists` | — | Setlists that include this song |
| GET | `/api/:artist/songs/:id/gema` | — | GEMA works + rightholders for this song |
| GET | `/api/:artist/setlists` | — | List setlists with song count |
| POST | `/api/:artist/setlists` | ✓ | Create (`{song_ids}`), duplicate (`{duplicate_id}`), or share by email (`{share_id, email}`) |
| GET | `/api/:artist/setlists/:id` | — | Setlist detail with ordered songs |
| PUT | `/api/:artist/setlists/:id` | ✓ | Update metadata + song list |
| GET | `/api/:artist/gigs` | — | List gigs with venue and organizer names |
| POST | `/api/:artist/gigs` | ✓ | Create gig |
| GET | `/api/:artist/gigs/:id` | — | Single gig; add `?refs` for linked setlists, venue, organizer |
| PUT | `/api/:artist/gigs/:id` | ✓ | Update gig |
| DELETE | `/api/:artist/gigs/:id` | ✓ | Soft-delete or hard-delete gig |
| GET | `/api/:artist/venues` | — | List venues (paginated, filterable) |
| POST | `/api/:artist/venues` | ✓ | Create venue |
| GET | `/api/:artist/venues/:id` | — | Single venue; add `?refs` for linked gigs |
| PUT | `/api/:artist/venues/:id` | ✓ | Update venue |
| DELETE | `/api/:artist/venues/:id` | ✓ | Soft-delete or hard-delete venue |
| GET | `/api/:artist/organizers` | — | List organizers (paginated, filterable) |
| POST | `/api/:artist/organizers` | ✓ | Create organizer |
| GET | `/api/:artist/organizers/:id` | — | Single organizer; add `?refs` for linked gigs |
| PUT | `/api/:artist/organizers/:id` | ✓ | Update organizer |
| DELETE | `/api/:artist/organizers/:id` | ✓ | Soft-delete or hard-delete organizer |
| GET | `/api/:artist/export` | ✓ | Full data export as JSON (all 9 artist-scoped tables) |

---

## Scripts

See [scripts/README.md](scripts/README.md) for usage details.

| Script | Purpose |
|--------|---------|
| `scripts/setup.js` | Interactive wizard: schema + artist creation + field config |
| `scripts/seed.js` | Populate the dev database with test data (wipe + reseed with `--force`) |
| `scripts/import_songs.js` | Bulk-import songs from a JSON file (`--artist <slug>`) |
| `scripts/import_venues.js` | Bulk-import venues from a CSV file (`--artist <slug>`) |
| `scripts/import_gigs.js` | Import historical gig data (band-one.example source — adapt for other artists) |
| `scripts/import_gema.js` | Import GEMA CSV exports (Werkinformationen, Identifikatoren, Beteiligte) |
| `scripts/schema.sql` | Raw schema — apply directly with `psql` if preferred |
