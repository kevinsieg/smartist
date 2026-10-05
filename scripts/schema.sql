-- Smartist — Database Schema
-- Authoritative schema for a fresh database.
--
-- Idempotent: safe to re-run — CREATE TABLE IF NOT EXISTS skips existing tables.
-- The tables below are the schema as of 2026-10-06, every earlier migration
-- folded in. Later changes go at the bottom as dated blocks (see "Migrations").
--
-- To apply to a new or existing database:
--   psql $DATABASE_URL < scripts/schema.sql
--   or:  node scripts/setup.js   (interactive, confirms DB host first)
--
-- Tables (dependency order):
--   artists, venues, organizers, gigs, songs, setlists, song_arrangements,
--   song_lyrics, song_logs, setlist_songs, gema_works, gema_rightholders,
--   rate_limits, subscribers, users, schema_migrations

-- ── artists ──────────────────────────────────────────────────────────────────
-- One row per band. Multi-tenant: every band's rows are scoped to artist_id
-- (setlist_songs and gema_rightholders through their parent); rate_limits,
-- subscribers and schema_migrations are global.
-- The API is keyed by `slug` (URL-safe short name, e.g. "myband").
-- `config` is a JSONB object that drives the UI without schema changes:
--   displayFields: which song columns appear in the songs table
--   filterFields:  which fields produce filter buttons in the setlist generator
--   logoUrl:       path or URL to the band logo
-- `platforms` in config: streaming and social URLs managed via /hub.
-- See DATABASE.md §Artist config for the full shape.

CREATE TABLE IF NOT EXISTS artists (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,             -- URL-safe identifier, e.g. "myband"
  name          TEXT NOT NULL,                    -- display name, e.g. "My Band"
  config        JSONB NOT NULL DEFAULT '{}',
  storage_used_bytes BIGINT NOT NULL DEFAULT 0  -- uploaded media, for plan limits
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
  size                    INTEGER,
  language                TEXT,
  last_updated            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  street_number           TEXT,
  street                  TEXT,
  lat                     DOUBLE PRECISION,           -- geocoded, for the venue map
  lng                     DOUBLE PRECISION,
  phone                   TEXT,
  contact_name            TEXT,
  heart                   BOOLEAN NOT NULL DEFAULT false,  -- favourite, as songs.heart
  -- (id, artist_id) is what the band-scoped composite FKs point at: ids are one
  -- sequence across all bands, so a plain id FK would accept another band's row.
  CONSTRAINT venues_id_artist_key UNIQUE (id, artist_id)
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
  last_updated       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heart              BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT organizers_id_artist_key UNIQUE (id, artist_id)
);

CREATE INDEX IF NOT EXISTS organizers_artist_id_idx ON organizers(artist_id);

-- ── gigs ───────────────────────────────────────────────────────────────────
-- A performance event. Setlists can optionally be linked to a gig.
-- venue_id and organizer_id are nullable FKs with ON DELETE RESTRICT —
-- deleting a linked venue/organizer is blocked until all gig references are cleared.
-- The *_same_band_fkey keys make the database refuse another band's venue or
-- organizer, whatever the API checks.

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
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  location        TEXT,             -- free text for private / no-venue gigs
  poster_url      TEXT,
  thumb_url       TEXT,
  CONSTRAINT gigs_id_artist_key UNIQUE (id, artist_id),
  CONSTRAINT gigs_venue_same_band_fkey FOREIGN KEY (venue_id, artist_id)
    REFERENCES venues(id, artist_id) ON DELETE RESTRICT,
  CONSTRAINT gigs_organizer_same_band_fkey FOREIGN KEY (organizer_id, artist_id)
    REFERENCES organizers(id, artist_id) ON DELETE RESTRICT
);

