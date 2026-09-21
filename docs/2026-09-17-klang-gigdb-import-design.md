# Kevin Klang gigdb import — design

**Date:** 2026-09-17
**Target workspace:** `klang` (Kevin Klang)
**Status:** approved 2026-09-17

## Goal

Bring Kevin's old Numbers database (exported as CSV in `data/gigdb/`) into the `klang` workspace: own songs, GEMA works, covers, gigs with setlists, organizers (incl. events, press, radio) and the venue list. Salmons and CK data is out of scope. Run first against the **smartist-demo** Neon project, verify there, then prod.

## Pipeline

```
data/gigdb/*.csv ──► data/clean.js ──► data/clean/*.json + REPORT.md
                                   ▲
   kevinklang/src/data/events.ts ──┘ (gig locations + extra gigs)
data/check_venues.js ──► data/clean/venue_web_check.json (website verdicts)

data/clean/*.json ──► data/import.js --db <url> ──► demo DB ──► verify ──► prod
```

- Everything under `data/` stays gitignored (personal data, one-off scripts).
- Committed changes: schema, venues/organizers API + UI, i18n.
- `clean.js` has no DB access and is re-runnable; the report must show `errors=0` before import.

## Source → target decisions

| Source | Target | Rule |
|---|---|---|
| contacts, platforms | — | dropped |
| songs + gemaSongs | `songs` (`interpret = 'Kevin Klang'`) | merged by legacy id; Salmon & The Laundry Bear works excluded; duplicate "Ruhetag" merged (kept id 21) |
| gemaSongs with work number | `gema_works` | ISWC normalized to `T##########`; linked to the song |
| covers | `songs` | Option A: 60 flagged `setlistKevin` → active; 14 unflagged but used in old gigs → inactive; rest dropped. `DP` → interpret "Traditional" |
| gigs (78 rows = sets) | `gigs` (53) + `setlists` (78) | grouped by date+title; one setlist per set (`Set n HH:MM–HH:MM`), own songs then covers |
| events.ts (106 entries not in export) | `gigs` without setlists | date, title, location, venue link where matched |
| organizers | `organizers` | 45 rows |
| events / press / radios | `organizers` with type `event` / `press` / `radio` | "Radio Fips" and "Stadtkonzerte" merged with existing rows |
| venues | `venues` | only `alive = 1` (1997); 3 exact duplicates merged |

### Field details

