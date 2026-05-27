# Database Model

PostgreSQL (Neon serverless). All tables are scoped to an `artist_id` — a single database supports multiple independent artists.

Schema file: `scripts/schema.sql` (idempotent — safe to re-run against any database version to apply missing tables/columns without data loss).

---

## Entity-relationship diagram

```
artists
  │
  ├─── songs ──────────────────────── song_logs
  │      │
  │      └─(via setlist_songs)──── setlists ──── gig_id (optional) ──┐
  │                                                                    │
  ├─── venues ◄──── gigs.venue_id ─── gigs ◄──────────────────────────┘
  │                                    │
  └─── organizers ◄── gigs.organizer_id┘
  │
  ├─── gema_works ──── gema_rightholders
  ├─── rate_limits  (keyed by IP — not artist-scoped)
  └─── subscribers  (landing/demo leads — not artist-scoped)
```

```
┌────────────────────────────┐
│           artists           │
│ id  slug  name  config JSONB│
│ password_hash  social_links │
└────┬───────────────────────┘
     │ 1 : n (artist_id FK, CASCADE DELETE on all child tables)
     │
     ├──────────────┬──────────────┬──────────────────┐
     │              │              │                  │
     ▼              ▼              ▼                  ▼
  songs           venues       organizers           gigs
  (soft-delete)   (soft-delete) (soft-delete)  ──► venue_id FK (RESTRICT)
     │                                         ──► organizer_id FK (RESTRICT)
     │                                              │ 1 : n (optional)
     ▼                                              ▼
  song_logs                                      setlists
  setlist_songs ◄─────────────────────────────── (gig_id FK, SET NULL)
  gema_works ──► gema_rightholders
```

---

## Table reference

### `artists`

