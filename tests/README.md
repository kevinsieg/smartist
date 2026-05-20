# Tests

Two test layers — unit tests (no infrastructure) and integration tests (need a live server).

---

## Unit tests

Test pure helper functions with no server, database, or network required. Run anywhere Node 20+ is available.

```bash
npm run test:unit           # from repo root
npm run test:unit           # from tests/ directory
node tests/unit.js          # API helper unit tests only
node tests/history-client.js # history page client helper tests only
```

**What is covered:**

| Module | Functions |
|--------|-----------|
| `api/_validate.js` | `validateSongIds`, `validateStr`, `validateNum`, `validateEmail` |
| `api/_auth.js` | `checkCredentials` magic-token and bcrypt paths |
| `api/_token.js` | `generateMagicToken`, `verifyMagicToken` |
| `api/_pdf.js` | `setlistTitle` |
| `api/_r2.js` | `keyFromUrl`, `filenameFromUrl` |
| `api/_ratelimit.js` | client IP extraction, missing-table detection |
| `api/_handler.js` | success logging, 500 sanitisation, headers-sent safety |
| `api/[band]/gema/import.js` | CSV parsing, rightholder parsing, GEMA value normalisation |
| `api/_ai.js` | `suggestLyricsWithAI` skip/error handling and Gemini response cleanup |
| `app/js/setlist-history.js` | response parsing helpers |

The full unit suite runs automatically on every push via GitHub Actions (`.github/workflows/ci.yml`).

---

## Integration tests

Full API coverage against a live server. Requires `vercel dev` running locally, or a deployed URL.

### Setup

Integration tests load `.env.local` then `.env` from the **repo root** (paths are fixed relative to `tests/api.js`, so `npm test` from `tests/` still works). Each key is applied only if not already set, so a variable present in both files keeps the `.env.local` value. Values already exported in the shell win over both files. Quote-wrapped lines (from `vercel env pull`) are stripped when parsed.

To enable write tests, add your band password:

```
BAND_PASSWORD=yourpassword
```

### Running

```bash
# Local (needs vercel dev running on port 3000)
cd tests && npm test
BAND_PASSWORD=xxx npm test

# Against the dev Preview deployment
npm run test:dev
BAND_PASSWORD=xxx npm run test:dev

# Against production (read-only)
npm run test:prod

# Override URL explicitly
BASE_URL=https://your-preview.vercel.app node tests/api.js
```

### What is tested

**Read-only (always run)**

| Area | Checks |
|------|--------|
| `GET /api/config` | returns slug, name, songs array |
| `GET /api/:band/songs` | array with play_count and last_played_at |
| `GET /api/:band/songs/:id/setlists` | appearances list |
| `GET /api/:band/song-logs` | audit log with action and song_data |
| `GET /api/:band/gigs` | array; single gig by id |
| `GET /api/:band/setlists` | array with song_count; single setlist with ordered songs |
| Auth rejections | every write endpoint returns 401 without a token; wrong password returns 401; PUT /setlists/:id → 401 |
| Validation | id=0 → 400, non-integer id → 400, missing required fields → 400, unknown id → 404 |

**Write (requires `BAND_PASSWORD`)**

| Area | Checks |
|------|--------|
| `POST /api/:band/auth` | correct password → 200 |
| Song lifecycle | create → patch → delete → restore → delete (DB left clean) |
| `POST /api/:band/songs` | missing title → 400 |
| Lyrics suggest | rejects songs without an artist before calling external providers |
| Setlist lifecycle | `POST` (create) → 201, `POST` (share) validates email + unknown id, `PUT` updates title, `POST` (duplicate) → 201 with new id + matching song count |
| `POST /api/:band/setlists` | missing song_ids → 400 |
| File upload validation | extension, MIME type, size, presigned URL prefix checks |
| Lyrics lifecycle | PUT, GET verify, DELETE, idempotent DELETE |
| `GET /api/:band/export` | 200 with `Content-Disposition: attachment`, songs/setlists/gigs arrays present |

> **Note:** write tests create two setlists named `[TEST]` that cannot be deleted via the API. Remove them manually from the setlist history page if needed.

### Exit codes

- `0` — all tests passed
- `1` — one or more tests failed or `BAND_SLUG` is not set
