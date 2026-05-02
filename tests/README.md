# API Tests

Integration tests for the Band Tools API. No dependencies — runs with Node 18+.

## Setup

Tests read credentials from `.env.local` in the `tests/` directory or the repo root (whichever exists). No extra configuration needed beyond what `vercel dev` already uses.

To enable write tests, add your band password:

```
BAND_PASSWORD=yourpassword
```

to `.env.local` (it is never sent anywhere except your local API).

## Running

Start the dev server first:

```bash
vercel dev
```

Then in a second terminal:

```bash
cd tests
npm test                  # read-only tests
BAND_PASSWORD=xxx npm test   # + write tests
npm run test:prod         # against production (read-only)
BAND_PASSWORD=xxx npm run test:prod  # against production with writes
```

Or from the repo root without `cd`:

```bash
node tests/api.js
BAND_PASSWORD=xxx node tests/api.js
BASE_URL=https://yourapp.example.com node tests/api.js
```

## What is tested

**Read-only (always run)**

| Area | Checks |
|------|--------|
| `GET /api/config` | returns slug, name, songs array |
| `GET /api/:band/songs` | array with play_count and last_played_at |
| `GET /api/:band/songs/:id/setlists` | appearances list |
| `GET /api/:band/song-logs` | audit log with action and song_data |
| `GET /api/:band/gigs` | array; single gig by id |
| `GET /api/:band/setlists` | array with song_count; single setlist with ordered songs |
| Auth rejections | every write endpoint returns 401 without a token; wrong password returns 401 |
| Validation | id=0 → 400, non-integer id → 400, missing required fields → 400, unknown id → 404 |

**Write (requires `BAND_PASSWORD`)**

| Area | Checks |
|------|--------|
| `POST /api/:band/auth` | correct password → 200 |
| Song lifecycle | create → patch → delete → restore → delete (DB left clean) |
| `POST /api/:band/songs` | missing title → 400 |
| Setlist create | `POST` → 201, `PUT` updates title, `POST .../duplicate` returns new id |
| `POST /api/:band/setlists` | missing song_ids → 400 |
| `GET /api/:band/export` | 200 with `Content-Disposition: attachment`, songs/setlists/gigs arrays present |

> **Note:** write tests create two setlists named `[TEST]` that cannot be deleted via the API. Remove them manually from the setlist history page if needed.

## Exit codes

- `0` — all tests passed
- `1` — one or more tests failed or `BAND_SLUG` is not set
