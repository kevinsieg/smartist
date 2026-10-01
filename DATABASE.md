# Database Model

PostgreSQL via **Neon** (hosted). All tables are scoped to an `artist_id` — a single database supports multiple independent artists.

## Driver

**postgres.js** (`postgres` npm package, v3). Connects over the standard PostgreSQL wire protocol (port 5432) using Neon's pooler connection string.

The scripts use the same driver through `scripts/_lib.js` (`connect()` turns SSL off for a database on localhost). `@neondatabase/serverless` is no longer a dependency: its HTTP transport has no transactions (`sql.begin()`).

The swap point is the `DB.connect` line in `api/_db.js`. The rest of the codebase is driver-agnostic (`sql\`...\`` tagged templates only).

Schema file: `scripts/schema.sql` (idempotent — safe to re-run against any database version to apply missing tables/columns without data loss).

---

## Entity-relationship diagram

```
artists
  │
  ├─── songs ──────────────────────── song_logs
  │      │                        ├── song_lyrics
  │      │                        └── song_arrangements
  │      └─(via setlist_songs)──── setlists ──── gig_id (optional) ──┐
  │                                                                    │
  ├─── venues ◄──── gigs.venue_id ─── gigs ◄──────────────────────────┘
  │                                    │
  └─── organizers ◄── gigs.organizer_id┘
  │
  ├─── users  (one row per person per workspace; email ties them together)
  ├─── gema_works ──── gema_rightholders
  ├─── rate_limits  (keyed by IP, address or band — not artist-scoped)
  └─── subscribers  (landing/demo leads — not artist-scoped)
```

```
┌────────────────────────────┐
│           artists           │
│ id  slug  name  config JSONB│
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
  song_arrangements                              (gig_id FK, SET NULL)
  setlist_songs ◄─────────────────────────────── 
  gema_works ──► gema_rightholders
```

---

## Table reference

### `artists`

