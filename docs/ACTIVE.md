# Active work

## Current focus

`dev` branch is ahead of `main`. All features below are tested on the dev DB. Ready to merge to main.

---

## Completed features (awaiting merge to main)

### Songs page — mobile card view + desktop side panel

- `/songs` shows a sortable/filterable table on desktop (≥1025 px) or a card grid on mobile
- **Card view** (mobile): tap any card → bottom sheet panel with details + action buttons
- **View mode** (desktop): click any row → side panel slides in from the right with all song details
  - Inline audio players for `listenUrl`/`playbackUrl`; streaming links as buttons; performance data; stats; rights; inline lyrics
  - Keyboard: `Esc` closes the panel
- **Edit screen** (mobile + desktop): full-screen slide-in form for editing all song fields
- **Export CSV**: downloads all visible songs (respects active filter)
- **Active toggle**: click the active dot on any card to toggle `active` without opening the edit screen

Key implementation notes:
- `var` required in `songs.js` (not `let`/`const`) — `navigate()` in `common.js` re-executes page scripts in shared global scope
- `getVal(song, 'extra.foo')` safe nested accessor for JSONB `extra` field

### Venues / Organizers / Gigs — CRM expansion

- New pages: `/gigs`, `/venues`, `/organizers` — full CRUD with accordion edit UX and sortable/filterable tables
- Gig `location` field added (free-text, separate from `venues`)
- DB: `venues`, `organizers` tables; `gigs` extended with `venue_id`, `organizer_id`, `type`, `time_start`, `time_end`, `location`, `deleted`, `last_updated`
- Typeahead / inline-create for venue and organizer on gig form
- Soft-delete on venues and organizers (FK `ON DELETE RESTRICT` prevents deletion of referenced rows)
- Bug fix: cascade setlist delete on gig delete was missing `AND artist_id` filter

### Export — all tables

`GET /api/:artist/export` now returns all 9 artist-scoped tables: `songs`, `gigs`, `setlists`, `setlist_songs`, `venues`, `organizers`, `gema_works`, `gema_rightholders`, `song_logs`.

### Reusable table component (`createSortableList`)

`common.js` exports `createSortableList(options)` — column-driven sortable/filterable table. Used by `venues.js`, `organizers.js`, `gigs.js`.

### Artist Hub (`/hub`)

Platform connection management (Spotify, Apple Music, Instagram, etc.). Custom platforms stored in `artists.config.platforms`. Connect / edit / disconnect via shared modal.

### Artist logo — initials fallback

If no `logoUrl` is set or image fails to load, nav shows a coloured circle with the artist's initials.

### OAuth login (Google + Facebook)

Google/Facebook login buttons on the login page when `cfg.googleLogin`/`cfg.facebookLogin` are true. Reuses magic-link flow on success.

### Multi-tenant infrastructure

Renamed 2026-09-22. See `2026-09-22-deployment-architecture.md` for the target state.

- `smartist-salb` → `smartist.salmons.fr` (live — Neon `smartist-kevin`, `ARTIST_SLUG=salb`)
- `smartist-klang` → `smartist.kevinklang.de` (live — same DB, `ARTIST_SLUG=klang`; ⚠ down until `APP_SECRET` is set)
- `smartist` → `demo.smartist.studio`, `app.smartist.studio` planned (the product — Neon `smartist`; ⚠ down until `APP_SECRET` is set)
- `smartist-website` → `smartist.studio` (live — static marketing site, separate repo, no env vars)

---

## Known issues / next up

- Hub "Reach & tools" panels (analytics, smart link, EPK) are placeholders — not implemented
- `/profile`, `/dashboard`, `/touring` pages are stubs — not yet implemented
- `smartist-klang` DNS: move `kevinklang.de` nameservers to Cloudflare (currently on Dogado), then add CNAME `smartist → cname.vercel-dns.com` and DMARC `_dmarc → v=DMARC1; p=reject;`

---

## Local dev

```bash
vercel dev   # port 3000 — reads .env, not .env.local
```

- Main app: `http://localhost:3000`
- Run tests: `node tests/unit.js` (unit); `cd tests && ARTIST_PASSWORD=… npm test` (integration)

## Branch model

| Branch | Vercel env | DB |
|--------|------------|----|
| `dev` | Preview (smartist-salmons) | Neon dev |
| `main` | Production (smartist-salmons) | Neon main |
