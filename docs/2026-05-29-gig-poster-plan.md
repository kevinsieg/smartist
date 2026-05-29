# Gig Poster Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload a poster/flyer image per gig, auto-generate a 72×72 thumbnail client-side, show the thumbnail in the gig list, and open the full poster in a lightbox on click.

**Architecture:** Three new action branches added to the existing `api/[artist]/gigs/[id].js` handler (no new function). Client-side Canvas API generates poster (JPEG, ≤5 MB) + thumbnail (72×72 JPEG) before upload. Both blobs are PUT directly to R2 via presigned URLs. Schema columns `poster_url` and `thumb_url` already added to the `gigs` table.

**Tech Stack:** Neon PostgreSQL · Cloudflare R2 (`_r2.js` helpers) · Vanilla JS Canvas API · Vercel serverless (Node.js)

---

## File Map

| File | Change |
|------|--------|
| `api/[artist]/gigs/[id].js` | Add `crypto` + `_r2` imports; add POST/PUT/DELETE poster action branches |
| `app/gigs.html` | Add hidden file input + poster section div inside `#gig-modal` |
| `app/js/gigs.js` | Thumbnail column in `GIG_COLUMNS`; image processing utils; upload/remove functions; `renderPosterRow`; lightbox |
| `app/css/app.css` | `.gig-thumb-wrap`, `.gig-thumb`, `.gig-thumb-placeholder`, `.gig-thumb-add`, `.gig-lightbox`, `.gig-lightbox-img`, `.gig-poster-row`, `.gig-poster-thumb`, `.gig-poster-actions` |
| `scripts/schema.sql` | Add migration comment block |

---

## Task 1: Add imports and allowlist POST in `api/[artist]/gigs/[id].js`

**Files:**
- Modify: `api/[artist]/gigs/[id].js:1-13`

- [ ] **Step 1: Add `crypto` and `_r2` imports, extend method allowlist**

Replace the top of the file (lines 1-13):

```js
const crypto = require('crypto');
const { getDb, getArtist, getSlug } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { wrap } = require('../../_handler');
const { validateStr } = require('../../_validate');
const { createPresignedUrl, deleteFromR2, verifyUpload, keyFromUrl } = require('../../_r2');

module.exports = wrap(async function handler(req, res) {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method))
    return res.status(405).json({ error: 'Method not allowed' });

  const slug = getSlug(req);
  const gigId = Number(req.query.id);
  if (!Number.isInteger(gigId) || gigId <= 0) return res.status(400).json({ error: 'Invalid gig id' });

  const sql = getDb();
```

- [ ] **Step 2: Verify the file still parses**

```bash
node -e "require('./api/[artist]/gigs/[id].js')" && echo ok
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add api/\[artist\]/gigs/\[id\].js
git commit -m "feat: extend gigs/[id] to allow POST and import R2 helpers"
```

---

## Task 2: API — `POST ?action=poster-url`

**Files:**
- Modify: `api/[artist]/gigs/[id].js` — add branch after the existing GET block, before the shared auth block

- [ ] **Step 1: Add the branch**

After the `if (req.method === 'GET') { ... return res.json(gig); }` block and **before** the line `const artist = await requireAuth(...)`, insert nothing — poster-url needs auth, so it goes AFTER the shared auth/gig-fetch block. The shared auth block (lines 53–56) fetches the artist and gig for all non-GET methods. Add the new branch right after line 56 (`if (!gig) return res.status(404)...`):

```js
  // ── POST ?action=poster-url — get presigned upload URLs ──────────────────
  if (req.method === 'POST' && req.query.action === 'poster-url') {
    const { filename, contentType } = req.body ?? {};
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(contentType))
      return res.status(400).json({ error: 'Only JPEG, PNG, or WebP images are supported' });
    const uuid      = crypto.randomUUID();
    const posterKey = `gigs/${artist.slug}/${gigId}-${uuid}-poster.jpg`;
    const thumbKey  = `gigs/${artist.slug}/${gigId}-${uuid}-thumb.jpg`;
    const [poster, thumb] = await Promise.all([
      createPresignedUrl(posterKey, 'image/jpeg'),
      createPresignedUrl(thumbKey,  'image/jpeg'),
    ]);
    return res.json({
      posterUploadUrl: poster.uploadUrl,
      posterPublicUrl: poster.publicUrl,
      thumbUploadUrl:  thumb.uploadUrl,
      thumbPublicUrl:  thumb.publicUrl,
    });
  }
```

