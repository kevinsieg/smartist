# Scripts

All scripts read `DATABASE_URL` from the environment or from `.env` / `.env.local` in the project root.

---

## setup.js — first-time setup

Run once per environment (local, production):

```bash
node scripts/setup.js
```

Four interactive steps:

1. **Schema** — checks whether tables exist; offers to apply `schema.sql` if not.
2. **Band** — create a new band (slug, name, and its admin's email and password) or select an existing one to reconfigure.
3. **Fields** — choose which song fields appear in the songs table and setlist generator; add custom `extra.*` fields.
4. **Review** — confirm and save to the database.

To apply the schema without the wizard, use `apply_schema.js` (below).

---

## apply_schema.js — bring an existing database up to date

`setup.js` skips the schema step once tables exist; this always runs every statement of
`schema.sql` (idempotent), so new tables, columns and indexes reach existing databases.
Run it against **every** production database after a schema change.

```bash
node scripts/apply_schema.js                          # database from .env
DATABASE_URL=<url> node scripts/apply_schema.js       # any other
node scripts/apply_schema.js --check                  # list pending migrations, change nothing
```

---

## create_user.js — first login for a band, or set a password

Signup creates a *new* band, and invites need an admin who is already signed in. A band that
has no `users` row (created before accounts existed, or by hand) cannot be signed into — the
shared band password is retired — so this writes the first one. The password is read without
echo and stored as a bcrypt hash.

```bash
node scripts/create_user.js --artist <slug> --email <addr> [--role admin|member|viewer]
node scripts/create_user.js --artist <slug> --email <addr> --set-password   # existing account
USER_PASSWORD=… node scripts/create_user.js --artist <slug> --email <addr> --yes   # unattended
```

---

## plans.js — plans and storage

```bash
node scripts/plans.js                                   # every band: plan, storage used/limit, songs, users
node scripts/plans.js --artist <slug> --plan <free|pro> # grant or change a plan
node scripts/plans.js --recount                         # recompute storage_used_bytes from R2
```

---

## demo_reset.js — the public demo band

The demo band lives in the production database next to real bands; every statement is scoped to
its `artist_id`. The artists row and its users are left alone.

```bash
node scripts/demo_reset.js --export     # snapshot the band into scripts/demo_seed.json
node scripts/demo_reset.js --dry-run    # show what a restore would change
node scripts/demo_reset.js --yes        # restore without a prompt (the nightly GitHub Action)
```

---

## seed.js — dev database seeder

Populates the database with realistic test data for local development. Run this after `setup.js` creates the band.

```bash
node scripts/seed.js            # seed (skips if songs already exist)
node scripts/seed.js --force    # wipe all band data and reseed
```

Targets the band whose slug matches `ARTIST_SLUG` in your `.env`, or the first band in the database.

**Production guard:** the database hostname is shown on startup and must be confirmed before anything runs. Combined with the `--force` requirement for wipes, this prevents accidental data loss.

Inserts:

- 20 songs across genres (Rock, Blues, Folk, Country, Funk, Soul, Reggae, Alternative), with varied keys, tempos, and lengths; 2 inactive songs; some with `extra.capo`
- 4 gigs (2 past, 1 upcoming June 2026, 1 TBD)
- 4 setlists (2 linked to past gigs, 1 for the upcoming gig, 1 standalone 30-min template)
- Song audit log entries (create/update/delete)
- 2 GEMA works with 3 rightholders each

---


## import_venues.js — bulk venue import

Imports venues from a CSV file. Columns: `NOM LIEU, ADRESSE, CP, MAIL, TEL, REMARQUES`. Fuzzy duplicate detection prompts `[s]kip / [i]nsert / [m]erge` for each potential match.

```bash
node scripts/import_venues.js --artist <slug> venues.csv
```

---

## import_songs.js — bulk import

```bash
node scripts/import_songs.js --artist <slug> songs.json
```

The JSON file must be an array of song objects. Only `title` is required; all other fields are optional:

```json
[
  {
    "title": "Song Title",
    "active": true,
    "key": "G",
    "genre": "Blues",
    "energy": "middle",
    "time_signature": "4/4",
    "bpm": 120,
    "length_min": 3.5,
    "interpret": "Artist",
    "reference_interpret": "Reference artist",
    "comment": "Notes",
    "extra": { "capo": 2, "lead": "Alice" }
  }
]
```

Songs without a `title` are skipped. The script does not deduplicate — running it twice inserts duplicates.

---

## import_gema.js — GEMA CSV import

Imports works and rightholders from GEMA CSV exports. Accepts any combination of the three export types from the same batch:

```bash
# Identifiers (ISWC, ISRC)
node scripts/import_gema.js --artist <slug> --ids "Identifikatoren-Table 1.csv"

# Work info (language, genre, duration, performers)
node scripts/import_gema.js --artist <slug> --info "Werkinformationen-Table 1.csv"

# Rightholders (composers, publishers, AR/VR shares)
node scripts/import_gema.js --artist <slug> --beteiligte "Beteiligte-Table 1.csv"

# All three at once
node scripts/import_gema.js --artist <slug> \
  --ids "Identifikatoren-Table 1.csv" \
  --info "Werkinformationen-Table 1.csv" \
  --beteiligte "Beteiligte-Table 1.csv"

# Preview without writing
node scripts/import_gema.js --artist <slug> --ids <...> --dry-run
```

**Title matching** (`--ids` / `--info`): each work is auto-linked to a song by matching the GEMA title (case-insensitive, German umlaut ASCII-folding) against `songs.title`. Unmatched works are imported with `song_id = NULL` for manual linking later via the UI.

**Rightholder import** (`--beteiligte`): replace-all per work — existing rightholders for each affected work are deleted before re-inserting. Re-runs are idempotent.

The web UI at `/<slug>/pro-import` runs the same pipeline interactively with a dry-run preview step (Pro plan).

---

## delete_artist.js — remove one artist and all its data

```bash
node scripts/delete_artist.js --artist <slug>
```

Prints the DB hostname, the artist name and a row count per table, then requires the slug
to be typed back. The deletion runs in one transaction in the order `DATABASE.md` documents:

1. `gigs.venue_id` / `gigs.organizer_id` are `ON DELETE RESTRICT` → set to NULL first.
2. References from *other* artists into this one (setlist rows naming its songs, gigs naming its
   venues or organizers) are removed or nulled, so they cannot block the delete.
3. `setlist_songs.song_id` has no cascade → delete the setlists first (that cascades their songs).
4. `DELETE FROM artists` cascades songs, venues, organizers, gigs, arrangements, logs, users and GEMA works.

Other artists are untouched. R2 files (audio, sheets, playback) are **not** deleted — the script
warns how many songs still reference them; remove those in the Cloudflare dashboard or with
`wrangler r2 object delete`.
