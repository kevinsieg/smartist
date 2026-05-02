# Database Model

PostgreSQL (Neon serverless). All tables are scoped to a `band_id` — a single database supports multiple independent bands.

---

## Entity-relationship diagram

```
bands
  │
  ├─── songs ──────────────────── song_logs
  │      │
  │      └─(via setlist_songs)
  │
  ├─── gigs
  │      │
  └─── setlists ──── setlist_songs ──── songs
         │
         └── gig_id (optional FK → gigs)
```

```
┌──────────────────────────┐
│           bands           │
│──────────────────────────│
│ id            PK         │
│ slug          UNIQUE      │
│ name                      │
│ password_hash             │
│ config        JSONB       │
└────────────┬─────────────┘
             │ 1
             │ CASCADE DELETE
        ┌────┴──────────────────────────────────┐
        │                                       │
        │ n                                     │ n
┌───────┴──────────────┐             ┌──────────┴────────────┐
│         songs         │             │          gigs          │
│──────────────────────│             │───────────────────────│
│ id            PK     │             │ id            PK       │
│ band_id       FK     │             │ band_id       FK       │
│ title                │             │ name                   │
│ active               │             │ date                   │
│ key                  │             │ venue                  │
│ category             │             │ notes                  │
│ tempo                │             └──────────┬────────────┘
│ length_min           │                        │ 1
│ interpret            │                        │ SET NULL on delete
│ reference_interpret  │             ┌──────────┴────────────┐
│ comment              │             │        setlists        │
│ extra         JSONB  │             │───────────────────────│
│ deleted              │             │ id            PK       │
└───────┬──────────────┘             │ band_id       FK       │
        │ 1                          │ title                  │
        │ SET NULL on delete         │ gig_id        FK?      │
        │                            │ comment                │
┌───────┴──────────────┐             │ created_at             │
│       song_logs       │             └──────────┬────────────┘
│──────────────────────│                        │ CASCADE DELETE
│ id            PK     │                        │ n
│ band_id       FK     │             ┌──────────┴────────────┐
│ song_id       FK?    │             │     setlist_songs      │
│ action               │             │───────────────────────│
│ song_data     JSONB  │             │ setlist_id    PK, FK   │
│ changed_at           │             │ song_id       FK       │
└──────────────────────┘             │ position      PK       │
                                     └───────────────────────┘
```

---

## Table reference

### `bands`