One row per artist. The API is keyed by `slug`; the app gets its slug from `ARTIST_SLUG`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `slug` | text UNIQUE NOT NULL | URL-safe identifier used in all API routes |
| `name` | text NOT NULL | Display name |
| `password_hash` | text NOT NULL | bcrypt hash; plain password never stored |
| `config` | jsonb DEFAULT `{}` | UI config — see [Artist config](#artist-config) |
| `social_links` | jsonb DEFAULT `{}` | Legacy social links field (platforms now in `config.platforms`) |

---

### `songs`

Song catalogue. Soft-deleted songs (`deleted = true`) are kept so setlist history and audit log remain intact.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | |
| `title` | text NOT NULL | |
| `active` | boolean DEFAULT true | Controls visibility in setlist generator |
| `key` | text | Musical key, e.g. `G`, `Am` |
| `genre` | text | Genre or style grouping |
| `tempo` | text | Descriptive tempo: `Slow`, `Medium`, `Fast` |
| `bpm` | integer | Beats per minute |
| `length_min` | real | Duration in decimal minutes — `3.5` = 3:30 |
| `interpret` | text | Main performer associated with the song |
| `reference_interpret` | text | Artist of a specific reference recording |
| `comment` | text | Free-form notes |
| `extra` | jsonb DEFAULT `{}` | Artist-specific fields (capo, isrc, language, listenUrl, …) |
| `deleted` | boolean NOT NULL DEFAULT false | Soft-delete flag |

**Indexes:** `songs_artist_id_idx`, `songs_band_active_idx (artist_id, active)`

---

### `venues`

CRM-style venue database. Linked from gigs via `venue_id`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | |
| `name` | text NOT NULL | |
| `deleted` | boolean NOT NULL DEFAULT false | Soft-delete |
| `alive` | boolean DEFAULT true | Venue still operating |
| `activated` | boolean DEFAULT false | Actively booked/approached |
| `declined` | boolean DEFAULT false | Venue declined to book |
| `status` | text | Free-form status label (e.g. `Active`, `Prospect`, `Confirmed`) |
| `category` | text | Type: `club`, `festival`, `placeholder`, `legacy`, … |
| `postcode` | text | |
| `city` | text | |
| `state` | text | |
| `country` | text | |
| `generic_email` | text | General booking email |
| `website` | text | |
| `social_links` | jsonb DEFAULT `{}` | |
| `last_communication` | date | |
| `booking_channel` | text | How to reach them: `Email`, `Agency`, … |
| `number_of_cold_contacts` | integer DEFAULT 0 | |
| `turnus` | text | Booking frequency hint |
| `remuneration` | text | Pay notes |
| `overnight` | boolean DEFAULT false | Accommodation available |
| `season` | text | Active season |
| `preferred_period` | text | |
| `comment` | text | |
| `deadline` | date | |
| `main_genre` | text | Primary genre this venue books |
| `subgenres` | text[] | |
| `size` | integer | Capacity |
| `language` | text | |
| `last_updated` | timestamptz DEFAULT NOW() | |

**Indexes:** `venues_artist_id_idx`

---

### `organizers`

Contacts who organize or book gigs (agencies, festival orgs, promoters).

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | |
| `name` | text NOT NULL | |
| `deleted` | boolean NOT NULL DEFAULT false | Soft-delete |
| `type` | text | `Agency`, `Festival`, `Self`, … |
| `email` | text | |
| `phone` | text | |
| `website` | text | |
| `social_links` | jsonb DEFAULT `{}` | |
| `city` | text | |
| `country` | text | |
| `last_communication` | date | |
| `comment` | text | |
| `extra` | jsonb DEFAULT `{}` | Extensible fields |
| `last_updated` | timestamptz DEFAULT NOW() | |

**Indexes:** `organizers_artist_id_idx`

---

### `gigs`

A performance event. Setlists can be linked to a gig but the link is optional.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | |
| `title` | text NOT NULL | |
| `date` | date | NULL = date TBD |
| `venue_id` | integer FK → venues RESTRICT | NULL = no venue linked |
| `organizer_id` | integer FK → organizers RESTRICT | NULL = no organizer |
| `type` | text | `Club show`, `Festival`, `Private`, … |
| `time_start` | time | |
| `time_end` | time | |
| `additional_link` | text | |
| `additional_text` | text | |
| `comment` | text | |
| `deleted` | boolean NOT NULL DEFAULT false | Soft-delete |
| `last_updated` | timestamptz DEFAULT NOW() | |

`ON DELETE RESTRICT` on `venue_id` and `organizer_id` means you must clear or reassign those FKs before hard-deleting a venue or organizer.

**Indexes:** `gigs_artist_id_idx`

---

### `setlists`

A saved setlist. Songs are stored in `setlist_songs`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | |
| `title` | text | Optional label |
| `gig_id` | integer FK → gigs SET NULL | Deleting the gig nullifies this, preserving the setlist |
| `comment` | text | |
| `created_at` | timestamptz DEFAULT NOW() | |

**Indexes:** `setlists_artist_id_idx`

---

### `setlist_songs`

Junction table: setlist ↔ song with explicit ordering. PK `(setlist_id, position)` enforces unique slots.

`song_id` has **no** CASCADE — soft-deleting a song keeps its row in the DB so historical setlists remain intact.

| Column | Type | Notes |
|--------|------|-------|
| `setlist_id` | integer PK FK → setlists CASCADE | |
| `song_id` | integer FK → songs | No cascade |
| `position` | integer PK | 0-based display order |

**Indexes:** `setlist_songs_song_id_idx (song_id)`

---

### `song_logs`

Append-only audit log. Every create, update, or soft-delete on a song writes a full JSON snapshot.

`song_id` is nullable — if a song is ever hard-deleted the FK goes `NULL` via `ON DELETE SET NULL` but the `song_data` snapshot is preserved.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | Denormalised for fast per-artist queries |
| `song_id` | integer FK → songs SET NULL, nullable | |
| `action` | text CHECK IN ('create','update','delete') | |
| `song_data` | jsonb NOT NULL | Complete `songs` row at time of action |
| `changed_at` | timestamptz DEFAULT NOW() | |

**Indexes:** `song_logs_artist_idx (artist_id, changed_at DESC)`, `song_logs_song_id_idx`

---

### `gema_works`

Works registered with a performing-rights organisation. Linked to `songs` via `song_id`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | |
| `gema_work_number` | text NOT NULL | e.g. `15299392-001` |
| `title` | text NOT NULL | Uppercase as exported by GEMA |
| `iswc` | text | e.g. `T8034602217` |
| `isrc` | text | |
| `publisher_work_numbers` | text | |
| `language` | text | Normalised: `DE`, `EN`, `FR`, … |
| `performers` | text | |
| `gema_genre` | text | e.g. `ROCK`, `BLUES` |
| `duration_sec` | integer | |
| `first_registered_at` | date | |
| `last_updated_at` | date | |
| `song_id` | integer FK → songs SET NULL | |
| `created_at` | timestamptz DEFAULT NOW() | |

UNIQUE `(artist_id, gema_work_number)`.

---

### `gema_rightholders`

One row per rightholder per work. Replace-all on import (existing rows deleted before re-inserting).

| Column | Notes |
|--------|-------|
| `gema_work_id` FK → gema_works CASCADE | |
| `name` | e.g. `SIEG KEVIN` |
| `ip_name_number` | |
| `role` | `composer`, `lyricist`, `publisher`, `arranger`, `sub-publisher` |
| `ar_share`, `vr_share`, `ar_share_cumulated`, `vr_share_cumulated` | numeric(6,2) |
| `society_ar`, `society_vr` | `GEMA`, `SACEM`, `BMI`, … |
| `role_order`, `publisher_relation`, `represents_name`, `represents_ip`, `represents_role` | publisher-specific fields |

---

### `rate_limits`

Sliding-window rate limiting for auth, request-reset, and OAuth endpoints.

| Column | Notes |
|--------|-------|
| `key` PK | e.g. `auth:1.2.3.4`, `oauth:1.2.3.4` |
| `window_start` timestamptz | Start of current window |
| `count` integer | Hits in current window |

---

### `subscribers`

Landing page email sign-ups and demo access leads. Not artist-scoped.

| Column | Notes |
|--------|-------|
| `id` serial PK | |
| `email` text UNIQUE NOT NULL | |
| `source` text DEFAULT `'landing'` | `landing` or `demo` |
| `meta` jsonb | Demo only: `{ name, genres, perform_country, geo_country, geo_region, geo_city, ua, ref }` |
| `created_at` timestamptz DEFAULT NOW() | |

---

## Design decisions

### Multi-tenancy

Every table has an `artist_id` FK. A single deployment and database serves multiple artists. `ARTIST_SLUG` env var tells `GET /api/config` which artist to serve in single-artist deployments.

### Soft delete

Songs, venues, organizers, and gigs use `deleted = true` rather than physical deletion. This preserves setlist history (songs), CRM history (venues/organizers), and linked setlists (gigs). The restore endpoint for songs (`POST /api/:artist/songs/:id/restore`) uses the `song_logs` snapshot as a fallback.

### FK delete strategies

| Relationship | Strategy | Reason |
|---|---|---|
| `songs` → `artists` | CASCADE | Song only makes sense within its artist |
| `setlist_songs.setlist_id` → `setlists` | CASCADE | Junction row is meaningless without its setlist |
| `setlist_songs.song_id` → `songs` | no cascade | Preserve historical setlist contents after song soft-delete |
| `setlists.gig_id` → `gigs` | SET NULL | Setlist outlives its gig |
| `gigs.venue_id` → `venues` | RESTRICT | Must clear link before removing venue |
| `gigs.organizer_id` → `organizers` | RESTRICT | Must clear link before removing organizer |
| `song_logs.song_id` → `songs` | SET NULL | Preserve audit record after hard-delete |

### JSONB for extensible data

`songs.extra` holds per-artist fields (capo, isrc, language, lyrics, …) without schema changes. `artists.config` drives the UI:
- `displayFields` / `filterFields` — song table columns and setlist generator filters
- `logoUrl` — nav and print header logo
- `platforms` — streaming/social links managed by `/hub` (see below)

Always patch with JSONB `||` merge, never overwrite the full object — other keys not touched by the current UI operation would be lost.

### Setlist ordering

`setlist_songs` uses a composite PK `(setlist_id, position)` — enforces unique positions at DB level. Updates delete all rows and re-insert via `UNNEST` to avoid N round-trips.

### Platform connections (`config.platforms`)

Stored as a JSONB object in `artists.config`. Each key is either a well-known platform ID (e.g. `spotify`, `instagram`) or `custom_<timestamp>` for user-defined entries. Value shape: `{ url, note?, label? }`.

```json
{
  "platforms": {
    "spotify": { "url": "https://open.spotify.com/artist/…" },
    "instagram": { "url": "https://instagram.com/…", "note": "main account" },
    "custom_1716123456789": { "url": "https://bandsintown.com/…", "label": "Bandsintown" }
  }
}
```

---

## Artist config

Full `artists.config` shape:

```json
{
  "logoUrl": "/img/band-logo.png",
  "displayFields": [
    { "field": "title",      "label": "Song" },
    { "field": "key",        "label": "Key"  },
    { "field": "extra.capo", "label": "Capo" }
  ],
  "filterFields": [
    { "field": "key",        "label": "Key"  },
    { "field": "extra.capo", "label": "Capo", "type": "integer" }
  ],
  "googleLogin":   true,
  "facebookLogin": false,
  "platforms": {
    "spotify": { "url": "https://open.spotify.com/artist/…" }
  }
}
```

(`googleLogin`/`facebookLogin` are not stored — they're computed at runtime from env vars and injected into the `GET /api/config` response.)

---

## Tenant lifecycle

### Export all data for one artist

`GET /api/:artist/setlists/export` (requires auth) returns a single JSON file containing every artist-scoped table:

```
{
  artist:            { slug, name }
  songs:             [ …all rows including deleted ]
  gigs:              [ … ]
  setlists:          [ … ]
  setlist_songs:     [ … ]
  venues:            [ …all rows including deleted ]
  organizers:        [ …all rows including deleted ]
  gema_works:        [ … ]
  gema_rightholders: [ … ]
  song_logs:         [ … ]
}
```

`subscribers` and `rate_limits` are global (not artist-scoped) and are excluded.

R2 file assets (audio, sheet PDFs, playback) are referenced by URL in `songs.extra` fields (`listenUrl`, `sheetUrl`, `playbackUrl`) but are not included in the download. To export files, download each URL separately or use the Cloudflare R2 dashboard to download the bucket.

---

### Delete all data for one artist

All artist-scoped tables cascade from `artists.id`. A single `DELETE FROM artists` removes everything. However, `gigs.venue_id` and `gigs.organizer_id` are `ON DELETE RESTRICT`, which can conflict with the venue/organizer cascade if the DB resolves cascades in the wrong order.

**Safe deletion sequence — always use this pattern:**

```sql
BEGIN;

-- Nullify the RESTRICT FKs on gigs first so venues/organizers can cascade freely.
UPDATE gigs
SET venue_id = NULL, organizer_id = NULL
WHERE artist_id = (SELECT id FROM artists WHERE slug = 'yourslug');

-- Single delete cascades to all nine artist-scoped tables automatically:
--   venues, organizers, gigs, songs, setlists, song_logs,
--   gema_works → gema_rightholders, setlist_songs (via setlists)
DELETE FROM artists WHERE slug = 'yourslug';

COMMIT;
```

Run this against the correct DB branch (main for production, dev for preview). After the transaction completes, remove any R2 files manually using the Cloudflare dashboard or `wrangler r2 object delete`.

In a shared-DB multi-tenant setup, this leaves all other artists' data completely untouched.

---

## Common query patterns

**Songs with GEMA data** — used by `GET /api/config` (public config response):
```sql
SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language
FROM songs s
LEFT JOIN LATERAL (
  SELECT iswc, gema_work_number, language
  FROM gema_works
  WHERE song_id = s.id
  ORDER BY gema_work_number
  LIMIT 1
) g ON true
WHERE s.artist_id = $1 AND s.deleted = false
ORDER BY s.title;
```

**Gigs with venue and organizer names** — used by `GET /api/:artist/gigs`:
```sql
SELECT g.*,
       v.name AS venue_name,
       o.name AS organizer_name
FROM gigs g
LEFT JOIN venues    v ON v.id = g.venue_id
LEFT JOIN organizers o ON o.id = g.organizer_id
WHERE g.artist_id = $1
ORDER BY g.date DESC NULLS LAST, g.id DESC;
```

**Batch setlist insert** — avoids N round-trips:
```sql
INSERT INTO setlist_songs (setlist_id, song_id, position)
SELECT * FROM unnest($1::int[], $2::int[], $3::int[]);
```

**Song appearances** — used by `GET /api/:artist/songs/:id/setlists`:
```sql
SELECT sl.id, sl.title, sl.comment, sl.created_at,
       g.title AS gig_title, g.date AS gig_date, v.name AS venue_name
FROM setlists sl
JOIN setlist_songs ss ON ss.setlist_id = sl.id
LEFT JOIN gigs g      ON sl.gig_id = g.id
LEFT JOIN venues v    ON g.venue_id = v.id
WHERE ss.song_id = $1 AND sl.artist_id = $2
ORDER BY sl.created_at DESC;
```
