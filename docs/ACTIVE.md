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

## Known issues / next up

- Hub "Reach & tools" panels (analytics, smart link, EPK) are placeholders — not implemented
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
