-- Smartist — Database Schema
-- Authoritative schema for a fresh database.
--
-- Idempotent: safe to re-run — CREATE TABLE IF NOT EXISTS skips existing tables.
-- Future schema changes go at the bottom as ALTER TABLE … ADD COLUMN IF NOT EXISTS
-- blocks (with a version comment) so the file stays runnable on any existing DB.
--
-- To apply to a new or existing database:
--   psql $DATABASE_URL < scripts/schema.sql
--   or:  node scripts/setup.js   (interactive, confirms DB host first)
--
-- Tables (dependency order):
--   artists, venues, organizers, gigs, songs, setlists, song_logs,
--   setlist_songs, gema_works, gema_rightholders, rate_limits, subscribers

-- ── artists ──────────────────────────────────────────────────────────────────
-- One row per band. Multi-tenant: all other tables are scoped to artist_id.
-- The API is keyed by `slug` (URL-safe short name, e.g. "myband").
-- `config` is a JSONB object that drives the UI without schema changes:
--   displayFields: which song columns appear in the songs table
--   filterFields:  which fields produce filter buttons in the setlist generator
--   logoUrl:       path or URL to the band logo
-- `social_links` / `platforms` in config: streaming and social URLs managed via /hub.
-- See DATABASE.md §Band config for the full shape.

CREATE TABLE IF NOT EXISTS artists (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,             -- URL-safe identifier, e.g. "myband"
  name          TEXT NOT NULL,                    -- display name, e.g. "My Band"
  password_hash TEXT,                             -- bcrypt hash, NULL for OAuth/signup-created artists
  config        JSONB NOT NULL DEFAULT '{}',
  social_links  JSONB NOT NULL DEFAULT '{}'
);

-- ── venues ─────────────────────────────────────────────────────────────────
-- CRM-style venue directory. Linked to gigs via venue_id (FK ON DELETE RESTRICT).
-- Soft-deleted with `deleted` flag so historical gig references remain intact.