-- GET /gigs and the ICS feed sort a band's gigs by date.
CREATE INDEX IF NOT EXISTS gigs_artist_date_idx  ON gigs(artist_id, date DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS gigs_venue_id_idx     ON gigs(venue_id);
CREATE INDEX IF NOT EXISTS gigs_organizer_id_idx ON gigs(organizer_id);

-- ── songs ──────────────────────────────────────────────────────────────────
-- The song catalogue. Songs are soft-deleted (deleted = true) rather than
-- removed so that setlist history and the audit log remain intact.
--
-- Standard fields cover the common metadata every band needs.
-- `extra` holds band-specific fields (e.g. capo positions, lead singer)
-- defined per band in artists.config without requiring schema migrations.
-- Lyrics live in song_lyrics, so the song list never carries them.
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
  energy              SMALLINT CHECK (energy BETWEEN 0 AND 10),  -- 0 calm … 10 intense; shown as Low/Middle/High
  time_signature      TEXT,             -- e.g. "4/4", "3/4", "6/8"
  bpm                 INTEGER,          -- beats per minute
  length_min          REAL,             -- duration in decimal minutes, e.g. 3.5 = 3:30
  interpret           TEXT,             -- main performer or band known for this song
  reference_interpret TEXT,             -- artist of a specific reference recording
  comment             TEXT,             -- free-form notes visible to the band
  extra               JSONB NOT NULL DEFAULT '{}', -- band-specific fields
  deleted             BOOLEAN NOT NULL DEFAULT false,
  language            TEXT,             -- uppercase code, e.g. "DE", "EN"
  tags                TEXT[] NOT NULL DEFAULT '{}',  -- theme tags, free-form per band
  CONSTRAINT songs_id_artist_key UNIQUE (id, artist_id)
);

-- songs_list_idx serves every songs query.
CREATE INDEX IF NOT EXISTS songs_list_idx        ON songs(artist_id, deleted, title);
CREATE INDEX IF NOT EXISTS songs_tags_idx        ON songs USING GIN (tags);

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- SET NULL (gig_id) clears only the id, never artist_id (Postgres 15+).
  CONSTRAINT setlists_gig_same_band_fkey FOREIGN KEY (gig_id, artist_id)
    REFERENCES gigs(id, artist_id) ON DELETE SET NULL (gig_id)
);

CREATE INDEX IF NOT EXISTS setlists_artist_created_idx ON setlists(artist_id, created_at DESC);
CREATE INDEX IF NOT EXISTS setlists_gig_id_idx    ON setlists(gig_id);

-- ── song_arrangements ──────────────────────────────────────────────────────
-- Each row is one named arrangement version for a song.
-- is_active: at most one per song (song_arrangements_one_active_idx).

