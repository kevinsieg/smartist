# Active work

## Current focus

All changes below are on `dev`, tested with seed data. Ready to push to Vercel Preview + merge to main.

---

## Completed features (awaiting merge to main)

### Songs page — mobile card view + desktop side panel

- `/songs` shows a sortable/filterable table on desktop (≥1025 px) or a card grid on mobile
- **Card view** (mobile): tap any card → bottom sheet panel with details + action buttons
- **View mode** (desktop): click any row → side panel slides in from the right with all song details
  - Side panel shows: inline audio players (`.mp3/.m4a/ogg/wav/flac`) for `listenUrl`/`playbackUrl`; streaming links as buttons; performance data (key, tempo, BPM, capo, length, lead); about data (genre, interpret, reference, author, comment, URLs); stats; rights (lang, GEMA, ISWC, ISRC); inline lyrics (fills remaining panel height)
  - Keyboard: `Esc` closes the panel
  - Selecting a different card closes the previous panel and opens the new one
- **Edit screen** (mobile + desktop): full-screen slide-in form for editing all song fields
- **Export CSV**: downloads all visible songs (respects active filter) as a CSV file
- **Active toggle**: click the active dot on any card to toggle `active` without opening the edit screen

Key implementation notes:
- `var` required in `songs.js` (not `let`/`const`) — `navigate()` in `common.js` re-executes page scripts in shared global scope
- `getVal(song, 'extra.foo')` safe nested accessor for JSONB `extra` field
- Edit screen CSS (`position: fixed`) lives in base styles — not inside a media query

### Artist logo — initials fallback

- If no `logoUrl` is set (or the image fails to load), the nav shows a coloured circle with the artist's initials
- `getInitials(name)` in `common.js`: 2 words → first letters; single word → first 2 chars
- Implemented via `img.onerror` + `.app-logo-initials--show` class toggle

### Venues / Organizers / Gigs — CRM expansion

- New pages: `/gigs`, `/venues`, `/organizers` — full CRUD with modal forms and sortable/filterable tables
- DB: `venues`, `organizers` tables; `gigs` extended with `venue_id`, `organizer_id`, `type`, `time_start`, `time_end`, `deleted`, `last_updated`
- Typeahead / inline-create for venue and organizer on gig form
- Soft-delete on venues and organizers (FK `ON DELETE RESTRICT` prevents deletion of referenced rows)
- Schema migration scripts run on dev DB (rename `bands→artists`, `gigs.name→title`, `gigs.notes→comment`; drop `gigs.venue` text column; add FK columns and new tables)

### Reusable table component (`createSortableList`)

`common.js` exports `createSortableList(options)`:
- Column-driven — define columns with `{ field, label, width, sortable, filterable, muted, type, render, actions }`
- Sort buttons per column, shared filter input across multiple instances (`filterInputId` / `_slFilterRegistry`)
- Multiple instances on one page share a single filter input
- Returns `{ setData(rows), refresh() }`
- Used by: `venues.js`, `organizers.js`, `gigs.js`

### Artist Hub (`/hub`)

- Platform connection management
- Predefined: Spotify, Apple Music, Deezer, Tidal, Qobuz, Amazon Music, YouTube Music, SoundCloud, Bandcamp, Audiomack, Boomplay, Instagram, Facebook, TikTok, X, YouTube, LinkedIn
- Custom platforms stored as `custom_<timestamp>` keys in `artists.config.platforms`
- Connect / edit / disconnect via single shared modal; saved via `PATCH /api/config`
- "Reach & tools" panels (analytics, smart link, EPK) are placeholders — not yet implemented

### OAuth login (Google + Facebook)

- `api/config.js` — `?action=google-url`, `?action=facebook-url`, `?action=oauth-callback`
- `vercel.json` — rewrite `/auth/callback` → `/api/config?action=oauth-callback`
- State signed with provider's own client secret (HMAC, 15-min expiry, base64url JSON)
- On success: generates magic token, redirects to `/?magic=<token>` — reuses home.js flow
- `app/js/home.js` — OAuth buttons rendered when `cfg.googleLogin`/`cfg.facebookLogin` true

---

## Production deployment

### 1. Schema migration (required — run in order against prod DB)

All three scripts are idempotent — each checks current state before acting. Run them in this order:

```bash
# Step 1: rename bands→artists, gigs.name→title, gigs.notes→comment
DATABASE_URL=<neon-prod-connection-string> node scripts/migrate_rename.js

# Step 2: apply schema additions (venues/organizers tables, venue_id, etc.)
DATABASE_URL=<neon-prod-connection-string> node scripts/migrate-schema.js

# Step 3: migrate gigs.venue text → venues rows + backfill venue_id, then drop venue column
DATABASE_URL=<neon-prod-connection-string> node scripts/migrate_venues.js
```

**What each script does on a prod DB:**

| Script | Effect |
|--------|--------|
| `migrate_rename.js` | `bands → artists`, `band_id → artist_id`, `gigs.name → title`, `gigs.notes → comment` |
| `migrate-schema.js` | creates `venues` + `organizers` tables; adds `venue_id`, `organizer_id`, `type`, `time_start/end`, `deleted`, `last_updated`; all other statements are no-ops |
| `migrate_venues.js` | reads `gigs.venue` text, creates `venues` rows, backfills `gigs.venue_id`, drops `gigs.venue` (safe to re-run) |

### 2. OAuth env vars (required for Google/Facebook login)

Add these in Vercel → Project Settings → Environment Variables (Production):

| Key | Where to get it |
|-----|-----------------|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → Credentials |
| `FACEBOOK_APP_ID` | Meta Developer Console |
| `FACEBOOK_APP_SECRET` | Meta Developer Console |
| `ARTIST_ADMIN_EMAIL` | Email address of the artist account |

Also register the OAuth redirect URI in each provider console:
- Google: `https://<your-domain>/auth/callback`
- Meta: `https://<your-domain>/auth/callback`

OAuth login buttons only appear when `cfg.googleLogin`/`cfg.facebookLogin` are true (derived from env vars in the API). If env vars are absent, the buttons simply don't show — no breakage.

### 3. Push and merge

```bash
git push origin dev
# Verify Vercel Preview deployment
# Then create PR: dev → main
```

---

## Known issues / next up

- Hub "Reach & tools" panels (analytics, smart link, EPK) are placeholders — not implemented
- OAuth env vars need to be set in Vercel (production + preview) before Google/Facebook login works
- OAuth app registrations needed in Google Cloud Console and Meta Developer Console
- `/profile`, `/dashboard`, `/touring` pages are stubs — not yet implemented

---

## Local dev

```bash
vercel dev   # port 3000
```

- Landing page: `http://localhost:3000/app/landing.html`
- Main app: `http://localhost:3000`
- Run tests: `node tests/unit.js` (unit); `cd tests && ARTIST_PASSWORD=… npm test` (integration)

## Branch model

| Branch | Vercel env | DB |
|--------|------------|----|
| `dev` | Preview | Neon dev |
| `main` | Production | Neon main |
