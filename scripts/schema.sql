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
-- `platforms` in config: streaming and social URLs managed via /hub.
-- See DATABASE.md §Band config for the full shape.

CREATE TABLE IF NOT EXISTS artists (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,             -- URL-safe identifier, e.g. "myband"
  name          TEXT NOT NULL,                    -- display name, e.g. "My Band"
  config        JSONB NOT NULL DEFAULT '{}'
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
  energy              SMALLINT CHECK (energy BETWEEN 0 AND 10),  -- 0 calm … 10 intense; shown as Low/Middle/High
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
-- is readable without git blame, and end by recording that date in
-- schema_migrations. Set SCHEMA_VERSION in api/_env.js to the newest date:
-- GET /api/config?action=health then says whether a database is behind, and
-- `node scripts/apply_schema.js --check` lists what a database is missing.
--
-- Example:
--   -- 2026-06-01: add public share token to setlists
--   ALTER TABLE setlists ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;
--   INSERT INTO schema_migrations (id) VALUES ('2026-06-01') ON CONFLICT DO NOTHING;
--
-- Blocks older than the ledger (before 2026-09-29) record nothing.

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

-- 2026-06-27: storage usage tracking per artist
ALTER TABLE artists ADD COLUMN IF NOT EXISTS storage_used_bytes BIGINT NOT NULL DEFAULT 0;

-- 2026-09-18: self-service email change (pending address + single-use token)
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_expires_at TIMESTAMPTZ;

-- 2026-09-21: venue contact data
ALTER TABLE venues ADD COLUMN IF NOT EXISTS phone        TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_name TEXT;

-- 2026-09-23: self-service account deletion. The emailed confirmation link is
-- single-use and short-lived; the hash is stored, never the token. Mirrors
-- invite_token_hash / invite_expires_at directly above.
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_token_hash    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_token_expires TIMESTAMPTZ;

-- 2026-09-24: emails are stored lowercased. OAuth signup used to keep the
-- provider's casing, and every lookup is an exact match, so a mixed-case row
-- could neither log in by password nor be found by some paths. The UPDATE fails
-- on a (artist_id, email) collision rather than merging accounts — resolve by
-- hand if it does. The CHECK keeps any future write path honest (a re-run
-- reports "already exists", which apply_schema.js skips).
UPDATE users       SET email         = lower(email)         WHERE email         <> lower(email);
UPDATE users       SET pending_email = lower(pending_email) WHERE pending_email <> lower(pending_email);
UPDATE subscribers SET email         = lower(email)         WHERE email         <> lower(email);
ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));

-- 2026-09-28: favourite venues and organizers, same meaning as songs.heart
ALTER TABLE venues     ADD COLUMN IF NOT EXISTS heart BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS heart BOOLEAN NOT NULL DEFAULT false;