CREATE TABLE IF NOT EXISTS song_arrangements (
  id                 SERIAL PRIMARY KEY,
  song_id            INTEGER NOT NULL REFERENCES songs(id)   ON DELETE CASCADE,
  artist_id          INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL DEFAULT 'Default',
  is_active          BOOLEAN NOT NULL DEFAULT false,
  hidden_instruments JSONB   NOT NULL DEFAULT '[]',
  rows               JSONB   NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT song_arrangements_song_same_band_fkey FOREIGN KEY (song_id, artist_id)
    REFERENCES songs(id, artist_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS song_arrangements_song_id_idx
  ON song_arrangements(song_id);
CREATE INDEX IF NOT EXISTS song_arrangements_artist_id_idx
  ON song_arrangements(artist_id, song_id);
CREATE UNIQUE INDEX IF NOT EXISTS song_arrangements_one_active_idx
  ON song_arrangements(song_id) WHERE is_active;

-- ── song_lyrics ────────────────────────────────────────────────────────────
-- One song's lyrics (up to 20 000 characters), read with that song's details.

CREATE TABLE IF NOT EXISTS song_lyrics (
  song_id    INTEGER PRIMARY KEY REFERENCES songs(id)   ON DELETE CASCADE,
  artist_id  INTEGER NOT NULL    REFERENCES artists(id) ON DELETE CASCADE,
  lyrics     TEXT    NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT song_lyrics_song_same_band_fkey FOREIGN KEY (song_id, artist_id)
    REFERENCES songs(id, artist_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS song_lyrics_artist_id_idx ON song_lyrics(artist_id);

-- ── song_logs ──────────────────────────────────────────────────────────────
-- Append-only audit log. Every create, update, or soft-delete on a song
-- writes a row here with a full JSON snapshot of the song at that moment.
-- This allows restoring a deleted song from its last snapshot even if the
-- songs row was hard-deleted (song_id goes NULL via ON DELETE SET NULL).

CREATE TABLE IF NOT EXISTS song_logs (
  id         SERIAL PRIMARY KEY,
  artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  song_id    INTEGER REFERENCES songs(id) ON DELETE SET NULL, -- nullable: orphan = hard-deleted song
  action     TEXT NOT NULL,
  song_data  JSONB NOT NULL,   -- full songs row snapshot at time of action
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT song_logs_action_known CHECK (action IN (
    'create', 'update', 'delete', 'lyrics_update', 'lyrics_delete',
    'audio_replace', 'audio_delete', 'sheet_replace', 'sheet_delete',
    'playback_replace', 'playback_delete')),
  CONSTRAINT song_logs_song_same_band_fkey FOREIGN KEY (song_id, artist_id)
    REFERENCES songs(id, artist_id) ON DELETE SET NULL (song_id)
);

CREATE INDEX IF NOT EXISTS song_logs_artist_idx  ON song_logs(artist_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS song_logs_song_id_idx ON song_logs(song_id);

-- ── setlist_songs ──────────────────────────────────────────────────────────
-- Junction table linking setlists to songs with explicit ordering.
-- PRIMARY KEY on (setlist_id, position) enforces unique slots within a setlist.
--
-- Soft-deleting a song keeps the historical setlists that included it: the
-- song row stays (deleted = true), so joins from setlist_songs still resolve.
-- Songs are hard-deleted only with their band or by the 90-day purge
-- (purgeDeletedSongs in api/_db.js), which skips songs a setlist lists, so the
-- cascade loses nothing. setlist_songs has no artist_id; _ownership.js keeps it in one band.

CREATE TABLE IF NOT EXISTS setlist_songs (
  setlist_id INTEGER NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
  song_id    INTEGER NOT NULL,
  position   INTEGER NOT NULL,                        -- 0-based display order
  PRIMARY KEY (setlist_id, position),
  CONSTRAINT setlist_songs_song_cascade_fkey FOREIGN KEY (song_id)
    REFERENCES songs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS setlist_songs_song_id_idx ON setlist_songs(song_id);

-- ── gema_works ─────────────────────────────────────────────────────────────
-- Works registered with a performing-rights organisation (GEMA, SACEM, etc.).
-- Not every song needs a matching row; linking is via song_id FK.
-- Populated from GEMA CSV exports via scripts/import_gema.js or the /pro-import page.

CREATE TABLE IF NOT EXISTS gema_works (
  id                     SERIAL PRIMARY KEY,
  artist_id              INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  gema_work_number       TEXT NOT NULL,           -- Werknummer, e.g. "12345678-001"
  title                  TEXT NOT NULL,           -- Titel (uppercase as exported)
  iswc                   TEXT,                    -- e.g. "T0000000000"
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
  UNIQUE (artist_id, gema_work_number),            -- also serves lookups by artist_id
  CONSTRAINT gema_works_song_same_band_fkey FOREIGN KEY (song_id, artist_id)
    REFERENCES songs(id, artist_id) ON DELETE SET NULL (song_id)
);

CREATE INDEX IF NOT EXISTS gema_works_song_id_idx   ON gema_works(song_id);

-- ── gema_rightholders ──────────────────────────────────────────────────────
-- One row per rightholder per work. Populated from GEMA's Beteiligte export.
-- Import is replace-all: existing rightholders for each work are deleted before
-- re-inserting. Roles stored in English (see ROLE_MAP in api/_domain/gema.js).

CREATE TABLE IF NOT EXISTS gema_rightholders (
  id                   SERIAL PRIMARY KEY,
  gema_work_id         INTEGER NOT NULL REFERENCES gema_works(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,               -- e.g. "DOE JANE"
  ip_name_number       TEXT,                        -- IP-Name-Nr., e.g. "123456789"
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
-- Sliding-window rate limiting for sign-in, reset, sign-up, invites, shares,
-- uploads and other endpoints. One row per key, `<purpose>:<IP, address or
-- band id>`; the window resets on the next request after
-- it expires. checkRateLimit (api/_ratelimit.js) now and then sweeps rows idle
-- for over a day.

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,        -- e.g. "auth:1.2.3.4", "reset:you@example.com", "invite:12"
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx ON rate_limits(window_start);

-- ── subscribers ──────────────────────────────────────────────────────────────
-- Landing page email sign-ups, demo access leads and pending sign-up links.
-- source: 'landing' | 'demo' | 'signup'
-- meta: demo { name, genres, perform_country, geo_country };
--       signup { signup_token_hash, signup_token_expires } while a link is pending

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
-- One row per person per band. Emails are stored lowercased (CHECK below);
-- every lookup is an exact match. Token columns hold SHA256 hashes, never the
-- token. An inviter's removal leaves the invitee's row in place.

CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  artist_id         INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  password_hash     TEXT,                    -- NULL until invite accepted
  role              TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('admin', 'member', 'viewer')),
  invite_token_hash TEXT,                    -- SHA256(raw token), NULL after accepted
  invite_expires_at TIMESTAMPTZ,
  invited_by        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  pending_email           TEXT,              -- self-service email change
  email_change_token_hash TEXT,
  email_change_expires_at TIMESTAMPTZ,
  delete_token_hash       TEXT,              -- self-service account deletion
  delete_token_expires    TIMESTAMPTZ,
  sessions_valid_after    TIMESTAMPTZ,       -- "log out everywhere" (api/_token.js)
  UNIQUE (artist_id, email),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_invited_by_set_null_fkey FOREIGN KEY (invited_by)
    REFERENCES users(id) ON DELETE SET NULL
);
-- Membership resolution in requireAuth joins users on email (multi-workspace
-- users share an email across rows) — runs on every authenticated request.
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

-- ── schema_migrations ──────────────────────────────────────────────────────
-- The migration ledger: one row per dated block. The health check and
-- `apply_schema.js --check` read it. The tables above already include every
-- migration up to 2026-10-06, so a fresh database records them all.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (id) VALUES ('2026-09-30') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (id) VALUES ('2026-10-01') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (id) VALUES ('2026-10-02') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (id) VALUES ('2026-10-03') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (id) VALUES ('2026-10-04') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (id) VALUES ('2026-10-05') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (id) VALUES ('2026-10-06') ON CONFLICT DO NOTHING;

-- ── Migrations ───────────────────────────────────────────────────────────────
-- Append a dated block here when the schema evolves: IF NOT EXISTS / IF EXISTS
-- everywhere, no DO $$ blocks, ending by recording its date in
-- schema_migrations. Set SCHEMA_VERSION in api/_env.js to the newest date:
-- GET /api/config?action=health then says whether a database is behind, and
-- `node scripts/apply_schema.js --check` lists what a database is missing.
--
-- Each statement runs with a 5 s lock_timeout (scripts/apply_schema.js), so a
-- deploy fails instead of freezing a table that a long query holds. A new
-- index on an existing table is CREATE INDEX CONCURRENTLY IF NOT EXISTS: it
-- takes no write lock. Should one fail half-way it stays behind INVALID, and
-- IF NOT EXISTS then skips it: DROP INDEX it and deploy again.
--
-- Example:
--   -- 2026-10-08: add public share token to setlists
--   ALTER TABLE setlists ADD COLUMN IF NOT EXISTS share_token TEXT;
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS setlists_share_token_idx ON setlists(share_token);
--   INSERT INTO schema_migrations (id) VALUES ('2026-10-08') ON CONFLICT DO NOTHING;

-- 2026-10-07: index users.invited_by. Removing a user sets invited_by to NULL
-- on the rows it invited (ON DELETE SET NULL), which scanned the whole users
-- table once per removed user. CONCURRENTLY: no write lock on a live table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_invited_by_idx ON users(invited_by);
INSERT INTO schema_migrations (id) VALUES ('2026-10-07') ON CONFLICT DO NOTHING;
