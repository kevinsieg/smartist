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
2. **Band** — create a new band (slug, name, password) or select an existing one to reconfigure.
3. **Fields** — choose which song fields appear in the songs table and setlist generator; add custom `extra.*` fields.
4. **Review** — confirm and save to the database.

To apply the schema directly without the wizard:

```bash
psql $DATABASE_URL < scripts/schema.sql
```

---

## import_songs.js — bulk import

```bash
node scripts/import_songs.js --band <slug> songs.json
```

The JSON file must be an array of song objects. Only `title` is required; all other fields are optional:

```json
[
  {
    "title": "Song Title",
    "active": true,
    "key": "G",
    "genre": "Blues",
    "tempo": "Medium",
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
node scripts/import_gema.js --band <slug> --ids "Identifikatoren-Table 1.csv"

# Work info (language, genre, duration, performers)
node scripts/import_gema.js --band <slug> --info "Werkinformationen-Table 1.csv"

# Rightholders (composers, publishers, AR/VR shares)
node scripts/import_gema.js --band <slug> --beteiligte "Beteiligte-Table 1.csv"

# All three at once
node scripts/import_gema.js --band <slug> \
  --ids "Identifikatoren-Table 1.csv" \
  --info "Werkinformationen-Table 1.csv" \
  --beteiligte "Beteiligte-Table 1.csv"

# Preview without writing
node scripts/import_gema.js --band <slug> --ids <...> --dry-run
```

**Title matching** (`--ids` / `--info`): each work is auto-linked to a song by matching the GEMA title (case-insensitive, German umlaut ASCII-folding) against `songs.title`. Unmatched works are imported with `song_id = NULL` for manual linking later via the UI.

**Rightholder import** (`--beteiligte`): replace-all per work — existing rightholders for each affected work are deleted before re-inserting. Re-runs are idempotent.

The web UI at `/gema-import` runs the same pipeline interactively with a dry-run preview step.
