-- Band Tools — Database Schema
-- Idempotent: safe to run multiple times (CREATE IF NOT EXISTS throughout).
--
-- Usage:
--   psql $DATABASE_URL < scripts/schema.sql
--   or let the setup wizard apply it: node scripts/setup.js
--
-- See DATABASE.md at the repo root for the full data model, design decisions,
-- and common query patterns.

-- ── bands ──────────────────────────────────────────────────────────────────
-- One row per band. Multi-tenant: all other tables are scoped to band_id.
-- The API is keyed by `slug` (URL-safe short name, e.g. "myband").
-- `config` is a JSONB object that drives the UI without schema changes:
--   - displayFields: which song columns appear in the songs table
--   - filterFields:  which fields produce filter buttons in the setlist generator
--   - logoUrl:       path or URL to the band logo
-- See DATABASE.md §Band config for the full shape.

CREATE TABLE IF NOT EXISTS bands (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,   -- URL-safe identifier, e.g. "myband"
  name          TEXT NOT NULL,          -- display name, e.g. "My Band"
  password_hash TEXT NOT NULL,          -- bcrypt hash; plain password is never stored
  config        JSONB NOT NULL DEFAULT '{}'
);

-- ── songs ──────────────────────────────────────────────────────────────────
-- The song catalogue. Songs are soft-deleted (deleted = true) rather than
-- removed so that setlist history and the audit log remain intact.
--
-- Standard fields cover the common metadata every band needs.
-- `extra` holds band-specific fields (e.g. capo positions, lead singer)
-- defined per band in bands.config without requiring schema migrations.
--
-- `active` controls whether a song appears in the setlist generator.
-- Inactive songs still appear in the songs table and history.

CREATE TABLE IF NOT EXISTS songs (
  id                  SERIAL PRIMARY KEY,
  band_id             INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  key                 TEXT,             -- musical key, e.g. "G", "Am"
  genre            TEXT,             -- genre or style grouping
  tempo               TEXT,             -- descriptive tempo, e.g. "Slow", "Medium"
  length_min          REAL,             -- duration in decimal minutes, e.g. 3.5 = 3:30
  interpret           TEXT,             -- main performer or band known for this song
  reference_interpret TEXT,             -- artist of a specific reference recording
  comment             TEXT,             -- free-form notes visible to the band
  extra               JSONB NOT NULL DEFAULT '{}', -- band-specific fields
  deleted             BOOLEAN NOT NULL DEFAULT false
);

-- Speeds up all per-band song queries
CREATE INDEX IF NOT EXISTS songs_band_id_idx     ON songs(band_id);
-- Speeds up the setlist generator (filters active songs per band)
CREATE INDEX IF NOT EXISTS songs_band_active_idx ON songs(band_id, active);

-- ── gigs ───────────────────────────────────────────────────────────────────
-- A gig is a performance event. Setlists can optionally be linked to a gig.
-- Deleting a gig sets the setlist's gig_id to NULL (ON DELETE SET NULL)
-- so the setlist itself is preserved.

CREATE TABLE IF NOT EXISTS gigs (
  id      SERIAL PRIMARY KEY,
  band_id INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,   -- short name for the gig, e.g. "Festival du Bout du Monde"
  date    DATE,            -- optional; NULL = date unknown or TBD
  venue   TEXT,            -- optional location
  notes   TEXT             -- free-form notes
);

CREATE INDEX IF NOT EXISTS gigs_band_id_idx ON gigs(band_id);

-- ── setlists ───────────────────────────────────────────────────────────────
-- A saved setlist. Songs are stored in setlist_songs (junction table).
-- A setlist may be linked to a gig (gig_id), but that link is optional.
-- Deleting the linked gig nullifies gig_id but preserves the setlist.