**Own songs:** `key` (H→B), `genre`, `energy` (kept on the export's 1–10 scale; `setlist.js energyNorm` already handles numbers), `time_signature` ← musicalMeasure, `bpm`, `length_min` ← live duration else recording duration, `active` ← playLive, `comment`.
`extra`: `legacy`, `author`, `language`, `theme`, `subTheme`, `description`, `recordingStatus`, `writingStatus`, `gitCapo`, `harp`, `harpKey`, `singalong`, `firstLiveYear`, `createdAt`, `recordingLengthSec`, `album`, `albumTrackNumber`, `releaseDate`, `label`, `publisher`, `formerTitle`.

**Covers:** `interpret`, `reference_interpret`, `key`, `genre`, `bpm`, `length_min`, `comment`.
`extra`: `legacy`, `gitCapo`, `harp`, `liveStatus` (good/middle/bad), `yearAdded`, `germanSetlist`.

**Gigs:**
- `location` = "Venue, City" from `events.ts`, matched by date. 6 export gigs have no site entry on their date and are matched by title instead (Weltweihnachtsmarkt, Gassenfreitag).
- `venue_id` is set when the location matches an imported venue by name+city. The export's own venue ids are broken and are ignored.
- `additional_text`/`additional_link` hold the co-artist.
- The gig→event link (2 gigs) has no column and is dropped.

**Venues:**
- New columns `phone` and `contact_name`.
- `generic_email` gets the first valid email. Further emails, the contact person's phone and text deadlines are appended to `comment`.
- `size` is an integer (parsed from e.g. "12.000 (2011)[21]").
- Country codes become the English names used by `geo.js`.
- `last_communication` becomes an ISO date.
- City notes such as "(bis 2008)" are moved to the comment.
- Missing location data is looked up (`data/enrich_venues.js`, results cached) and only fills empty fields:
  - Postcode and state: OpenPLZ by town (postcode only if the town has exactly one) or the exact street address.
  - Coordinates: exact street address via OpenStreetMap (street-level), otherwise postcode + town or town only (town-level). Accepted only if OSM returns the same town or the village/district itself.
  - City for venues without one: OpenStreetMap venue-name search, only for venue-type results that are unambiguous or confirmed by the town in the website/email domain; listed in `REPORT.md` for confirmation.

### Mapping to existing app values (original value appended to `comment` when it changes)

**Venue status** (`VENUE_STATUSES`):

| Export | App |
|---|---|
| empty | empty |
| hot, todo, possible | `prospect` |
| retry, waiting, ongoing | `contacted` |
| confirmed | `confirmed` |
| not relevant, not interested, not possible, not solo, rejected, no more concerts, only locals, only via booking agency | `declined` |

Note: `confirmed` is a public status (`VENUE_PUBLIC_STATUSES`), so these 7 venues become visible in view mode if the workspace is not private.

**Venue category** (`VENUE_CATEGORIES`):

| Export | App |
|---|---|
| Festival, Open Air | `festival` |
| Bar, Cafe, Cafe Bar, Kneipe, Pub, Bistro, Biergarten, Keller, Club Bar, Brauerei | `pub` |
| Club, Rock Club, Cafe Club | `club` |
| Restaurant, Hotel, Rock'n'Roll Hotel & Bar | `restaurant` |
| Kulturzentrum, Jugendzentrum, Verein für Soziokultur…, Studentenwerk, Theater, Saal, Konzerthaus, Kloster | `association` |
| Markt | `street` |
| everything else (Camping, Hof, Radio, Studio, Shop, …) | empty, original in comment |

**Gig type** (gigs select):

| Export | App |
|---|---|
| Solo, Band, SoloSupport, Open Stage, Songslam, Competition | `concert` |
| SoloRoomConcert | `private` |
| Radio | `other` |
| events.ts entries titled/venue "Privat" | `private` |
| other events.ts entries | empty |

**Organizer type** (organizers select):
- The select gets three new options `event`, `press`, `radio` in addition to `person`/`organization`.
- Export organizer types (Kulturverein, Booking Agentur, …) become `organization`, with the original in `extra.subType`.
- Event subtype (Wettbewerb/Open Stage/Show), genre and turnus go into `extra`.

## Venue websites

Every venue website was checked (`data/check_venues.js`: GET with redirects, 12 s timeout, then the site root for failing deep links, then a slower retry of every failure). No status column is stored.

- **ok** — imported unchanged.
- **dead** (domain gone, HTTP 410, redirect to a domain-parking page, still failing on retry) — `website` set to NULL and `Website offline (geprüft <date>): <url>` appended to `comment`. The venue itself is still imported.
- **still unclear after retry** (TLS/5xx errors) — imported unchanged, listed in `REPORT.md` for manual follow-up.

## Code changes (committed)

1. **`scripts/schema.sql`:**
   - `ALTER TABLE venues ADD COLUMN IF NOT EXISTS phone TEXT; ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_name TEXT;`
   - Documented in `DATABASE.md`.
2. **`api/[artist]/venues.js` (POST) and `venues/[...path].js` (PUT):**
   - Accept `phone` (validateStr 100) and `contact_name` (validateStr 200).
   - The map payload (`?all`) is unchanged, so no private contact data goes public.
   - Bug fix: POST now also stores `postcode` (≤20), `generic_email` (≤254) and `website` (≤500); before, only PUT saved them.
3. **`app/venues.html` + `app/js/venues.js`:** phone and contact name fields in the venue modal.
4. **`app/organizers.html` + `app/js/organizers.js`:** type options event/press/radio and their labels.
5. **i18n:**
   - New keys in `en/fr/de.json`.
   - Bump `I18N_VERSION` and the `i18n.js?v=` query.
   - `node tests/unit.js` must pass.
6. **Tests:**
   - Unit coverage for the venue PUT/POST handling of `phone` and `contact_name`, following the existing handler tests in `tests/unit/`. (`tests/api.js` has no venue write tests; none are added, to avoid leaving test data behind.)

## Import script (`data/import.js`, not committed)

- **Usage:** `DATABASE_URL=<url> node data/import.js --artist klang [--dry-run]`. Shows the hostname and requires typing `y`.
- **Prerequisites checked, abort if missing:**
  - Artist exists.
  - Plan is `pro` (venues/organizers are Pro features and free has a 20-song cap).
  - New venue columns exist.
- **Transaction:** the whole import runs in one `sql.begin` (all-or-nothing), in this order:
  1. organizers
  2. venues (batch insert)
  3. songs (own, then covers; a `song_logs` create entry per new song)
  4. gema_works
  5. gigs
  6. setlists + `setlist_songs` (batch `unnest` insert)
- **Dry-run** runs the same transaction and rolls it back, so the counts are real.
- **Idempotent** through natural keys, so a re-run creates nothing new:
  - songs: `lower(title)` + interpret
  - organizers: `lower(name)`
  - venues: `lower(name)` + `lower(city)`
  - gigs: `date` (if exactly one existing gig that day), else `date` + `lower(title)`
  - gema_works: `(artist_id, gema_work_number)` upsert with COALESCE
- **Existing rows** (prod may already have songs or GEMA works) only get their empty fields filled, never overwritten. `extra` is merged with `||`, so existing keys win: `new_extra || existing_extra`.
- Setlists are created only for gigs created in this run.
- `setlists.created_at` = gig date, so history sorts correctly.

### Demo DB preparation

1. `DATABASE_URL=<demo-url> node scripts/apply_schema.js`
2. Create the `klang` artist on demo if missing (`scripts/setup.js`), then `node scripts/plans.js --artist klang --plan pro`.

## Verification on demo

- **Dry-run counts** match `REPORT.md`:
  - 55 own songs, 74 covers, 32 GEMA works
  - 53 + 106 gigs, 78 setlists
  - 104 organizers, 1997 venues
- **Second real run** reports 0 inserts.
- **UI walkthrough** (`demo.smartist.studio` or `vercel dev` against demo):
  - Songs list shows own songs and covers.
  - A gig with 4 sets (Moosacher Musiknacht) shows 4 setlists with the right songs.
  - Venue modal shows phone and contact name; venues with dead sites have no website and a comment note.
  - Organizer types display.
  - Saving a venue keeps its status/category.
- Discard the demo data afterwards (delete the `klang` artist on demo; cascades).

## Prod rollout (after demo sign-off)

1. Create a Neon branch of prod as a backup.
2. Deploy code changes via the normal `dev` → `main` PR.
3. `apply_schema.js` on prod.
4. `import.js --dry-run` on prod: review matches against existing klang data.
5. Real run.

## Demo DB

The smartist-demo development branch is the database already configured as `DATABASE_URL` in the local `.env`; scripts use it from there (no credentials on the command line or in files).