One row per artist (a workspace). The API is keyed by `slug`, taken from the URL (`/api/:artist/…`); `ARTIST_SLUG` only sets the default on single-band deployments.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `slug` | text UNIQUE NOT NULL | URL-safe identifier used in all API routes |
| `name` | text NOT NULL | Display name |
| `storage_used_bytes` | bigint DEFAULT 0 | Song-media bytes counted against the plan's storage cap |
| `config` | jsonb DEFAULT `{}` | UI config — see [Artist config](#artist-config) |

---

### `songs`

Song catalogue. Soft-deleted songs (`deleted = true`) are kept so setlist history and audit log remain intact; their lyrics and arrangements stay too, so a restore brings them back.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | |
| `title` | text NOT NULL | |
| `active` | boolean NOT NULL DEFAULT true | Controls visibility in setlist generator |
| `heart` | boolean NOT NULL DEFAULT false | Favourite; always included in auto-generation |
| `key` | text | Musical key, e.g. `G`, `Am` |
| `genre` | text | Genre or style grouping |
| `tags` | text[] | Theme tags, free-form per band (default `'{}'`) |
| `energy` | smallint, 0–10 | 0 calm … 10 intense; shown as Low/Middle/High |
| `time_signature` | text | e.g. `4/4`, `6/8` |
| `bpm` | integer | Beats per minute |
| `length_min` | real | Duration in decimal minutes — `3.5` = 3:30 |
| `interpret` | text | Main performer associated with the song |
| `reference_interpret` | text | Artist of a specific reference recording |
| `comment` | text | Free-form notes |
| `language` | text | Language code (`EN`, `DE`, …); a linked GEMA work's language shadows it |
| `extra` | jsonb DEFAULT `{}` | Artist-specific fields (capo, isrc, listenUrl, …) |
| `deleted` | boolean NOT NULL DEFAULT false | Soft-delete flag |

**Indexes:** `songs_list_idx (artist_id, deleted, title)` — serves every song query; `songs_artist_id_idx`, `songs_band_active_idx (artist_id, active)`.

---

### `song_lyrics`

One song's lyrics, kept out of `songs` so the song list stays small: lists return `has_lyrics`, and the text is read with one song's details (`GET /api/:artist/songs/:id`) or, for the CSV export, `GET /api/:artist/songs?lyrics=1`.

| Column | Type | Notes |
|--------|------|-------|
| `song_id` | integer PK FK → songs CASCADE | |
| `artist_id` | integer FK → artists CASCADE | |
| `lyrics` | text NOT NULL | Up to 20 000 characters; no row means no lyrics |
| `updated_at` | timestamptz DEFAULT now() | |

**Indexes:** `song_lyrics_artist_id_idx`

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
| `phone` | text | Venue phone |
| `contact_name` | text | Booking contact person |
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

Soft-deleting a song keeps its row, so historical setlists remain intact. `song_id` cascades: songs are only hard-deleted together with their band.

| Column | Type | Notes |
|--------|------|-------|
| `setlist_id` | integer PK FK → setlists CASCADE | |
| `song_id` | integer FK → songs CASCADE | |
| `position` | integer PK | 0-based display order |

**Indexes:** `setlist_songs_song_id_idx (song_id)`

---

### `song_arrangements`

Versioned arrangement charts for a song. Each song can have multiple named versions; exactly one should be marked `is_active` (enforced at the application level). Arrangements are hard-deleted when the parent song is soft-deleted.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `song_id` | integer FK → songs CASCADE | Hard-deleted with the song |
| `artist_id` | integer FK → artists CASCADE | Denormalised for fast per-artist queries |
| `name` | text NOT NULL DEFAULT `'Default'` | Version label, e.g. `Default`, `Acoustic` |
| `is_active` | boolean NOT NULL DEFAULT false | The version shown on stage — at most one per song |
| `hidden_instruments` | jsonb NOT NULL DEFAULT `'[]'` | Array of instrument keys hidden from the chart view |
| `rows` | jsonb NOT NULL DEFAULT `'[]'` | Ordered array of section rows — see structure below |
| `created_at` | timestamptz DEFAULT NOW() | |
| `updated_at` | timestamptz DEFAULT NOW() | |

**Indexes:** `song_arrangements_song_id_idx`, `song_arrangements_artist_id_idx (artist_id, song_id)`, `song_arrangements_one_active_idx` (unique `song_id` WHERE `is_active` — at most one active version per song)

**Row shape** (one element of the `rows` array):

```json
{
  "structure":  "C1",
  "part":       "A",
  "lead":       "Ludo",
  "lead_type":  "person",
  "harmony":    ["Kevin", "Cerise"],
  "licks":      "BJO",
  "parts":      { "GTR": "STRUM", "BJO": "ROLL", "BASS": "ALT" },
  "comment":    ""
}
```

`lead_type` is `"person"` or `"instrument"`. `parts` keys and `licks` values are instrument keys defined in `artists.config.arrangementConfig.instruments`.

---

### `song_logs`

Append-only audit log. Every create, update, or soft-delete on a song writes a full JSON snapshot.

`song_id` is nullable — if a song is ever hard-deleted the FK goes `NULL` via `ON DELETE SET NULL` but the `song_data` snapshot is preserved.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial PK | |
| `artist_id` | integer FK → artists CASCADE | Denormalised for fast per-artist queries |
| `song_id` | integer FK → songs SET NULL, nullable | |
| `action` | text CHECK (`song_logs_action_known`) | `create`, `update`, `delete`, `lyrics_update`, `lyrics_delete`, `audio_replace`/`_delete`, `sheet_replace`/`_delete`, `playback_replace`/`_delete` |
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
| `name` | e.g. `DOE JANE` |
| `ip_name_number` | |
| `role` | `composer`, `lyricist`, `publisher`, `arranger`, `sub-publisher` |
| `ar_share`, `vr_share`, `ar_share_cumulated`, `vr_share_cumulated` | numeric(6,2) |
| `society_ar`, `society_vr` | `GEMA`, `SACEM`, `BMI`, … |
| `role_order`, `publisher_relation`, `represents_name`, `represents_ip`, `represents_role` | publisher-specific fields |

---

### `rate_limits`

Sliding-window rate limiting: login, failed band-password bearers, password reset, OAuth, sign-up, invites, setlist shares, deletion and lyrics suggest.

| Column | Notes |
|--------|-------|
| `key` PK | `<purpose>:<ip \| address \| band id>`, e.g. `auth:1.2.3.4`, `reset:you@example.com`, `invite:12` |
| `window_start` timestamptz | Start of current window |
| `count` integer | Hits in current window |

---

### `subscribers`

Landing page email sign-ups, demo access leads and pending sign-up links. Not artist-scoped. Rows older than 24 months are deleted by an occasional sweep in `api/_domain/subscribe.js` (the retention `/privacy` promises).

| Column | Notes |
|--------|-------|
| `id` serial PK | |
| `email` text UNIQUE NOT NULL | |
| `source` text DEFAULT `'landing'` | `landing`, `demo` or `signup` |
| `meta` jsonb | Demo: `{ name, genres, perform_country, geo_country }`. Sign-up: `{ signup_token_hash, signup_token_expires }` while a link is pending |
| `created_at` timestamptz DEFAULT NOW() | |

---

### `users`

A login. One row per person **per workspace**; the rows of one person share the same `email`, which is how one session reaches every band they belong to. Emails are stored lowercased (CHECK `users_email_lowercase`).

| Column | Notes |
|--------|-------|
| `id` serial PK | Session tokens carry this id |
| `artist_id` FK → `artists` CASCADE | The workspace |
| `email` text NOT NULL | Identity across workspaces; UNIQUE per `artist_id` |
| `password_hash` text | bcrypt; NULL until an invite is accepted, or for Google-only accounts |
| `role` text | `admin`, `member` or `viewer` |
| `invite_token_hash`, `invite_expires_at` | SHA-256 of the emailed invite token; 7 days |
| `sessions_valid_after` timestamptz | Set by "log out everywhere" on every row of the address; session tokens issued earlier are refused |
| `invited_by` FK → `users` SET NULL | |
| `pending_email`, `email_change_token_hash`, `email_change_expires_at` | Email change waiting for confirmation from the new address (24 h) |
| `delete_token_hash`, `delete_token_expires` | Account deletion waiting for confirmation (30 min) |
| `created_at` timestamptz | |

Every emailed token is stored only as a hash.

---

## Design decisions

### Multi-tenancy

Every table has an `artist_id` FK. A single deployment and database serves multiple artists. `ARTIST_SLUG` env var tells `GET /api/config` which artist to serve in single-artist deployments.

Row ids are one sequence across all artists, and a foreign key only proves that *some* row exists. The API therefore checks every id that arrives in a request body against the caller's artist (`api/_ownership.js`) and scopes every join by `artist_id`.

### Soft delete

Songs, venues, organizers, and gigs use `deleted = true` rather than physical deletion. This preserves setlist history (songs), CRM history (venues/organizers), and linked setlists (gigs). The restore endpoint for songs (`POST /api/:artist/songs/:id/restore`) uses the `song_logs` snapshot as a fallback.

### FK delete strategies

| Relationship | Strategy | Reason |
|---|---|---|
| `songs` → `artists` | CASCADE | Song only makes sense within its artist |
| `setlist_songs.setlist_id` → `setlists` | CASCADE | Junction row is meaningless without its setlist |
| `setlist_songs.song_id` → `songs` | CASCADE | Songs are soft-deleted; a hard delete only happens with the whole band |
| `song_lyrics.song_id` → `songs` | CASCADE | Lyrics belong to their song |
| `setlists.gig_id` → `gigs` | SET NULL | Setlist outlives its gig |
| `gigs.venue_id` → `venues` | RESTRICT | Must clear link before removing venue |
| `gigs.organizer_id` → `organizers` | RESTRICT | Must clear link before removing organizer |
| `song_logs.song_id` → `songs` | SET NULL | Preserve audit record after hard-delete |

### JSONB for extensible data

`songs.extra` holds per-artist fields (capo, isrc, media URLs, …) without schema changes. Anything large or queried on its own gets a column or table instead (`songs.language`, `song_lyrics`). `artists.config` drives the UI:
- `displayFields` / `filterFields` — song table columns and setlist generator filters
- `logoUrl` — nav and print header logo
- `publicCatalogue` / `publicStage` — opt-in anonymous access (both off unless `true`)
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

`GET /api/:artist/export` (requires auth; rewritten to `/setlists/export`) returns a ZIP with one CSV per non-empty table: `artist` (slug, name, config), `account` (the caller's own memberships across workspaces, no hashes or tokens), `members` (admins only: email, role, joined), `songs` (with a `lyrics` and a `language` column), `song_arrangements`, `gigs`, `setlists`, `setlist_songs`, `venues`, `organizers`, `gema_works`, `gema_rightholders`, `song_logs`.

Built by `api/_export.js`. Soft-deleted rows are left out. Columns empty in every row are dropped, as are `artist_id` and `deleted`; `id`s stay so the files still join. `songs.extra` is flattened into its own columns (a key clashing with a real column becomes `extra_<key>`); other JSON columns are a JSON string in the cell. UTF-8 with BOM, CRLF, and cells starting with `= + - @` are prefixed with `'` so spreadsheets don't run them.

`subscribers` and `rate_limits` are global (not artist-scoped) and are excluded.

R2 file assets (audio, sheet PDFs, playback) are referenced by URL in `songs.extra` fields (`listenUrl`, `sheetUrl`, `playbackUrl`) but are not included in the download. To export files, download each URL separately or use the Cloudflare R2 dashboard to download the bucket.

---

### Delete all data for one artist

All artist-scoped tables cascade from `artists.id`. A single `DELETE FROM artists` removes everything. Two FKs need care first: `gigs.venue_id` and `gigs.organizer_id` are `ON DELETE RESTRICT`, which can conflict with the venue/organizer cascade if the DB resolves cascades in the wrong order. (`setlist_songs.song_id` cascades since 2026-09-29; the explicit steps below stay so the sequence also works on a database that has not had that migration.)

**Safe deletion sequence — always use this pattern** (`scripts/delete_artist.js` runs the same steps):

```sql
BEGIN;

-- Nullify the RESTRICT FKs on gigs first so venues/organizers can cascade freely.
UPDATE gigs
SET venue_id = NULL, organizer_id = NULL
WHERE artist_id = (SELECT id FROM artists WHERE slug = 'yourslug');

-- Other artists' rows must not reference this one's (the API refuses that now,
-- but older rows may exist): drop or null those references too.
DELETE FROM setlist_songs
WHERE song_id IN (SELECT id FROM songs WHERE artist_id = (SELECT id FROM artists WHERE slug = 'yourslug'));
UPDATE gigs SET venue_id = NULL
WHERE venue_id IN (SELECT id FROM venues WHERE artist_id = (SELECT id FROM artists WHERE slug = 'yourslug'));
UPDATE gigs SET organizer_id = NULL
WHERE organizer_id IN (SELECT id FROM organizers WHERE artist_id = (SELECT id FROM artists WHERE slug = 'yourslug'));

-- setlist_songs.song_id has no cascade — drop the setlists first (that cascades
-- setlist_songs), otherwise deleting the songs fails with a FK violation.
DELETE FROM setlists
WHERE artist_id = (SELECT id FROM artists WHERE slug = 'yourslug');

-- Single delete cascades to all artist-scoped tables automatically:
--   venues, organizers, gigs, songs, song_lyrics, song_arrangements, setlists, song_logs, users,
--   gema_works → gema_rightholders, setlist_songs (via setlists)
DELETE FROM artists WHERE slug = 'yourslug';

COMMIT;
```

Run this against the correct DB branch (main for production, dev for preview). After the transaction completes, remove any R2 files manually using the Cloudflare dashboard or `wrangler r2 object delete`.

In a shared-DB multi-tenant setup, this leaves all other artists' data completely untouched.

---

## Common query patterns

**Song list** — `listSongs` in `api/_domain/songs.js` (`GET /api/:artist/songs`). Play counts are aggregated once per band, lyrics are a flag:
```sql
WITH plays AS (
  SELECT ss.song_id, count(DISTINCT ss.setlist_id)::int AS play_count, max(sl.created_at) AS last_played_at
  FROM setlists sl JOIN setlist_songs ss ON ss.setlist_id = sl.id
  WHERE sl.artist_id = $1
  GROUP BY ss.song_id
)
SELECT s.*, COALESCE(p.play_count, 0) AS play_count, p.last_played_at,
       g.iswc, g.gema_work_number, g.language AS gema_language,
       (l.song_id IS NOT NULL) AS has_lyrics
FROM songs s
LEFT JOIN plays p       ON p.song_id = s.id
LEFT JOIN song_lyrics l ON l.song_id = s.id
LEFT JOIN LATERAL (
  SELECT iswc, gema_work_number, language
  FROM gema_works
  WHERE song_id = s.id AND artist_id = s.artist_id
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
LEFT JOIN venues    v ON v.id = g.venue_id     AND v.artist_id = g.artist_id
LEFT JOIN organizers o ON o.id = g.organizer_id AND o.artist_id = g.artist_id
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
LEFT JOIN gigs g      ON sl.gig_id = g.id   AND g.artist_id = sl.artist_id
LEFT JOIN venues v    ON g.venue_id = v.id AND v.artist_id = g.artist_id
WHERE ss.song_id = $1 AND sl.artist_id = $2
ORDER BY sl.created_at DESC;
```