CREATE TABLE IF NOT EXISTS setlists (
  id         SERIAL PRIMARY KEY,
  band_id    INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  title      TEXT,                       -- optional label, e.g. "Summer 45-min"
  gig_id     INTEGER REFERENCES gigs(id) ON DELETE SET NULL,
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS setlists_band_id_idx ON setlists(band_id);

-- ── song_logs ──────────────────────────────────────────────────────────────
-- Append-only audit log. Every create, update, or soft-delete on a song
-- writes a row here with a full JSON snapshot of the song at that moment.
-- This allows restoring a deleted song from its last snapshot even if the
-- songs row was hard-deleted (song_id goes NULL via ON DELETE SET NULL).
--
-- song_id is nullable for exactly that reason: a NULL song_id means the
-- log entry is an orphan from a hard-delete, but the snapshot is still there.

CREATE TABLE IF NOT EXISTS song_logs (
  id         SERIAL PRIMARY KEY,
  band_id    INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  song_id    INTEGER,          -- nullable: see note above
  action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  song_data  JSONB NOT NULL,   -- full songs row snapshot at the time of the action
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary access pattern: recent log entries for a band
CREATE INDEX IF NOT EXISTS song_logs_band_idx    ON song_logs(band_id, changed_at DESC);
-- Needed to find the delete record when restoring a song
CREATE INDEX IF NOT EXISTS song_logs_song_id_idx ON song_logs(song_id);

-- The FK was added after initial deploy; declared separately to allow
-- IF NOT EXISTS on the surrounding tables while still being idempotent.
-- The DO block silently skips if the constraint already exists.
DO $$ BEGIN
  ALTER TABLE song_logs
    ADD CONSTRAINT song_logs_song_id_fkey
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── setlist_songs ──────────────────────────────────────────────────────────
-- Junction table linking setlists to songs with explicit ordering.
-- PRIMARY KEY on (setlist_id, position) enforces that positions are unique
-- within a setlist — no two songs can share the same slot.
--
-- song_id has no ON DELETE CASCADE intentionally: soft-deleting a song does
-- not destroy the historical setlists that included it. The song row stays
-- in the database (deleted = true), so joins from setlist_songs still resolve.

CREATE TABLE IF NOT EXISTS setlist_songs (
  setlist_id INTEGER NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
  song_id    INTEGER NOT NULL REFERENCES songs(id),  -- no cascade: see note above
  position   INTEGER NOT NULL,                        -- 0-based display order
  PRIMARY KEY (setlist_id, position)
);

-- Supports "which setlists contain this song?" queries
CREATE INDEX IF NOT EXISTS setlist_songs_song_id_idx ON setlist_songs(song_id);

-- ── gema_works ─────────────────────────────────────────────────────────────
-- Stores works registered with a performing-rights organisation (GEMA, SACEM,
-- etc.). Not every song needs a matching row; linking is via song_id FK.
-- Populated from two GEMA CSV exports:
--   Identifikatoren-Table 1.csv  → gema_work_number, title, iswc, isrc
--   Werkinformationen-Table 1.csv → language, performers, gema_genre, duration_sec,
--                                   first_registered_at, last_updated_at

CREATE TABLE IF NOT EXISTS gema_works (
  id                     SERIAL PRIMARY KEY,
  band_id                INTEGER NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  gema_work_number       TEXT NOT NULL,           -- Werknummer, e.g. "15299392-001"
  title                  TEXT NOT NULL,           -- Titel (uppercase as exported)
  iswc                   TEXT,                    -- e.g. "T8034602217"
  isrc                   TEXT,
  publisher_work_numbers TEXT,                    -- Verlagswerknummern
  language               TEXT,                    -- Sprache normalised: DE, EN, FR, …
  performers             TEXT,                    -- Interpretinnen/Interpreten, e.g. "YOUR BAND NAME"
  gema_genre             TEXT,                    -- Gattung, e.g. "FOLK", "SCHLAGER"
  duration_sec           INTEGER,                 -- Dauer in seconds
  first_registered_at    DATE,                    -- Erstmals geladen (DD.MM.YYYY → ISO)
  last_updated_at        DATE,                    -- Letzte Aktualisierung
  song_id                INTEGER REFERENCES songs(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (band_id, gema_work_number)
);

CREATE INDEX IF NOT EXISTS gema_works_band_id_idx ON gema_works(band_id);
CREATE INDEX IF NOT EXISTS gema_works_song_id_idx ON gema_works(song_id);

-- ── gema_rightholders ──────────────────────────────────────────────────────
-- One row per rightholder per work. Populated from GEMA's Beteiligte export.
-- Import is replace-all: deletes existing rows for each work before re-inserting.
-- Roles are stored in English (see ROLE_MAP in import_gema.js).

CREATE TABLE IF NOT EXISTS gema_rightholders (
  id                   SERIAL PRIMARY KEY,
  gema_work_id         INTEGER NOT NULL REFERENCES gema_works(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,               -- e.g. "SIEG KEVIN"
  ip_name_number       TEXT,                        -- IP-Name-Nr., e.g. "755143051"
  role                 TEXT NOT NULL,               -- composer | lyricist | publisher | arranger | sub-publisher
  role_order           TEXT,                        -- Reihenfolge Verlagsrollen (E1, E2, …); null for non-publisher roles
  publisher_relation   TEXT,                        -- Urheber/-in-Verlagsbeziehung
  ar_share             NUMERIC(6,2),                -- AR-Anteil Detailansicht (%)
  vr_share             NUMERIC(6,2),                -- VR-Anteil Detailansicht (%)
  ar_share_cumulated   NUMERIC(6,2),                -- AR-Anteil (kumuliert) (%)
  vr_share_cumulated   NUMERIC(6,2),                -- VR-Anteil (kumuliert) (%)
  society_ar           TEXT,                        -- Gesellschaft AR: GEMA, SACEM, BMI, DP, …
  society_vr           TEXT,                        -- Gesellschaft VR
  represents_name      TEXT,                        -- Vertritt: Name (publisher acting on behalf of)
  represents_ip        TEXT,                        -- Vertritt: IP-Name-Nr.
  represents_role      TEXT                         -- Vertritt: Rolle
);

CREATE INDEX IF NOT EXISTS gema_rightholders_work_id_idx ON gema_rightholders(gema_work_id);

-- ── rate_limits ─────────────────────────────────────────────────────────────
-- Sliding-window rate limiting for auth, request-reset, and share endpoints.
-- One row per (endpoint, IP) key; the window resets on the next request after
-- it expires. No background cleanup needed — rows are self-managing.

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,        -- e.g. "auth:1.2.3.4", "reset:1.2.3.4"
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count        INTEGER NOT NULL DEFAULT 1
);
