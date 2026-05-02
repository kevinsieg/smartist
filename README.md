# Smartist — Band Tools

Setlist management and song catalogue for bands. Runs as a Vercel serverless application backed by a PostgreSQL database.

---

## Features

**Setlist generator** (`/setlist`) — filter songs by any field, energy slider, generate a random set to a target duration, optimise performance arc, drag-and-drop reorder, save to a gig.

**Song catalogue** (`/songs`) — in-cell editing, play count, song appearances, file attachments (audio, sheet music, playback track), AI-assisted lyrics suggest, change log with one-click restore.

**Setlist history** (`/setlist-history`) — browse all saved setlists by year, share as PDF by email, duplicate, open in stage view.

**Stage view** (`/stage?id=N`) — dark full-screen display with large song titles and key badges. No auth required.

**GEMA import** (`/gema-import`) — import GEMA CSV exports (Werkinformationen, Identifikatoren, Beteiligte) with dry-run preview and auto-matching against songs.

---

## Architecture

| Layer | Tech |
|-------|------|
| Hosting | Vercel (serverless functions + static files, no build step) |
| Database | PostgreSQL — Neon serverless (free tier works) |
| Auth | Stateless Bearer token — bcrypt password or 30-min HMAC magic link |
| File storage | Cloudflare R2 (audio, sheet music, playback tracks) |
| Email | Resend REST API |
| PDF | PDFKit |
| AI lyrics | Google Gemini with web search grounding |

---

## Quick start

### Prerequisites

- [Neon](https://neon.tech) database (free tier)
- [Vercel](https://vercel.com) project linked to this repo (framework: Other — no build step)
- `vercel` CLI: `npm i -g vercel`

### 1. Run the setup wizard

```bash
DATABASE_URL=<neon-connection-string> node scripts/setup.js
```

The wizard creates the schema, creates a band (slug + password), and configures which song fields appear in the UI. Run it once per environment.

### 2. Set environment variables

Add these to your Vercel project (Settings → Environment Variables) and to a local `.env` file for `vercel dev`:

```
DATABASE_URL=         # Neon connection string
BAND_SLUG=            # Slug you chose in the wizard
APP_ORIGIN=           # Your deployment URL, e.g. https://yourband.example.com
RESEND_API_KEY=       # Resend — for email (optional)
RESEND_FROM=          # Sender address, e.g. Band Name <noreply@yourdomain.com>
BAND_ADMIN_EMAIL=     # The only address that can receive a magic login link
GEMINI_API_KEY=       # Google AI Studio — for AI lyrics suggest (optional, free)
R2_ACCOUNT_ID=        # Cloudflare R2 — for file uploads (optional)
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=
BETTERSTACK_TOKEN=    # Better Stack — for cloud logging (optional)
```

See `.env.example` for descriptions and free-tier links.

### 3. Run locally

```bash
vercel dev
```

### 4. Deploy

Push to `main` — Vercel auto-deploys. Or: `vercel --prod`.

---

## Band config

The `config` column on `bands` (JSONB) controls which fields appear in the UI. The setup wizard builds it interactively. To update it directly:

```sql
UPDATE bands SET config = config || '{
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
| `bands` | Slug, name, bcrypt password hash, UI config (JSONB) |
| `songs` | Catalogue — standard fields + `extra` JSONB; soft-delete via `deleted` flag |
| `gigs` | Performance events (name, date, venue) |
| `setlists` | Saved setlists, optionally linked to a gig |
| `setlist_songs` | Junction: setlist ↔ songs with position ordering |
| `song_logs` | Append-only audit log — full JSON snapshot per change |
| `gema_works` | GEMA work registrations, auto-linked to songs by title |
| `gema_rightholders` | Rightholders (composers, publishers) per work |

---

## API

All endpoints live under `/api/:band/`. Auth uses `Authorization: Bearer <token>` (band password or 30-min magic token). Full OpenAPI 3.0 spec at `/openapi.json`; interactive docs at `/api/docs`.

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/config` | — | Band config + all active songs |
| POST | `/api/:band/auth` | — | Verify password, get token |
| POST | `/api/:band/request-reset` | — | Send magic login link by email |
| GET | `/api/:band/songs` | — | Songs with play stats and GEMA data |
| POST | `/api/:band/songs` | ✓ | Create song |
| PATCH | `/api/:band/songs` | ✓ | Batch update songs |
| DELETE | `/api/:band/songs/:id` | ✓ | Soft-delete song |
| POST | `/api/:band/songs/:id/restore` | ✓ | Restore from audit log |
| GET | `/api/:band/setlists` | — | List setlists with song count |
| POST | `/api/:band/setlists` | ✓ | Create setlist |
| PUT | `/api/:band/setlists/:id` | ✓ | Update metadata + song list |
| POST | `/api/:band/setlists/:id/share` | ✓ | Email setlist as PDF |
| POST | `/api/:band/setlists/:id/duplicate` | ✓ | Clone setlist |
| GET | `/api/:band/gigs` | — | List gigs |
| POST | `/api/:band/gigs` | ✓ | Create gig |
| GET | `/api/:band/export` | ✓ | Full data export as JSON |

---

## Scripts

See [scripts/README.md](scripts/README.md) for usage details.

| Script | Purpose |
|--------|---------|
| `scripts/setup.js` | Interactive wizard: schema + band creation + field config |
| `scripts/import_songs.js` | Bulk-import songs from a JSON file |
| `scripts/import_gema.js` | Import GEMA CSV exports (Werkinformationen, Identifikatoren, Beteiligte) |
| `scripts/schema.sql` | Raw schema — apply directly with `psql` if preferred |
