# Gig Poster Upload — Design Spec
_2026-05-29_

## Overview

Allow authenticated users to upload a poster image (flyer, event photo) for each gig. A thumbnail is generated client-side and shown in the gig list for both authenticated and view-mode users. Clicking a thumbnail opens a lightbox with the full-size poster.

---

## Schema

Already applied manually to both Neon dev and Neon main:

```sql
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS poster_url TEXT;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS thumb_url  TEXT;
```

Both columns are nullable. Existing gigs are unaffected.

---

## API — `api/[artist]/gigs/[id].js`

No new serverless function. Three new action branches added to the existing handler. All require authentication.

### `POST ?action=poster-url`

Request presigned upload URLs for poster + thumbnail.

**Body:** `{ filename: string, contentType: string }`

**Response:**
```json
{
  "posterUploadUrl": "https://...",
  "posterPublicUrl": "https://...",
  "thumbUploadUrl":  "https://...",
  "thumbPublicUrl":  "https://..."
}
```

**R2 key pattern:**
- Poster: `gigs/{artistSlug}/{gigId}-poster.jpg`
- Thumb:  `gigs/{artistSlug}/{gigId}-thumb.jpg`

Validation: `contentType` must be one of `image/jpeg`, `image/png`, `image/webp`.

### `PUT ?action=poster`

Confirm upload complete, persist URLs to DB.

**Body:** `{ posterUrl: string, thumbUrl: string }`

- Verifies both files exist in R2 via `verifyUpload`
- Updates `gigs SET poster_url = $1, thumb_url = $2 WHERE id = $id AND artist_id = $artistId`
- Deletes previous poster and thumb from R2 if replacing (old URLs read from DB before update)

### `DELETE ?action=poster`

Remove poster files and clear DB columns.

- Reads current `poster_url` and `thumb_url` from DB
- Deletes both from R2
- Sets both columns to NULL

---

## Client-side Thumbnail Generation

Happens entirely in the browser before any upload. No server-side image processing.

**Accepted types:** `image/jpeg`, `image/png`, `image/webp`. Any other type is rejected immediately with a user-facing error before any network call.

**Poster processing:**
1. Draw image onto a hidden `<canvas>` at original dimensions
2. Export as JPEG at quality 0.85
3. If resulting blob > 5 MB: reduce the longest edge progressively (2048px → 1600px → 1200px) and re-export until under 5 MB
4. Result is always JPEG regardless of input format

**Thumbnail processing:**
1. Draw image onto a 72×72px canvas (2× retina for 36×36 display), preserving aspect ratio with centre crop
2. Export as JPEG at quality 0.85
3. Always < 50 KB — no size check needed

**Upload sequence:**
1. Generate poster blob + thumb blob
2. `POST ?action=poster-url` → receive two presigned URLs
3. `PUT` poster blob + `PUT` thumb blob to R2 in parallel (`Promise.all`)
4. `PUT ?action=poster` to confirm and persist
5. Update modal preview and list row thumbnail without page reload

---

## Upload UI — Edit Modal (`gigs.js` / `gigs.html`)

Below the existing form fields, separated by a `<hr>`, a compact poster row is always shown for authenticated users. Hidden in view mode via `auth-only`.

**No poster state:**
```
[  +  ]  [Upload poster]
placeholder
```

**Poster exists state:**
```
[ img ]  [Replace]  filename.jpg
         [Remove]
```

- Upload triggers immediately on file select — does not wait for the Save button
- Uploading state: spinner replaces the thumbnail preview, buttons disabled
- Error state: brief error message below the row, buttons re-enabled
- "Remove" shows inline confirm text ("Remove? Yes / Cancel") — no modal

---

## Gig List Display (`gigs.js`)

A new column prepended to `GIG_COLUMNS`:

```js
{
  field: 'thumb_url',
  label: '',
  width: '44px',
  sortable: false,
  render: function(g) { /* thumbnail or placeholder */ }
}
```

- **Has poster** (`g.thumb_url` set): `<img src="..." class="gig-thumb">` — clicking opens lightbox
- **No poster, auth mode**: muted placeholder square, clicking opens edit modal for that gig (poster section)
- **No poster, view mode**: muted placeholder square, non-interactive
- Applies to both upcoming and past gig tables

---

## Lightbox

Plain DOM implementation in `gigs.js`. No library dependency.

- Fixed full-screen overlay, `background: rgba(0,0,0,0.85)`, `z-index: 500`
- `poster_url` image centred, `max-width: 90vw; max-height: 90vh; object-fit: contain`
- Close on: click backdrop, press Escape
- Injected once into `document.body` on first use, reused thereafter
- Works in auth and view mode

---

## Files Changed

| File | Change |
|------|--------|
| `api/[artist]/gigs/[id].js` | Add `poster-url`, `poster` (PUT), `poster` (DELETE) action branches |
| `app/js/gigs.js` | Thumbnail column in `GIG_COLUMNS`; poster upload UI in edit modal; lightbox |
| `app/css/app.css` | `.gig-thumb`, `.gig-thumb-placeholder`, `.gig-lightbox` styles |
| `scripts/schema.sql` | Add `ALTER TABLE` migration comment block |

---

## Constraints

- No new serverless function (stays within Hobby plan 12-function limit)
- No server-side image processing (no `sharp` or similar dependency)
- PDF excluded — canvas thumbnail generation not supported without PDF.js
- Poster upload is decoupled from the gig Save action — happens immediately on file select