CREATE TABLE IF NOT EXISTS venues (
  id                      SERIAL PRIMARY KEY,
  artist_id               INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  deleted                 BOOLEAN NOT NULL DEFAULT false,
  alive                   BOOLEAN NOT NULL DEFAULT true,
  activated               BOOLEAN NOT NULL DEFAULT false,
  declined                BOOLEAN NOT NULL DEFAULT false,
  status                  TEXT,
  category                TEXT,
  postcode                TEXT,
  city                    TEXT,
  state                   TEXT,
  country                 TEXT,
  generic_email           TEXT,
  website                 TEXT,
  social_links            JSONB NOT NULL DEFAULT '{}',
  last_communication      DATE,
  booking_channel         TEXT,
  number_of_cold_contacts INTEGER NOT NULL DEFAULT 0,
  turnus                  TEXT,
  remuneration            TEXT,
  overnight               BOOLEAN NOT NULL DEFAULT false,
  season                  TEXT,
  preferred_period        TEXT,
  comment                 TEXT,
  deadline                DATE,
  main_genre              TEXT,
  subgenres               TEXT[],
  size                    INTEGER,
  language                TEXT,
  last_updated            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS venues_artist_id_idx ON venues(artist_id);

-- ── organizers ─────────────────────────────────────────────────────────────
-- CRM-style organizer/promoter directory. Linked to gigs via organizer_id.

CREATE TABLE IF NOT EXISTS organizers (
  id                 SERIAL PRIMARY KEY,
  artist_id          INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  deleted            BOOLEAN NOT NULL DEFAULT false,
  type               TEXT,
  email              TEXT,
  phone              TEXT,
  website            TEXT,
  social_links       JSONB NOT NULL DEFAULT '{}',
  city               TEXT,
  country            TEXT,
  last_communication DATE,
  comment            TEXT,
  extra              JSONB NOT NULL DEFAULT '{}',
  last_updated       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS organizers_artist_id_idx ON organizers(artist_id);

-- ── gigs ───────────────────────────────────────────────────────────────────
-- A performance event. Setlists can optionally be linked to a gig.
-- venue_id and organizer_id are nullable FKs with ON DELETE RESTRICT —
-- deleting a linked venue/organizer is blocked until all gig references are cleared.

CREATE TABLE IF NOT EXISTS gigs (
  id              SERIAL PRIMARY KEY,
  artist_id       INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  date            DATE,
  comment         TEXT,
  deleted         BOOLEAN NOT NULL DEFAULT false,
  venue_id        INTEGER REFERENCES venues(id) ON DELETE RESTRICT,
  organizer_id    INTEGER REFERENCES organizers(id) ON DELETE RESTRICT,
  type            TEXT,
  time_start      TIME,
  time_end        TIME,
  additional_link TEXT,
  additional_text TEXT,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gigs_artist_id_idx    ON gigs(artist_id);
CREATE INDEX IF NOT EXISTS gigs_venue_id_idx     ON gigs(venue_id);
CREATE INDEX IF NOT EXISTS gigs_organizer_id_idx ON gigs(organizer_id);

-- ── songs ──────────────────────────────────────────────────────────────────
-- The song catalogue. Songs are soft-deleted (deleted = true) rather than
-- removed so that setlist history and the audit log remain intact.
--
-- Standard fields cover the common metadata every band needs.
-- `extra` holds band-specific fields (e.g. capo positions, lead singer, lyrics)
-- defined per band in artists.config without requiring schema migrations.
--
-- `active` controls whether a song appears in the setlist generator.
-- Inactive songs still appear in the songs table and history.

CREATE TABLE IF NOT EXISTS songs (
  id                  SERIAL PRIMARY KEY,
  artist_id           INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  heart               BOOLEAN NOT NULL DEFAULT false,  -- favourite, always included in auto-generation
  key                 TEXT,             -- musical key, e.g. "G", "Am"
  genre               TEXT,             -- genre or style grouping
  energy              TEXT,             -- descriptive energy level, e.g. "Slow", "Medium", "Fast"
  time_signature      TEXT,             -- e.g. "4/4", "3/4", "6/8"
  bpm                 INTEGER,          -- beats per minute
  length_min          REAL,             -- duration in decimal minutes, e.g. 3.5 = 3:30
  interpret           TEXT,             -- main performer or band known for this song
  reference_interpret TEXT,             -- artist of a specific reference recording
  comment             TEXT,             -- free-form notes visible to the band
  extra               JSONB NOT NULL DEFAULT '{}', -- band-specific fields
  deleted             BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS songs_artist_id_idx  ON songs(artist_id);
CREATE INDEX IF NOT EXISTS songs_band_active_idx ON songs(artist_id, active);
CREATE INDEX IF NOT EXISTS songs_list_idx        ON songs(artist_id, deleted, title);

-- ── setlists ───────────────────────────────────────────────────────────────
-- A saved setlist. Songs are stored in setlist_songs (junction table).
-- A setlist may be linked to a gig (gig_id), but that link is optional.
-- Deleting the linked gig nullifies gig_id but preserves the setlist.

CREATE TABLE IF NOT EXISTS setlists (
  id         SERIAL PRIMARY KEY,
  artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title      TEXT,                       -- optional label, e.g. "Summer 45-min"
  gig_id     INTEGER REFERENCES gigs(id) ON DELETE SET NULL,
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS setlists_artist_id_idx ON setlists(artist_id);
CREATE INDEX IF NOT EXISTS setlists_gig_id_idx    ON setlists(gig_id);

-- ── song_arrangements ──────────────────────────────────────────────────────
-- Each row is one named arrangement version for a song.
-- is_active: at most one per song; enforced at app level, not DB.

CREATE TABLE IF NOT EXISTS song_arrangements (
  id                 SERIAL PRIMARY KEY,
  song_id            INTEGER NOT NULL REFERENCES songs(id)   ON DELETE CASCADE,
  artist_id          INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL DEFAULT 'Default',
  is_active          BOOLEAN NOT NULL DEFAULT false,
  hidden_instruments JSONB   NOT NULL DEFAULT '[]',
  rows               JSONB   NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS song_arrangements_song_id_idx
  ON song_arrangements(song_id);
CREATE INDEX IF NOT EXISTS song_arrangements_artist_id_idx
  ON song_arrangements(artist_id, song_id);

-- ── song_logs ──────────────────────────────────────────────────────────────
-- Append-only audit log. Every create, update, or soft-delete on a song
-- writes a row here with a full JSON snapshot of the song at that moment.
-- This allows restoring a deleted song from its last snapshot even if the
-- songs row was hard-deleted (song_id goes NULL via ON DELETE SET NULL).

CREATE TABLE IF NOT EXISTS song_logs (
  id         SERIAL PRIMARY KEY,
  artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  song_id    INTEGER REFERENCES songs(id) ON DELETE SET NULL, -- nullable: orphan = hard-deleted song
  action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  song_data  JSONB NOT NULL,   -- full songs row snapshot at time of action
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS song_logs_artist_idx  ON song_logs(artist_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS song_logs_song_id_idx ON song_logs(song_id);

-- ── setlist_songs ──────────────────────────────────────────────────────────
-- Junction table linking setlists to songs with explicit ordering.
-- PRIMARY KEY on (setlist_id, position) enforces unique slots within a setlist.
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

CREATE INDEX IF NOT EXISTS setlist_songs_song_id_idx ON setlist_songs(song_id);

-- ── gema_works ─────────────────────────────────────────────────────────────
-- Works registered with a performing-rights organisation (GEMA, SACEM, etc.).
-- Not every song needs a matching row; linking is via song_id FK.
-- Populated from GEMA CSV exports via scripts/import_gema.js or the /gema-import UI.

CREATE TABLE IF NOT EXISTS gema_works (
  id                     SERIAL PRIMARY KEY,
  artist_id              INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  gema_work_number       TEXT NOT NULL,           -- Werknummer, e.g. "15299392-001"
  title                  TEXT NOT NULL,           -- Titel (uppercase as exported)
  iswc                   TEXT,                    -- e.g. "T8034602217"
  isrc                   TEXT,
  publisher_work_numbers TEXT,                    -- Verlagswerknummern
  language               TEXT,                    -- normalised: DE, EN, FR, …
  performers             TEXT,                    -- Interpretinnen/Interpreten
  gema_genre             TEXT,                    -- Gattung, e.g. "FOLK", "SCHLAGER"
  duration_sec           INTEGER,                 -- Dauer in seconds
  first_registered_at    DATE,                    -- Erstmals geladen (DD.MM.YYYY → ISO)
  last_updated_at        DATE,                    -- Letzte Aktualisierung
  song_id                INTEGER REFERENCES songs(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (artist_id, gema_work_number)
);

CREATE INDEX IF NOT EXISTS gema_works_artist_id_idx ON gema_works(artist_id);
CREATE INDEX IF NOT EXISTS gema_works_song_id_idx   ON gema_works(song_id);

-- ── gema_rightholders ──────────────────────────────────────────────────────
-- One row per rightholder per work. Populated from GEMA's Beteiligte export.
-- Import is replace-all: existing rightholders for each work are deleted before
-- re-inserting. Roles stored in English (see ROLE_MAP in import_gema.js).

CREATE TABLE IF NOT EXISTS gema_rightholders (
  id                   SERIAL PRIMARY KEY,
  gema_work_id         INTEGER NOT NULL REFERENCES gema_works(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,               -- e.g. "SIEG KEVIN"
  ip_name_number       TEXT,                        -- IP-Name-Nr., e.g. "755143051"
  role                 TEXT NOT NULL,               -- composer | lyricist | publisher | arranger | sub-publisher
  role_order           TEXT,                        -- Reihenfolge Verlagsrollen (E1, E2, …)
  publisher_relation   TEXT,                        -- Urheber/-in-Verlagsbeziehung
  ar_share             NUMERIC(6,2),                -- AR-Anteil Detailansicht (%)
  vr_share             NUMERIC(6,2),                -- VR-Anteil Detailansicht (%)
  ar_share_cumulated   NUMERIC(6,2),                -- AR-Anteil (kumuliert) (%)
  vr_share_cumulated   NUMERIC(6,2),                -- VR-Anteil (kumuliert) (%)
  society_ar           TEXT,                        -- Gesellschaft AR: GEMA, SACEM, BMI, …
  society_vr           TEXT,                        -- Gesellschaft VR
  represents_name      TEXT,                        -- Vertritt: Name
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

-- ── subscribers ──────────────────────────────────────────────────────────────
-- Landing page email sign-ups and demo access leads.
-- source: 'landing' | 'demo'
-- meta (demo only): { country, region, city, ua, ref }

CREATE TABLE IF NOT EXISTS subscribers (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'landing',
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscribers_signup_token_idx
  ON subscribers ((meta->>'signup_token_hash'))
  WHERE meta ? 'signup_token_hash';

-- ── users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  artist_id         INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  password_hash     TEXT,                    -- NULL until invite accepted
  role              TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('admin', 'member', 'viewer')),
  invite_token_hash TEXT,                    -- SHA256(raw token), NULL after accepted
  invite_expires_at TIMESTAMPTZ,
  invited_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (artist_id, email)
);
-- Membership resolution in requireAuth joins users on email (multi-workspace
-- users share an email across rows) — runs on every authenticated request.
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

-- ── Future migrations ────────────────────────────────────────────────────────
-- Add ALTER TABLE … ADD COLUMN IF NOT EXISTS blocks here when the schema evolves.
-- Each block should carry a comment with the date it was added so the history
-- is readable without git blame.
--
-- Example:
--   -- 2026-06-01: add public share token to setlists
--   ALTER TABLE setlists ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;

-- 2026-05-27: add street address fields to venues
ALTER TABLE venues ADD COLUMN IF NOT EXISTS street_number TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS street        TEXT;

-- 2026-05-27: add free-text location to gigs for private/no-venue gigs
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS location TEXT;

-- 2026-05-28: geocoded coordinates for venue map
ALTER TABLE venues ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

-- 2026-05-29: gig poster and thumbnail (columns already added manually)
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS poster_url TEXT;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS thumb_url  TEXT;

-- 2026-06-08: multi-tenant signup — password_hash no longer required on artists
ALTER TABLE artists ALTER COLUMN password_hash DROP NOT NULL;

-- 2026-06-27: storage usage tracking per artist
ALTER TABLE artists ADD COLUMN IF NOT EXISTS storage_used_bytes BIGINT NOT NULL DEFAULT 0;

-- 2026-09-18: self-service email change (pending address + single-use token)
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_expires_at TIMESTAMPTZ;

-- 2026-09-21: venue contact data
ALTER TABLE venues ADD COLUMN IF NOT EXISTS phone        TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_name TEXT;