One row per band. The API is keyed by `slug`; the app gets its slug from the `BAND_SLUG` environment variable.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | serial | PK | Internal identifier |
| `slug` | text | UNIQUE NOT NULL | URL-safe short name used in all API routes, e.g. `myband` |
| `name` | text | NOT NULL | Display name shown in the UI |
| `password_hash` | text | NOT NULL | bcrypt hash of the band password; plain text is never stored |
| `config` | jsonb | NOT NULL DEFAULT `{}` | UI configuration — see [Band config](#band-config) below |

---

### `songs`

Song catalogue. Soft-deleted songs (`deleted = true`) are kept in the database so that setlist history and the audit log remain intact.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | serial | PK | |
| `band_id` | integer | FK → bands, CASCADE | |
| `title` | text | NOT NULL | |
| `active` | boolean | DEFAULT true | Controls visibility in the setlist generator; inactive songs still appear in history |
| `key` | text | | Musical key, e.g. `G`, `Am` |
| `category` | text | | Genre or style grouping |
| `tempo` | text | | Descriptive tempo, e.g. `Slow`, `Medium`, `Fast` |
| `length_min` | real | | Duration in decimal minutes — `3.5` = 3 min 30 sec |
| `interpret` | text | | Main performer associated with the song |
| `reference_interpret` | text | | Artist of a specific reference recording |
| `comment` | text | | Free-form notes |
| `extra` | jsonb | DEFAULT `{}` | Band-specific fields defined in `bands.config` (e.g. capo positions, lead singer) |
| `deleted` | boolean | NOT NULL DEFAULT false | Soft-delete flag — see [Soft delete](#soft-delete) |

**Indexes**
- `songs_band_id_idx` on `(band_id)` — all per-band queries
- `songs_band_active_idx` on `(band_id, active)` — setlist generator filter

---

### `gigs`

A performance event. Setlists can be linked to a gig, but the link is optional.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | serial | PK | |
| `band_id` | integer | FK → bands, CASCADE | |
| `name` | text | NOT NULL | Short gig name, e.g. `Festival du Bout du Monde` |
| `date` | date | | `NULL` = date unknown or TBD |
| `venue` | text | | Location |
| `notes` | text | | Free-form notes |

**Indexes**
- `gigs_band_id_idx` on `(band_id)`

---

### `setlists`

A saved setlist. Songs are stored in `setlist_songs`. Deleting the linked gig sets `gig_id` to `NULL` but preserves the setlist.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | serial | PK | |
| `band_id` | integer | FK → bands, CASCADE | |
| `title` | text | | Optional label, e.g. `Summer 45-min` |
| `gig_id` | integer | FK → gigs, SET NULL | Optional; `NULL` = no linked gig |
| `comment` | text | | Free-form notes |
| `created_at` | timestamptz | DEFAULT NOW() | Used for chronological ordering |

**Indexes**
- `setlists_band_id_idx` on `(band_id)`

---

### `setlist_songs`

Junction table linking setlists to songs with explicit ordering. The primary key on `(setlist_id, position)` enforces that no two songs share the same slot within a setlist.

`song_id` has **no** `ON DELETE CASCADE`. Soft-deleting a song leaves its `songs` row in the database (`deleted = true`), so joins from `setlist_songs` still resolve correctly and historical setlists remain intact.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `setlist_id` | integer | PK, FK → setlists, CASCADE | |
| `song_id` | integer | FK → songs | No cascade — see above |
| `position` | integer | PK | 0-based display order within the setlist |

**Indexes**
- Primary key covers `(setlist_id, position)` — used when loading an ordered setlist
- `setlist_songs_song_id_idx` on `(song_id)` — "which setlists contain this song?"

---

### `song_logs`

Append-only audit log. Every create, update, or soft-delete on a song writes a row with a full JSON snapshot of the song at that moment.

`song_id` is **nullable**. If a song is ever hard-deleted directly in the database, the log entry's `song_id` becomes `NULL` via `ON DELETE SET NULL`. The `song_data` snapshot is preserved, so the song can still be inspected or restored.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | serial | PK | |
| `band_id` | integer | FK → bands, CASCADE | Denormalised for fast per-band queries without joining through `song_id` |
| `song_id` | integer | FK → songs, SET NULL, nullable | `NULL` if the song was hard-deleted |
| `action` | text | CHECK IN ('create','update','delete') | |
| `song_data` | jsonb | NOT NULL | Complete `songs` row snapshot at the time of the action |
| `changed_at` | timestamptz | NOT NULL DEFAULT NOW() | |

**Indexes**
- `song_logs_band_idx` on `(band_id, changed_at DESC)` — recent log for a band (primary access pattern)
- `song_logs_song_id_idx` on `(song_id)` — finding the delete record when restoring a song

---

## Design decisions

### Multi-tenancy

Every table has a `band_id` foreign key. A single deployment and database serves multiple bands with complete data isolation. The `BAND_SLUG` environment variable tells the `/api/config` endpoint which band to use in single-band deployments (like a band's own website). The full multi-band API is always available at `/api/:band/`.

### Soft delete

Songs are never physically deleted from the database. Setting `deleted = true` hides a song from the setlist generator and catalogue while preserving:
- its presence in historical `setlist_songs` rows (setlist integrity)
- its `song_logs` audit trail
- the ability to restore it via `POST /api/:band/songs/:id/restore`

The restore endpoint looks up the last `delete` entry in `song_logs` and either clears the `deleted` flag (soft-delete case) or re-inserts the song from the snapshot (hard-delete fallback).

### JSONB for band-specific fields

`songs.extra` stores fields that vary per band (capo positions, lead singer, instrument notes) without requiring schema migrations. `bands.config` defines which `extra.*` paths the UI exposes. Adding a new band-specific field is a database config update, not a deployment.

### Audit log design

`song_logs` is append-only and never updated. `band_id` is denormalised (copied from the song) so that per-band log queries are fast even if `song_id` is `NULL`. The `song_data` snapshot is the entire songs row as JSONB, so the log is self-contained and survives song deletion.

### Setlist ordering

`setlist_songs` uses a composite primary key on `(setlist_id, position)` rather than a separate auto-increment. This enforces unique positions within a setlist at the database level. When a setlist is updated, the API deletes all existing `setlist_songs` rows and re-inserts them using PostgreSQL's `UNNEST` pattern to avoid N round-trips.

### Gig nullability

`setlists.gig_id` uses `ON DELETE SET NULL` so that deleting a gig does not cascade to destroy the setlists linked to it. The setlist remains, just without a gig reference.

---

## Band config

`bands.config` is a JSONB object. Its shape controls the app UI without requiring schema changes or redeployments.

```json
{
  "logoUrl": "/img/band-logo.png",
  "displayFields": [
    { "field": "title",       "label": "Song"     },
    { "field": "key",         "label": "Key"      },
    { "field": "extra.capo",  "label": "Capo"     }
  ],
  "filterFields": [
    { "field": "key",         "label": "Key"      },
    { "field": "extra.capo",  "label": "Capo", "type": "integer" }
  ]
}
```

| Key | Type | Description |
|-----|------|-------------|
| `logoUrl` | string | Path or URL to the band logo used in nav and print headers. Default: `/img/band-logo.png` |
| `displayFields` | array | Ordered list of columns shown in the songs table |
| `filterFields` | array | Fields exposed as filter controls in the setlist generator |

**Field entry shape:**

| Key | Required | Values |
|-----|----------|--------|
| `field` | yes | Standard column name (`key`, `category`, `tempo`, `length_min`, `interpret`, `reference_interpret`, `comment`) or `extra.<name>` for custom fields |
| `label` | yes | Column header shown in the UI |
| `type` | filter only | `integer` for numeric inputs; omit for value-based buttons |

---

## Common query patterns

These are the patterns used by the API handlers.

**Songs with play stats** — used by `GET /api/:band/songs`:
```sql
SELECT s.*,
  COUNT(DISTINCT ss.setlist_id)::int AS play_count,
  MAX(sl.created_at)                 AS last_played_at
FROM songs s
LEFT JOIN setlist_songs ss ON ss.song_id = s.id
LEFT JOIN setlists sl      ON sl.id = ss.setlist_id
WHERE s.band_id = $1 AND s.deleted = false
GROUP BY s.id
ORDER BY s.title;
```

**Setlists with metadata** — used by `GET /api/:band/setlists`:
```sql
SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue,
  COUNT(ss.song_id)::int AS song_count
FROM setlists s
LEFT JOIN gigs g ON s.gig_id = g.id
LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
WHERE s.band_id = $1
GROUP BY s.id, g.name, g.date, g.venue
ORDER BY s.created_at DESC;
```

**Batch setlist insert** — used when creating or updating a setlist (avoids N round-trips):
```sql
INSERT INTO setlist_songs (setlist_id, song_id, position)
SELECT * FROM unnest($1::int[], $2::int[], $3::int[]);
```

**Song appearances** — used by `GET /api/:band/songs/:id/setlists`:
```sql
SELECT sl.id, sl.title, sl.comment, sl.created_at,
  g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue
FROM setlists sl
JOIN setlist_songs ss ON ss.setlist_id = sl.id
LEFT JOIN gigs g ON sl.gig_id = g.id
WHERE ss.song_id = $1 AND sl.band_id = $2
ORDER BY sl.created_at DESC;
```