-- 2026-09-29: songs load fast. Lyrics (up to 20 000 characters each) move out of
-- songs.extra into their own table, so the song list no longer carries them;
-- they are read with one song's details. Language becomes a real column.
-- Both moves are safe to re-run: rows still carrying the old keys (written by
-- an older deployment between this migration and the code rollout) are moved
-- again, and the newer value wins.
CREATE TABLE IF NOT EXISTS song_lyrics (
  song_id    INTEGER PRIMARY KEY REFERENCES songs(id)   ON DELETE CASCADE,
  artist_id  INTEGER NOT NULL    REFERENCES artists(id) ON DELETE CASCADE,
  lyrics     TEXT    NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS song_lyrics_artist_id_idx ON song_lyrics(artist_id);
ALTER TABLE songs ADD COLUMN IF NOT EXISTS language TEXT;
INSERT INTO song_lyrics (song_id, artist_id, lyrics)
  SELECT id, artist_id, extra->>'lyrics' FROM songs
  WHERE NULLIF(btrim(extra->>'lyrics'), '') IS NOT NULL
  ON CONFLICT (song_id) DO UPDATE SET lyrics = EXCLUDED.lyrics, updated_at = now();
UPDATE songs SET extra = extra - 'lyrics' WHERE extra ? 'lyrics';
UPDATE songs SET language = NULLIF(upper(btrim(extra->>'language')), ''), extra = extra - 'language'
  WHERE extra ? 'language';

-- 2026-09-29: the audit log's CHECK only allowed create/update/delete, so every
-- lyrics and media entry was rejected (and the error swallowed by
-- insertAuditLog). NOT VALID: checks new rows only, never fails on old ones.
ALTER TABLE song_logs DROP CONSTRAINT IF EXISTS song_logs_action_check;
ALTER TABLE song_logs ADD CONSTRAINT song_logs_action_known CHECK (action IN (
  'create', 'update', 'delete', 'lyrics_update', 'lyrics_delete',
  'audio_replace', 'audio_delete', 'sheet_replace', 'sheet_delete',
  'playback_replace', 'playback_delete')) NOT VALID;

-- 2026-09-29: foreign keys that deletion had to work around by hand. Songs are
-- only ever hard-deleted together with their band, so cascading setlist rows
-- loses nothing; an inviter's removal leaves the invitee's row in place.
ALTER TABLE setlist_songs ADD CONSTRAINT setlist_songs_song_cascade_fkey
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE;
ALTER TABLE setlist_songs DROP CONSTRAINT IF EXISTS setlist_songs_song_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_invited_by_set_null_fkey
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_invited_by_fkey;

-- 2026-09-29: redundant indexes. songs_list_idx (artist_id, deleted, title)
-- serves every songs query; the unique (artist_id, gema_work_number) key
-- already leads with artist_id.
DROP INDEX IF EXISTS songs_artist_id_idx;
DROP INDEX IF EXISTS songs_band_active_idx;
DROP INDEX IF EXISTS gema_works_artist_id_idx;

-- 2026-09-29: at most one active arrangement per song, enforced. Older rows
-- that broke the rule keep only the most recently updated one active.
UPDATE song_arrangements SET is_active = false
  WHERE is_active AND id NOT IN (
    SELECT DISTINCT ON (song_id) id FROM song_arrangements
    WHERE is_active ORDER BY song_id, updated_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS song_arrangements_one_active_idx
  ON song_arrangements(song_id) WHERE is_active;

-- 2026-09-28: references stay inside one band. Ids are one sequence across all
-- bands, so a plain id FK accepts another band's row; these composite keys make
-- the database refuse it, whatever the API checks. The (id, artist_id) unique
-- keys are what the composite FKs point at. SET NULL (col) clears only the id,
-- never artist_id (Postgres 15+). setlist_songs has no artist_id and is covered
-- by _ownership.js only.
ALTER TABLE venues     ADD CONSTRAINT venues_id_artist_key     UNIQUE (id, artist_id);
ALTER TABLE organizers ADD CONSTRAINT organizers_id_artist_key UNIQUE (id, artist_id);
ALTER TABLE gigs       ADD CONSTRAINT gigs_id_artist_key       UNIQUE (id, artist_id);
ALTER TABLE songs      ADD CONSTRAINT songs_id_artist_key      UNIQUE (id, artist_id);
ALTER TABLE gigs ADD CONSTRAINT gigs_venue_same_band_fkey
  FOREIGN KEY (venue_id, artist_id) REFERENCES venues(id, artist_id) ON DELETE RESTRICT;
ALTER TABLE gigs ADD CONSTRAINT gigs_organizer_same_band_fkey
  FOREIGN KEY (organizer_id, artist_id) REFERENCES organizers(id, artist_id) ON DELETE RESTRICT;
ALTER TABLE setlists ADD CONSTRAINT setlists_gig_same_band_fkey
  FOREIGN KEY (gig_id, artist_id) REFERENCES gigs(id, artist_id) ON DELETE SET NULL (gig_id);
ALTER TABLE song_logs ADD CONSTRAINT song_logs_song_same_band_fkey
  FOREIGN KEY (song_id, artist_id) REFERENCES songs(id, artist_id) ON DELETE SET NULL (song_id);
ALTER TABLE song_arrangements ADD CONSTRAINT song_arrangements_song_same_band_fkey
  FOREIGN KEY (song_id, artist_id) REFERENCES songs(id, artist_id) ON DELETE CASCADE;
ALTER TABLE song_lyrics ADD CONSTRAINT song_lyrics_song_same_band_fkey
  FOREIGN KEY (song_id, artist_id) REFERENCES songs(id, artist_id) ON DELETE CASCADE;
ALTER TABLE gema_works ADD CONSTRAINT gema_works_song_same_band_fkey
  FOREIGN KEY (song_id, artist_id) REFERENCES songs(id, artist_id) ON DELETE SET NULL (song_id);

-- 2026-09-30: migration ledger. Each block from here on ends by recording its
-- date; the health check and `apply_schema.js --check` read it. Everything
-- above is covered by this first entry.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (id) VALUES ('2026-09-30') ON CONFLICT DO NOTHING;

-- 2026-10-01: the shared band password is retired, every login is a users row.
-- The 2026-06-08 block that relaxed this column was removed with it: it fails
-- once the column is gone.
ALTER TABLE artists DROP COLUMN IF EXISTS password_hash;
INSERT INTO schema_migrations (id) VALUES ('2026-10-01') ON CONFLICT DO NOTHING;

-- 2026-10-02: artists.social_links is superseded by config.platforms and
-- nothing reads it.
ALTER TABLE artists DROP COLUMN IF EXISTS social_links;
INSERT INTO schema_migrations (id) VALUES ('2026-10-02') ON CONFLICT DO NOTHING;

-- 2026-10-03: theme tags on songs (several per song, free-form per band).
ALTER TABLE songs ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS songs_tags_idx ON songs USING GIN (tags);
INSERT INTO schema_migrations (id) VALUES ('2026-10-03') ON CONFLICT DO NOTHING;

-- 2026-10-04: "log out everywhere". Session tokens issued before this time are
-- refused (api/_token.js sessionValid); set on every row of the address.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ;
INSERT INTO schema_migrations (id) VALUES ('2026-10-04') ON CONFLICT DO NOTHING;

-- 2026-10-05: venues.subgenres was never read or written. Delete snapshots
-- from before songs.language and the lyrics table (tempo, extra.language,
-- extra.lyrics); the restore no longer converts them.
ALTER TABLE venues DROP COLUMN IF EXISTS subgenres;
DELETE FROM song_logs
WHERE song_data ? 'tempo' OR song_data->'extra' ? 'lyrics' OR song_data->'extra' ? 'language';
INSERT INTO schema_migrations (id) VALUES ('2026-10-05') ON CONFLICT DO NOTHING;