- [ ] **Step 2: Manually test content-type rejection**

With `vercel dev` running and `ARTIST_PASSWORD` set:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/$ARTIST_SLUG/auth \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ARTIST_PASSWORD\"}" | jq -r '.token')

curl -s -X POST "http://localhost:3000/api/$ARTIST_SLUG/gigs/1?action=poster-url" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"filename":"poster.pdf","contentType":"application/pdf"}' | jq
```

Expected: `{"error": "Only JPEG, PNG, or WebP images are supported"}`

- [ ] **Step 3: Manually test presigned URL generation**

```bash
curl -s -X POST "http://localhost:3000/api/$ARTIST_SLUG/gigs/1?action=poster-url" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"filename":"poster.jpg","contentType":"image/jpeg"}' | jq
```

Expected: JSON with `posterUploadUrl`, `posterPublicUrl`, `thumbUploadUrl`, `thumbPublicUrl`

- [ ] **Step 4: Commit**

```bash
git add api/\[artist\]/gigs/\[id\].js
git commit -m "feat: POST ?action=poster-url — presigned R2 upload URLs for gig poster"
```

---

## Task 3: API — `PUT ?action=poster`

**Files:**
- Modify: `api/[artist]/gigs/[id].js` — add branch before the existing `if (req.method === 'PUT')` block

- [ ] **Step 1: Add the branch**

Insert before the existing `if (req.method === 'PUT') {` line:

```js
  // ── PUT ?action=poster — confirm upload, save to DB ──────────────────────
  if (req.method === 'PUT' && req.query.action === 'poster') {
    const { posterUrl, thumbUrl } = req.body ?? {};
    if (!posterUrl || !thumbUrl)
      return res.status(400).json({ error: 'posterUrl and thumbUrl are required' });
    const [posterOk, thumbOk] = await Promise.all([
      verifyUpload(keyFromUrl(posterUrl)),
      verifyUpload(keyFromUrl(thumbUrl)),
    ]);
    if (!posterOk) return res.status(400).json({ error: 'Poster file not found in storage' });
    if (!thumbOk)  return res.status(400).json({ error: 'Thumbnail file not found in storage' });
    // Delete old files if replacing
    if (gig.poster_url) {
      await Promise.all([
        deleteFromR2(gig.poster_url).catch(() => {}),
        gig.thumb_url ? deleteFromR2(gig.thumb_url).catch(() => {}) : Promise.resolve(),
      ]);
    }
    await sql`
      UPDATE gigs
      SET poster_url = ${posterUrl}, thumb_url = ${thumbUrl}, last_updated = NOW()
      WHERE id = ${gigId} AND artist_id = ${artist.id}
    `;
    return res.json({ ok: true, posterUrl, thumbUrl });
  }
```

- [ ] **Step 2: Test missing body fields**

```bash
curl -s -X PUT "http://localhost:3000/api/$ARTIST_SLUG/gigs/1?action=poster" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}' | jq
```

Expected: `{"error": "posterUrl and thumbUrl are required"}`

- [ ] **Step 3: Commit**

```bash
git add api/\[artist\]/gigs/\[id\].js
git commit -m "feat: PUT ?action=poster — confirm gig poster upload and save to DB"
```

---

## Task 4: API — `DELETE ?action=poster`

**Files:**
- Modify: `api/[artist]/gigs/[id].js` — add branch before the existing `if (req.method === 'DELETE')` block

- [ ] **Step 1: Add the branch**

Insert before the existing `if (req.method === 'DELETE') {` line:

```js
  // ── DELETE ?action=poster — remove poster files and clear DB ─────────────
  if (req.method === 'DELETE' && req.query.action === 'poster') {
    if (gig.poster_url) await deleteFromR2(gig.poster_url).catch(() => {});
    if (gig.thumb_url)  await deleteFromR2(gig.thumb_url).catch(() => {});
    await sql`
      UPDATE gigs
      SET poster_url = NULL, thumb_url = NULL, last_updated = NOW()
      WHERE id = ${gigId} AND artist_id = ${artist.id}
    `;
    return res.json({ ok: true });
  }
```

- [ ] **Step 2: Test DELETE on a gig with no poster (idempotent)**

```bash
curl -s -X DELETE "http://localhost:3000/api/$ARTIST_SLUG/gigs/1?action=poster" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Expected: `{"ok": true}` (no error even if poster_url is null)

- [ ] **Step 3: Commit**

```bash
git add api/\[artist\]/gigs/\[id\].js
git commit -m "feat: DELETE ?action=poster — remove gig poster from R2 and DB"
```

---

## Task 5: CSS — thumbnail, lightbox, and modal poster styles

**Files:**
- Modify: `app/css/app.css` — append styles before the final `@media print` block (or at end of file)

- [ ] **Step 1: Find the end of the file to determine insertion point**

```bash
tail -20 app/css/app.css
```

- [ ] **Step 2: Append new styles**

Add at the end of `app/css/app.css`:

```css
/* ── Gig poster thumbnail (list) ────────────────────────────────────────── */
.gig-thumb-wrap {
    width: 36px; height: 36px; flex-shrink: 0;
    border-radius: 3px; overflow: hidden; cursor: pointer;
}
.gig-thumb {
    width: 36px; height: 36px; object-fit: cover; display: block;
    border-radius: 3px; transition: opacity 0.12s;
}
.gig-thumb:hover { opacity: 0.82; }
.gig-thumb-placeholder {
    width: 36px; height: 36px; border-radius: 3px;
    background: rgba(221,213,200,0.3); flex-shrink: 0;
}
.gig-thumb-add {
    cursor: pointer; position: relative;
    border: 1.5px dashed rgba(176,106,42,0.35);
    background: transparent;
}
.gig-thumb-add::after {
    content: '+'; position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 1rem; color: rgba(176,106,42,0.45);
}

/* ── Gig poster lightbox ─────────────────────────────────────────────────── */
.gig-lightbox {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.88); z-index: 500;
    align-items: center; justify-content: center; cursor: pointer;
}
.gig-lightbox-img {
    max-width: 90vw; max-height: 90vh;
    object-fit: contain; border-radius: 4px;
    cursor: default; pointer-events: none;
}

/* ── Gig poster upload row (edit modal) ─────────────────────────────────── */
.gig-poster-row { display: flex; align-items: center; gap: 0.75rem; }
.gig-poster-thumb {
    width: 52px; height: 52px; object-fit: cover;
    border-radius: 3px; flex-shrink: 0;
}
.gig-poster-actions { display: flex; flex-direction: column; gap: 0.3rem; }
```

- [ ] **Step 3: Commit**

```bash
git add app/css/app.css
git commit -m "feat: CSS for gig poster thumbnail, lightbox, and modal upload row"
```

---

## Task 6: HTML — poster section in `gigs.html`

**Files:**
- Modify: `app/gigs.html` — inside `#gig-modal`, before the `#gm-related` div

- [ ] **Step 1: Add hidden file input and poster section**

In `app/gigs.html`, find this line:

```html
    <div class="related-section" id="gm-related" style="display:none;">
```

Insert immediately before it:

```html
    <input type="file" id="gm-poster-input" accept="image/jpeg,image/png,image/webp"
           style="display:none" onchange="handlePosterSelect(this.files[0])">
    <div id="gm-poster-section" style="display:none">
      <hr style="border:none;border-top:1px solid var(--border-color);margin:0.9rem 0 0.75rem">
      <label style="display:block;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em;color:var(--third-color);margin-bottom:0.5rem;">Poster / Flyer</label>
      <div id="gm-poster-row"></div>
      <div class="status-msg" id="gm-poster-status"></div>
    </div>
```

- [ ] **Step 2: Verify HTML is valid**

Open `http://localhost:3000/gigs` in a browser — the gig edit modal should look identical to before (poster section hidden).

- [ ] **Step 3: Commit**

```bash
git add app/gigs.html
git commit -m "feat: add poster upload section and hidden file input to gig edit modal"
```

---

## Task 7: JS — client-side image processing utilities

**Files:**
- Modify: `app/js/gigs.js` — add utility functions near the top, after the variable declarations

- [ ] **Step 1: Add the three image utilities after the `_gigSongMatchGigIds` variable declaration (around line 16)**

```js
// ── Gig poster image utilities ────────────────────────────────────────────

function _loadImage(file) {
  return new Promise(function(resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function() { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = function() { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

function _canvasToJpegBlob(canvas, quality) {
  return new Promise(function(resolve) {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
}

async function generatePosterBlob(file) {
  var img = await _loadImage(file);
  var limits = [0, 2048, 1600, 1200]; // 0 = natural size first
  for (var i = 0; i < limits.length; i++) {
    var maxEdge = limits[i] || Math.max(img.naturalWidth, img.naturalHeight);
    var scale   = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    var canvas  = document.createElement('canvas');
    canvas.width  = Math.round(img.naturalWidth  * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    var blob = await _canvasToJpegBlob(canvas, 0.85);
    if (blob.size <= 5 * 1024 * 1024) return blob;
  }
  // Last resort: 1200px max, quality 0.6
  var canvas2 = document.createElement('canvas');
  var s2 = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  canvas2.width  = Math.round(img.naturalWidth  * s2);
  canvas2.height = Math.round(img.naturalHeight * s2);
  canvas2.getContext('2d').drawImage(img, 0, 0, canvas2.width, canvas2.height);
  return _canvasToJpegBlob(canvas2, 0.6);
}

async function generateThumbBlob(file) {
  var img  = await _loadImage(file);
  var size = Math.min(img.naturalWidth, img.naturalHeight);
  var sx   = (img.naturalWidth  - size) / 2;
  var sy   = (img.naturalHeight - size) / 2;
  var c    = document.createElement('canvas');
  c.width  = c.height = 72;
  c.getContext('2d').drawImage(img, sx, sy, size, size, 0, 0, 72, 72);
  return _canvasToJpegBlob(c, 0.85);
}
```

- [ ] **Step 2: Smoke-test in the browser console**

Open `http://localhost:3000/gigs`, open DevTools console, paste:

```js
var f = new File(['test'], 'test.jpg', {type: 'image/jpeg'});
// Should reject — can't draw a fake image — just check functions exist:
console.log(typeof generatePosterBlob, typeof generateThumbBlob, typeof _loadImage);
```

Expected: `function function function`

- [ ] **Step 3: Commit**

```bash
git add app/js/gigs.js
git commit -m "feat: client-side image resize utilities for gig poster thumbnail generation"
```

---

## Task 8: JS — `uploadPoster()` and `removePoster()`

**Files:**
- Modify: `app/js/gigs.js` — add after the image utilities

- [ ] **Step 1: Add the two API-wiring functions**

```js
async function uploadPoster(gigId, file) {
  setStatus('gm-poster-status', 'Processing image…');
  try {
    var [posterBlob, thumbBlob] = await Promise.all([
      generatePosterBlob(file),
      generateThumbBlob(file),
    ]);
    setStatus('gm-poster-status', 'Uploading…');
    var r1 = await apiFetch('/api/' + artistSlug + '/gigs/' + gigId + '?action=poster-url', 'POST', {
      filename:    file.name,
      contentType: file.type,
    });
    if (!r1.ok) {
      var e1 = await r1.json();
      throw new Error(e1.error || 'Could not get upload URL');
    }
    var urls = await r1.json();
    await Promise.all([
      fetch(urls.posterUploadUrl, { method: 'PUT', body: posterBlob, headers: { 'Content-Type': 'image/jpeg' } }),
      fetch(urls.thumbUploadUrl,  { method: 'PUT', body: thumbBlob,  headers: { 'Content-Type': 'image/jpeg' } }),
    ]);
    var r2 = await apiFetch('/api/' + artistSlug + '/gigs/' + gigId + '?action=poster', 'PUT', {
      posterUrl: urls.posterPublicUrl,
      thumbUrl:  urls.thumbPublicUrl,
    });
    if (!r2.ok) {
      var e2 = await r2.json();
      throw new Error(e2.error || 'Could not save poster');
    }
    var gig = allGigs.find(function(g) { return g.id === gigId; });
    if (gig) { gig.poster_url = urls.posterPublicUrl; gig.thumb_url = urls.thumbPublicUrl; }
    renderGigs();
    renderPosterRow(gig);
    setStatus('gm-poster-status', '');
  } catch (err) {
    setStatus('gm-poster-status', err.message || 'Upload failed', true);
  }
}

async function removePoster(gigId) {
  setStatus('gm-poster-status', 'Removing…');
  try {
    var r = await apiFetch('/api/' + artistSlug + '/gigs/' + gigId + '?action=poster', 'DELETE');
    if (!r.ok) {
      var e = await r.json();
      throw new Error(e.error || 'Could not remove poster');
    }
    var gig = allGigs.find(function(g) { return g.id === gigId; });
    if (gig) { gig.poster_url = null; gig.thumb_url = null; }
    renderGigs();
    renderPosterRow(gig);
    setStatus('gm-poster-status', '');
  } catch (err) {
    setStatus('gm-poster-status', err.message || 'Remove failed', true);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/js/gigs.js
git commit -m "feat: uploadPoster() and removePoster() — gig poster R2 upload flow"
```

---

## Task 9: JS — `renderPosterRow()`, `handlePosterSelect()`, `confirmRemovePoster()`

**Files:**
- Modify: `app/js/gigs.js`

- [ ] **Step 1: Add the three UI functions**

```js
function renderPosterRow(g) {
  var row = document.getElementById('gm-poster-row');
  if (!row) return;
  if (!g) { row.innerHTML = ''; return; }
  if (g.thumb_url) {
    row.innerHTML =
      '<div class="gig-poster-row">' +
        '<img class="gig-poster-thumb" src="' + escHtml(g.thumb_url) + '">' +
        '<div class="gig-poster-actions">' +
          '<button class="btn" type="button" onclick="document.getElementById(\'gm-poster-input\').click()">Replace</button>' +
          '<button class="btn" type="button" id="gm-poster-remove-btn" onclick="confirmRemovePoster()">Remove</button>' +
        '</div>' +
      '</div>';
  } else {
    row.innerHTML =
      '<button class="btn" type="button" onclick="document.getElementById(\'gm-poster-input\').click()">Upload poster</button>';
  }
}

function confirmRemovePoster() {
  var btn = document.getElementById('gm-poster-remove-btn');
  if (!btn) return;
  if (btn.dataset.confirm === '1') {
    removePoster(editingId);
  } else {
    btn.textContent = 'Confirm remove';
    btn.dataset.confirm = '1';
    setTimeout(function() {
      if (btn.isConnected) { btn.textContent = 'Remove'; delete btn.dataset.confirm; }
    }, 3000);
  }
}

async function handlePosterSelect(file) {
  if (!file || !editingId) return;
  var allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!allowed.has(file.type)) {
    setStatus('gm-poster-status', 'Only JPEG, PNG, or WebP images are accepted', true);
    document.getElementById('gm-poster-input').value = '';
    return;
  }
  await uploadPoster(editingId, file);
  document.getElementById('gm-poster-input').value = '';
}
```

- [ ] **Step 2: Commit**

```bash
git add app/js/gigs.js
git commit -m "feat: renderPosterRow, handlePosterSelect, confirmRemovePoster UI functions"
```

---

## Task 10: JS — wire poster section into `openEditModal` and `openAddModal`

**Files:**
- Modify: `app/js/gigs.js:338-380`

- [ ] **Step 1: Update `openAddModal()`**

In `openAddModal()`, add one line before `openModal('gig-modal')`:

```js
  var ps = document.getElementById('gm-poster-section');
  if (ps) ps.style.display = 'none';
```

- [ ] **Step 2: Update `openEditModal(id)`**

In `openEditModal(id)`, add these lines before `openModal('gig-modal')`:

```js
  var ps = document.getElementById('gm-poster-section');
  if (ps) {
    ps.style.display = '';
    setStatus('gm-poster-status', '');
    renderPosterRow(g);
  }
```

- [ ] **Step 3: Test in browser**

1. Open `http://localhost:3000/gigs`
2. Click "Add gig" — confirm the poster section is **not** visible
3. Click "Edit" on any gig — confirm the poster section **is** visible with "Upload poster" button
4. Click "Upload poster" — file picker should open
5. Select a JPEG image — status should cycle through "Processing image…" → "Uploading…" → thumbnail appears

- [ ] **Step 4: Commit**

```bash
git add app/js/gigs.js
git commit -m "feat: show poster upload row in edit modal, hide in add modal"
```

---

## Task 11: JS — thumbnail column in `GIG_COLUMNS` and lightbox

**Files:**
- Modify: `app/js/gigs.js:20` (`GIG_COLUMNS` array definition)

- [ ] **Step 1: Prepend thumbnail column to `GIG_COLUMNS`**

Replace the opening of the `GIG_COLUMNS` array:

```js
var GIG_COLUMNS = [
  { field: 'thumb_url', label: '', width: '44px', sortable: false,
    render: function(g) {
      if (g.thumb_url) {
        return '<div class="gig-thumb-wrap" onclick="event.stopPropagation();openLightbox(\'' + escHtml(g.poster_url) + '\')">' +
               '<img class="gig-thumb" src="' + escHtml(g.thumb_url) + '" loading="lazy"></div>';
      }
      if (!_viewMode) {
        return '<div class="gig-thumb-placeholder gig-thumb-add" onclick="event.stopPropagation();openEditModal(' + g.id + ')" title="Upload poster"></div>';
      }
      return '<div class="gig-thumb-placeholder"></div>';
    }
  },
  { field: 'date', label: 'Date', width: '75px', sortable: true, type: 'date',
    render: g => { if (!g.date) return '—'; var d = String(g.date); return d.slice(8, 10) + '/' + d.slice(5, 7); } },
  // ... rest of columns unchanged
```

- [ ] **Step 2: Add lightbox functions after `GIG_COLUMNS`**

```js
var _gigLightboxEl = null;

function _ensureLightbox() {
  if (_gigLightboxEl) return;
  _gigLightboxEl = document.createElement('div');
  _gigLightboxEl.className = 'gig-lightbox';
  _gigLightboxEl.innerHTML = '<img class="gig-lightbox-img" src="" alt="Poster">';
  _gigLightboxEl.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeLightbox(); });
  document.body.appendChild(_gigLightboxEl);
}

function openLightbox(url) {
  if (!url) return;
  _ensureLightbox();
  _gigLightboxEl.querySelector('.gig-lightbox-img').src = url;
  _gigLightboxEl.style.display = 'flex';
}

function closeLightbox() {
  if (_gigLightboxEl) _gigLightboxEl.style.display = 'none';
}
```

- [ ] **Step 3: Test thumbnail column and lightbox**

1. Open `http://localhost:3000/gigs`
2. Confirm all gig rows now have a small placeholder square on the left
3. Click a placeholder (auth mode) — edit modal should open
4. Upload a poster via the modal
5. After upload: thumbnail appears in the list row
6. Click the thumbnail — lightbox overlay opens with full poster
7. Click backdrop or press Escape — lightbox closes
8. Open in view mode (log out) — thumbnails visible, placeholders non-interactive

- [ ] **Step 4: Commit**

```bash
git add app/js/gigs.js
git commit -m "feat: gig poster thumbnail in list, lightbox on click"
```

---

## Task 12: `schema.sql` — add migration comment block

**Files:**
- Modify: `scripts/schema.sql` — append to the "Future migrations" section at the bottom

- [ ] **Step 1: Append migration record**

At the end of `scripts/schema.sql`, add:

```sql
-- 2026-05-29: gig poster and thumbnail (columns already added manually)
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS poster_url TEXT;
ALTER TABLE gigs ADD COLUMN IF NOT EXISTS thumb_url  TEXT;
```

- [ ] **Step 2: Commit**

```bash
git add scripts/schema.sql
git commit -m "docs: record gig poster_url/thumb_url migration in schema.sql"
```

---

## Task 13: End-to-end integration test

- [ ] **Step 1: Full upload flow**

1. Start `vercel dev`
2. Log in at `http://localhost:3000`
3. Go to `/gigs`, click Edit on any gig
4. Upload a large JPEG (> 5 MB phone photo) — verify no error, thumbnail appears in < 30s
5. Close modal — verify thumbnail visible in list row
6. Click thumbnail — lightbox opens with full poster at correct dimensions
7. Press Escape — lightbox closes
8. Re-open edit modal — verify thumbnail preview and Replace/Remove buttons visible
9. Click Replace — upload a PNG — verify thumbnail updates in modal and list
10. Click Remove → Confirm remove — verify thumbnail disappears from modal and list
11. Log out — verify thumbnails still visible in view mode, placeholders non-interactive

- [ ] **Step 2: Error path test**

1. In edit modal, try uploading a PDF file — verify client-side rejection message appears without any network call

- [ ] **Step 3: Bump CSS cache version** 

In all `*.html` files, update `app.css?v=13` → `app.css?v=14` and `gigs.js` version query if any:

```bash
find app -name "*.html" -exec sed -i '' 's/app\.css?v=13/app.css?v=14/g' {} \;
```

- [ ] **Step 4: Final commit**

```bash
git add app/
git commit -m "feat: bump CSS version after gig poster styles"
```
