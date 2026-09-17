# Subscription Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-band plan/tier system that gates features and storage/song limits from one config file, with a self-serve upgrade, a super-admin overview, and Stripe-ready seams — no real billing yet.

**Architecture:** A single registry module `api/_plans.js` is the source of truth (`getPlan(artist)` is the only seam billing later replaces). Enforcement is server-authoritative (HTTP 402 + machine-readable codes); the client mirrors it for UX. Current plan lives in `artists.config.plan`; storage usage in a new atomic `artists.storage_used_bytes` column.

**Tech Stack:** Node serverless (Vercel, no build step), postgres.js against Neon, vanilla JS frontend, custom node unit-test runner (`tests/unit/`), HMAC tokens (`api/_token.js`).

## Global Constraints

- **No new serverless functions** — 12-function Hobby limit. New endpoints ride existing handlers (`api/config.js`). Static pages are not functions.
- **postgres.js**: never `JSON.stringify()` JSONB; patch with `config || ${obj}`.
- **Auth**: mutating handlers use `requireAuth(req, res, slug, minRole)`; public GETs use `getAccess(req, slug)`. Bearer token in `Authorization`.
- **Plan/feature keys are stable identifiers** (map 1:1 to future Stripe products/entitlements). Never translate a key; translate only labels.
- **Enforcement is server-side**; the client is never trusted to grant access.
- **i18n**: all three `app/i18n/{en,fr,de}.json` keep an identical key set; bump `I18N_VERSION` in `app/js/i18n.js` and the `?v=` query when strings change. `/admin` is English-only (no keys).
- **Tests**: `node tests/unit.js` must pass. Integration (`tests/api.js`) needs `vercel dev` on :3000 + `ARTIST_PASSWORD`.
- **New env var**: `SUPER_ADMIN_EMAILS` (comma-separated, lowercased on compare).
- Commit messages: short subject, **no** `Co-Authored-By` trailer.

---

### Task 1: Plan registry module `api/_plans.js`

**Files:**
- Create: `api/_plans.js`
- Test: `tests/unit/plans.js`
- Modify: `tests/unit.js` (register suite)

**Interfaces:**
- Produces:
  - `PLANS` — object keyed by plan id.
  - `getPlan(artist) -> { label, limits:{storageMB, songs}, features:string[] }`
  - `hasFeature(artist, key) -> boolean`
  - `storageLimitBytes(artist) -> number|null` (null = unlimited)
  - `songLimit(artist) -> number|null`
  - `planSummary(artist) -> { key, label, limits, features }`
  - `wouldExceedStorage(artist, usedBytes, addBytes) -> boolean`
  - `requireFeature(res, artist, key) -> boolean` (writes 402 + `{error:'upgrade_required', feature}` when denied)

- [ ] **Step 1: Write the failing test** — `tests/unit/plans.js`

```js
const path = require('path');
const {
  getPlan, hasFeature, storageLimitBytes, songLimit, planSummary, wouldExceedStorage,
} = require(path.join(__dirname, '../../api/_plans'));

function run(r) {
  const { test, assert, assertEq, B } = r;
  console.log(B('\n_plans registry'));

  const free = { config: {} };                 // no plan -> free
  const pro  = { config: { plan: 'pro' } };
  const bogus = { config: { plan: 'nope' } };   // unknown -> free fallback

  test('missing plan falls back to free', () => assertEq(getPlan(free).label, 'Free'));
  test('unknown plan falls back to free', () => assertEq(getPlan(bogus).label, 'Free'));
  test('pro resolves to Pro', () => assertEq(getPlan(pro).label, 'Pro'));

  test('free lacks venues', () => assertEq(hasFeature(free, 'venues'), false));
  test('free has songs', () => assertEq(hasFeature(free, 'songs'), true));
  test('pro has venues', () => assertEq(hasFeature(pro, 'venues'), true));

  test('free storage limit is 30MB in bytes', () => assertEq(storageLimitBytes(free), 30 * 1024 * 1024));
  test('pro storage unlimited', () => assertEq(storageLimitBytes(pro), null));
  test('free song limit 20', () => assertEq(songLimit(free), 20));
  test('pro song limit null', () => assertEq(songLimit(pro), null));

  test('wouldExceedStorage true when over free cap', () =>
    assertEq(wouldExceedStorage(free, 30 * 1024 * 1024, 1), true));
  test('wouldExceedStorage false under cap', () =>
    assertEq(wouldExceedStorage(free, 0, 1024), false));
  test('wouldExceedStorage always false for unlimited', () =>
    assertEq(wouldExceedStorage(pro, 9e15, 9e15), false));

  test('planSummary shape', () => {
    const s = planSummary(free);
    assertEq(s.key, 'free');
    assert(Array.isArray(s.features), 'features not array');
  });
}
module.exports = run;
```

- [ ] **Step 2: Register suite** in `tests/unit.js` — add to the `suites` array:

```js
  require('./unit/plans'),
```

- [ ] **Step 3: Run to verify it fails**

Run: `node tests/unit.js`
Expected: FAIL — `Cannot find module '../../api/_plans'`.

- [ ] **Step 4: Implement `api/_plans.js`**

```js
// Single source of truth for plan tiers. getPlan() is the only seam real
// billing later replaces (a Stripe webhook writes artists.config.plan; nothing
// else changes). Move a feature key between the two `features` arrays to change
// what is free vs paid.
const PLANS = {
  free: {
    label: 'Free',
    limits: { storageMB: 30, songs: 20 },
    features: ['songs', 'setlists', 'gigs', 'hub'],
  },
  pro: {
    label: 'Pro',
    limits: { storageMB: null, songs: null }, // null = unlimited
    features: ['songs', 'setlists', 'gigs', 'hub', 'venues', 'organizers', 'pro-import', 'booking'],
  },
};

function getPlan(artist) {
  return PLANS[artist?.config?.plan] || PLANS.free;
}

function hasFeature(artist, key) {
  const f = getPlan(artist).features;
  return f.includes('*') || f.includes(key);
}

function storageLimitBytes(artist) {
  const mb = getPlan(artist).limits.storageMB;
  return mb == null ? null : mb * 1024 * 1024;
}

function songLimit(artist) {
  return getPlan(artist).limits.songs;
}

function wouldExceedStorage(artist, usedBytes, addBytes) {
  const limit = storageLimitBytes(artist);
  if (limit == null) return false;
  return Number(usedBytes) + Number(addBytes) > limit;
}

function planSummary(artist) {
  const key = PLANS[artist?.config?.plan] ? artist.config.plan : 'free';
  const p = PLANS[key];
  return { key, label: p.label, limits: p.limits, features: p.features };
}

// Writes a 402 and returns false when the band's plan lacks `key`.
function requireFeature(res, artist, key) {
  if (hasFeature(artist, key)) return true;
  res.status(402).json({ error: 'upgrade_required', feature: key });
  return false;
}

module.exports = {
  PLANS, getPlan, hasFeature, storageLimitBytes, songLimit,
  wouldExceedStorage, planSummary, requireFeature,
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `node tests/unit.js`
Expected: PASS (all `_plans registry` tests green).

- [ ] **Step 6: Commit**

```bash
git add api/_plans.js tests/unit/plans.js tests/unit.js
git commit -m "feat: add plan tier registry"
```

---

### Task 2: Storage usage column

**Files:**
- Modify: `scripts/schema.sql` (artists section)

**Interfaces:**
- Produces: `artists.storage_used_bytes BIGINT NOT NULL DEFAULT 0`, surfaced on every `getArtist` (it is `SELECT *`).

- [ ] **Step 1: Add the idempotent column** — after the `CREATE TABLE ... artists (...)` block in `scripts/schema.sql`, add:

```sql
ALTER TABLE artists ADD COLUMN IF NOT EXISTS storage_used_bytes BIGINT NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply to dev DB**

Run: `node scripts/apply_schema.js` (confirm `y` at the host prompt)
Expected: completes without error; re-running is a no-op.

- [ ] **Step 3: Verify the column exists**

Run: `node scripts/plans.js` will later read it; for now verify via psql or a quick `node -e` against the DB if convenient. (Created in Task 11 — skip if not yet built.)

- [ ] **Step 4: Commit**

```bash
git add scripts/schema.sql
git commit -m "feat: add artists.storage_used_bytes column"
```

---

### Task 3: Expose `plan` + `usage` in `GET /api/config`

**Files:**
- Modify: `api/config.js` (require + the final `res.json({...})` at ~line 413)

**Interfaces:**
- Consumes: `planSummary` from `api/_plans.js`.
- Produces: config response gains `plan: {key,label,limits,features}` and `usage: {storageUsedBytes, songs}`.

- [ ] **Step 1: Import the helper** — near the other requires at the top of `api/config.js`:

```js
const { planSummary } = require('./_plans');
```

- [ ] **Step 2: Add fields to the GET response** — in the final `res.json({ ... })` (the one returning `slug`, `name`, `config`, `counts`, …), add:

```js
    plan:  planSummary(band),
    usage: {
      storageUsedBytes: Number(band.storage_used_bytes || 0),
      songs: (counts && counts.songs != null) ? counts.songs : null,
    },
```

- [ ] **Step 3: Manual verification**

Run: `vercel dev` then `curl -s 'http://localhost:3000/api/config?slug=<yourslug>' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.plan, j.usage)})"`
Expected: prints a `plan` object (`key:'free'…`) and a `usage` object.

- [ ] **Step 4: Commit**

```bash
git add api/config.js
git commit -m "feat: return plan and usage in config payload"
```

---

### Task 4: Server feature-gating (venues, organizers, pro-import)

**Files:**
- Modify: `api/[artist]/venues.js`, `api/[artist]/venues/[...path].js`
- Modify: `api/[artist]/organizers.js`, `api/[artist]/organizers/[...path].js`
- Modify: `api/[artist]/songs/[...path].js` (the `gema-import` branch)
- Test: `tests/api.js` (add a gating assertion)

**Interfaces:**
- Consumes: `requireFeature(res, artist, key)` from `api/_plans.js`.

The gate keys off the **band's** plan (the resolved `artist`), independent of the viewer, so it must sit right after the artist/band is resolved in **every** method branch.

- [ ] **Step 1: Import in each file** — add at the top of each of the five files:

```js
const { requireFeature } = require('../_plans');   // venues.js, organizers.js
// path files are one dir deeper:
const { requireFeature } = require('../../_plans'); // venues/[...path].js, organizers/[...path].js, songs/[...path].js
```

- [ ] **Step 2: Gate `venues.js`**
  - In the `GET` branch, immediately after `if (!artist) return res.status(404)...`:
    ```js
    if (!requireFeature(res, artist, 'venues')) return;
    ```
  - In the `POST` branch, immediately after `if (!artist) return;`:
    ```js
    if (!requireFeature(res, artist, 'venues')) return;
    ```

- [ ] **Step 3: Gate `venues/[...path].js`** — after each `requireAuth`/`getAccess` resolves the artist (every method branch), add:
    ```js
    if (!requireFeature(res, artist, 'venues')) return;
    ```

- [ ] **Step 4: Gate organizers** — same pattern in `organizers.js` and `organizers/[...path].js` with key `'organizers'`.

- [ ] **Step 5: Gate pro-import** — in `api/[artist]/songs/[...path].js`, inside `if (rawId === 'gema-import')`, immediately after `const band = await requireAuth(...)` / `if (!band) return;`:
    ```js
    if (!requireFeature(res, band, 'pro-import')) return;
    ```

- [ ] **Step 6: Add an integration assertion** in `tests/api.js` — after login as the default (assume free-tier) band, assert a gated call returns 402. Insert alongside existing venue tests:

```js
// A free-tier band cannot access venues.
{
  const r = await api('GET', `/api/${SLUG}/venues`);
  assert(r.status === 402, `expected 402 for gated venues, got ${r.status}`);
  assert(r.body.error === 'upgrade_required', 'expected upgrade_required code');
}
```
(If the test artist is Pro in the seed, temporarily set it free with `node scripts/plans.js --artist <slug> --plan free` before running — see Task 11. Restore after.)

- [ ] **Step 7: Verify**

Run: `node tests/unit.js` (must still pass) and, with `vercel dev` running, `cd tests && ARTIST_PASSWORD=… node api.js` for the gating assertion.
Expected: gated endpoints return 402 for a free band.

- [ ] **Step 8: Commit**

```bash
git add api/\[artist\]/venues.js api/\[artist\]/venues/ api/\[artist\]/organizers.js api/\[artist\]/organizers/ api/\[artist\]/songs/ tests/api.js
git commit -m "feat: gate venues, organizers, pro-import behind plan"
```

---

### Task 5: Storage limit + accounting (song media)

**Files:**
- Modify: `api/_media.js` (`makeMediaFn` — confirm + delete branches)
- Modify: `api/[artist]/songs.js` (`media_confirm_id` + `media_delete_id` branches)

**Interfaces:**
- Consumes: `wouldExceedStorage(artist, used, add)` from `api/_plans.js`.
- Behavior: at confirm, reject with `402 {error:'storage_limit', limit, used}` when over cap, else `storage_used_bytes += head.size`. At delete, `storage_used_bytes -= <deleted size>` clamped at 0.

A single upload hits exactly one of these two routes, so accounting in both does not double-count.

- [ ] **Step 1: Import in both files**

```js
const { wouldExceedStorage } = require('./_plans');   // _media.js
const { wouldExceedStorage } = require('../_plans');  // songs.js
```

- [ ] **Step 2: Enforce + account at confirm in `api/_media.js`** — in `makeMediaFn`, after the existing `if (head.size > maxBytes) {…}` block and after `band` is known, before writing `newExtra`:

```js
      if (wouldExceedStorage(band, band.storage_used_bytes || 0, head.size)) {
        await deleteFromR2(publicUrl);
        return res.status(402).json({
          error: 'storage_limit',
          limit: (band.storage_used_bytes || 0),
          used:  Number(band.storage_used_bytes || 0),
        });
      }
```
Then, right after the `UPDATE songs SET extra = ${newExtra} …` succeeds, add (replacing the previous file's bytes is handled in the delete branch of replace below):

```js
      await sql`UPDATE artists SET storage_used_bytes = storage_used_bytes + ${head.size} WHERE id = ${band.id}`;
```
And in the replace path (`if (previousUrl && previousUrl !== publicUrl)`), after `await deleteFromR2(previousUrl);` decrement the old size. The old size is not stored, so fetch it before delete:

```js
        const prevHead = await verifyUpload(keyFromUrl(previousUrl));
        if (prevHead) await sql`UPDATE artists SET storage_used_bytes = GREATEST(0, storage_used_bytes - ${prevHead.size}) WHERE id = ${band.id}`;
```
(`sql` is available in `makeMediaFn` via `getDb()` — confirm the function already calls `getDb()`; if not, add `const sql = getDb();` at its top and import `getDb` from `./_db`.)

- [ ] **Step 3: Account at delete in `api/_media.js`** — in the delete branch, where `const url = song.extra?.[extraKey];` then `await deleteFromR2(url)`, fetch size first and decrement:

```js
      if (url) {
        const delHead = await verifyUpload(keyFromUrl(url));
        await deleteFromR2(url);
        if (delHead) await sql`UPDATE artists SET storage_used_bytes = GREATEST(0, storage_used_bytes - ${delHead.size}) WHERE id = ${band.id}`;
        // …existing audit log…
      }
```

- [ ] **Step 4: Mirror the same logic in `api/[artist]/songs.js`** — apply identical enforce/account/replace/delete edits in the `media_confirm_id` branch (around lines 295–323) and the `media_delete_id` branch (around lines 341–350), using `band.id` and the already-fetched `head`/`previousUrl`/`url`. `sql` is already in scope there.

- [ ] **Step 5: Verify (manual, needs vercel dev + R2)**

Upload an audio file to a song; `curl …/api/config?slug=…` shows `usage.storageUsedBytes` increased by the file size. Delete it; the value returns toward its prior level. With a free band near 30 MB, an over-cap upload returns 402 `storage_limit`.

- [ ] **Step 6: Commit**

```bash
git add api/_media.js api/\[artist\]/songs.js
git commit -m "feat: enforce and track storage usage on song media"
```

---

### Task 6: Song-count limit on create

**Files:**
- Modify: `api/[artist]/songs.js` (the `if (req.method === 'POST')` create branch, ~line 391)

**Interfaces:**
- Consumes: `songLimit(artist)` from `api/_plans.js`.

- [ ] **Step 1: Import**

```js
const { songLimit } = require('../_plans');
```

- [ ] **Step 2: Enforce before the INSERT** — right after `const band = await requireAuth(...); if (!band) return;` in the create branch and before validation/insert:

```js
    const _max = songLimit(band);
    if (_max != null) {
      const [{ count }] = await sql`
        SELECT count(*)::int AS count FROM songs WHERE artist_id = ${band.id} AND NOT deleted`;
      if (count >= _max)
        return res.status(402).json({ error: 'song_limit', limit: _max });
    }
```

- [ ] **Step 3: Verify**

With a free band holding 20 songs, `POST /api/<slug>/songs` returns 402 `song_limit`. Under 20, it succeeds.

- [ ] **Step 4: Commit**

```bash
git add api/\[artist\]/songs.js
git commit -m "feat: enforce free-tier song limit"
```

---

### Task 7: Client nav locking + upsell (`common.js`)

**Files:**
- Modify: `app/js/common.js` (after config loads / in `applyNav`)
- Modify: `app/css/…` (the stylesheet `common.js` pages use) — add `.plan-locked` styles

**Interfaces:**
- Consumes: `cfg.plan.features` from `GET /api/config`.

- [ ] **Step 1: Map nav hrefs to feature keys** — near the nav code in `common.js`, add a constant:

```js
const NAV_FEATURE = { '/venues': 'venues', '/organizers': 'organizers', '/pro-import': 'pro-import' };
```

- [ ] **Step 2: Lock unavailable items after config loads** — where the resolved config (`cfg`) is applied to the nav (the function that already toggles `auth-only`/`current`), add:

```js
  const feats = (cfg && cfg.plan && cfg.plan.features) || [];
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    const href = a.getAttribute('href') || '';
    const key = Object.keys(NAV_FEATURE).find(function (p) { return href.endsWith(p); });
    if (key && !feats.includes(NAV_FEATURE[key])) {
      a.classList.add('plan-locked');
    }
  });
```

- [ ] **Step 3: Intercept clicks on locked items** — in the existing nav `click` delegation handler, near the top:

```js
    const locked = e.target.closest('.plan-locked');
    if (locked) {
      e.preventDefault();
      const base = locked.getAttribute('href').replace(/\/(venues|organizers|pro-import).*$/, '');
      window.location.href = base + '/settings#plan';
      return;
    }
```

- [ ] **Step 4: Add styles** — in the shared CSS:

```css
.nav-links a.plan-locked { opacity: .55; }
.nav-links a.plan-locked::after { content: " 🔒"; font-size: .85em; }
```

- [ ] **Step 5: Verify (manual)** — as a free band, Venues/Organizers/PRO nav items show a lock and route to `/settings#plan` instead of the page.

- [ ] **Step 6: Commit**

```bash
git add app/js/common.js app/css/
git commit -m "feat: lock paid nav items with upgrade prompt"
```

---

### Task 8: Settings Plan section (usage + upgrade)

**Files:**
- Modify: `app/settings.html` (add a Plan section container)
- Modify: `app/js/settings.js` (render meter + wire upgrade/downgrade)

**Interfaces:**
- Consumes: `cfg.plan`, `cfg.usage` from config; `PATCH /api/config` with `{config:{plan}}`; `invalidateConfigCache()`.

- [ ] **Step 1: Add the markup** — add an `id="plan"` section to `settings.html` (admin area):

```html
<section id="plan" class="card">
  <h2 data-i18n="settings.plan.title">Plan</h2>
  <p><strong data-i18n="settings.plan.current">Current plan:</strong> <span id="plan-label"></span></p>
  <p id="plan-storage"></p>
  <p id="plan-songs"></p>
  <button id="plan-toggle" class="btn"></button>
</section>
```

- [ ] **Step 2: Render + wire in `settings.js`** — after config is loaded:

```js
function renderPlan(cfg) {
  const p = cfg.plan, u = cfg.usage || {};
  document.getElementById('plan-label').textContent = p.label;
  const usedMB = ((u.storageUsedBytes || 0) / 1024 / 1024).toFixed(1);
  document.getElementById('plan-storage').textContent =
    p.limits.storageMB == null ? t('settings.plan.storageUnlimited', { used: usedMB })
                               : t('settings.plan.storage', { used: usedMB, limit: p.limits.storageMB });
  document.getElementById('plan-songs').textContent =
    p.limits.songs == null ? t('settings.plan.songsUnlimited', { used: u.songs ?? 0 })
                           : t('settings.plan.songs', { used: u.songs ?? 0, limit: p.limits.songs });
  const btn = document.getElementById('plan-toggle');
  const target = p.key === 'pro' ? 'free' : 'pro';
  btn.textContent = target === 'pro' ? t('settings.plan.upgrade') : t('settings.plan.downgrade');
  btn.onclick = async function () {
    btn.disabled = true;
    await apiFetch('/api/config?slug=' + SLUG, { method: 'PATCH', body: JSON.stringify({ config: { plan: target } }) });
    invalidateConfigCache();
    window.location.reload();
  };
}
```
(Use the page's existing authed-fetch helper and slug variable; names above are illustrative — match `settings.js` conventions.)

- [ ] **Step 3: Verify (manual)** — `/settings` shows the plan, a storage meter ("8.4 / 30 MB"), a songs counter, and a working Upgrade button that flips the plan and unlocks nav.

- [ ] **Step 4: Commit**

```bash
git add app/settings.html app/js/settings.js
git commit -m "feat: settings plan section with usage and upgrade"
```

---

### Task 9: Super-admin endpoints (overview + set-plan)

**Files:**
- Modify: `api/config.js` (two new `?action=` branches + a helper)

**Interfaces:**
- Consumes: `verifyUserToken` (already imported), `getDb`.
- Produces:
  - `GET /api/config?action=admin-overview` → `{ totals, bands:[…] }`
  - `POST /api/config?action=admin-set-plan` body `{slug, plan}` → `{ok:true}`
- Auth: caller's token email ∈ `SUPER_ADMIN_EMAILS`.

- [ ] **Step 1: Add a super-admin guard helper** near the top of the GET section:

```js
async function requireSuperAdmin(req, res, sql) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claim = verifyUserToken(tok);
  if (!claim) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  const [u] = await sql`SELECT email FROM users WHERE id = ${claim.userId} LIMIT 1`;
  const allow = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!u || !allow.includes(String(u.email).toLowerCase())) { res.status(403).json({ error: 'Forbidden' }); return false; }
  return true;
}
```

- [ ] **Step 2: Add the overview action** — in the GET action chain (e.g. after `my-artists`):

```js
  if (req.query.action === 'admin-overview') {
    const sql = getDb();
    if (!await requireSuperAdmin(req, res, sql)) return;
    const bands = await sql`
      SELECT a.slug, a.name, COALESCE(a.config->>'plan','free') AS plan,
             a.storage_used_bytes,
             (SELECT count(*)::int FROM songs s WHERE s.artist_id = a.id AND NOT s.deleted) AS songs,
             (SELECT count(*)::int FROM users u WHERE u.artist_id = a.id) AS users
      FROM artists a ORDER BY a.name`;
    const totals = {
      bands: bands.length,
      storageUsedBytes: bands.reduce((n, b) => n + Number(b.storage_used_bytes || 0), 0),
      pro: bands.filter(b => b.plan === 'pro').length,
      free: bands.filter(b => b.plan !== 'pro').length,
    };
    return res.json({ totals, bands });
  }
```

- [ ] **Step 3: Add the set-plan action** — in the POST section (top, before the contact/subscribe block):

```js
  if (req.body?.action === 'admin-set-plan') {
    const sql = getDb();
    if (!await requireSuperAdmin(req, res, sql)) return;
    const { slug: target, plan } = req.body;
    if (!['free', 'pro'].includes(plan)) return res.status(400).json({ error: 'invalid plan' });
    const r = await sql`UPDATE artists SET config = config || ${{ plan }} WHERE slug = ${target} RETURNING id`;
    if (!r.length) return res.status(404).json({ error: 'Artist not found' });
    return res.json({ ok: true });
  }
```

- [ ] **Step 4: Verify** — set `SUPER_ADMIN_EMAILS=you@example.com` in `.env`. With your session token: `admin-overview` returns the band table; a non-allowlisted token gets 403.

- [ ] **Step 5: Commit**

```bash
git add api/config.js
git commit -m "feat: super-admin overview and set-plan endpoints"
```

---

### Task 10: Super-admin page `/admin`

**Files:**
- Create: `app/admin.html`, `app/js/admin.js`
- Modify: `vercel.json` (rewrite `/admin` → `/app/admin.html`)

**Interfaces:**
- Consumes: `GET/POST /api/config?action=admin-overview|admin-set-plan` with the session bearer token. English-only (no i18n).

- [ ] **Step 1: Add the rewrite** — in `vercel.json` rewrites, alongside the other top-level page routes:

```json
    { "source": "/admin", "destination": "/app/admin.html" },
```

- [ ] **Step 2: Create `app/admin.html`** — a minimal standalone page (no `common.js` nav needed) with a `<table id="bands">` and a `<div id="totals">`, loading `app/js/admin.js` and reading the token from `sessionStorage.setlist_token`.

- [ ] **Step 3: Create `app/js/admin.js`** — fetch overview, render rows with a plan `<select>` per band wired to `admin-set-plan`:

```js
const TOKEN = sessionStorage.getItem('setlist_token') || '';
async function load() {
  const r = await fetch('/api/config?action=admin-overview', { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!r.ok) { document.body.textContent = 'Not authorised'; return; }
  const { totals, bands } = await r.json();
  document.getElementById('totals').textContent =
    `${totals.bands} bands · ${(totals.storageUsedBytes/1048576).toFixed(1)} MB · ${totals.pro} pro / ${totals.free} free`;
  const tb = document.getElementById('bands');
  tb.innerHTML = '';
  bands.forEach(function (b) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${b.name}</td><td>${(b.storage_used_bytes/1048576).toFixed(1)} MB</td><td>${b.songs}</td><td>${b.users}</td>`;
    const td = document.createElement('td');
    const sel = document.createElement('select');
    ['free','pro'].forEach(function (p) {
      const o = document.createElement('option'); o.value = p; o.textContent = p; if (b.plan === p) o.selected = true; sel.appendChild(o);
    });
    sel.onchange = async function () {
      await fetch('/api/config', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'admin-set-plan', slug: b.slug, plan: sel.value }) });
      load();
    };
    td.appendChild(sel); tr.appendChild(td); tb.appendChild(tr);
  });
}
load();
```

- [ ] **Step 4: Verify** — log in as a `SUPER_ADMIN_EMAILS` user, visit `/admin`: see all bands, change a plan, row updates. A normal user sees "Not authorised".

- [ ] **Step 5: Commit**

```bash
git add app/admin.html app/js/admin.js vercel.json
git commit -m "feat: super-admin global usage page"
```

---

### Task 11: Developer CLI `scripts/plans.js`

**Files:**
- Create: `scripts/plans.js`

**Interfaces:**
- `node scripts/plans.js` → list bands (plan, storage used/limit, songs, users).
- `node scripts/plans.js --artist <slug> --plan <free|pro>` → set plan.
- `node scripts/plans.js --recount` → recompute `storage_used_bytes` from R2 object sizes per artist key prefix.

Follow existing script conventions: `loadEnv`, show DB host, require `y` confirmation (copy the header from `scripts/seed.js`).

- [ ] **Step 1: Implement list + set** using the same DB bootstrap as other scripts, and `getPlan`/`storageLimitBytes` from `api/_plans.js` for limits. List query mirrors Task 9's overview; set runs `UPDATE artists SET config = config || ${{plan}} WHERE slug = ${slug}`.

- [ ] **Step 2: Implement `--recount`** — for each artist, list R2 objects under the song-media prefixes (`audio/`, `sheets/`, `playback/`) whose keys are referenced by that artist's `songs.extra` URLs, sum `size`, and `UPDATE artists SET storage_used_bytes = ${sum}`. (Reuse the R2 client from `api/_r2.js`; if a list helper is absent, add a small `listSizesByKeys(keys)` there and account only keys present in the DB to stay tenant-scoped.)

- [ ] **Step 3: Verify** — `node scripts/plans.js` prints the table; `--artist <slug> --plan pro` flips a band (confirm via `/api/config`); `--recount` sets a non-zero, plausible byte total.

- [ ] **Step 4: Commit**

```bash
git add scripts/plans.js api/_r2.js
git commit -m "feat: plans CLI for overview, granting, and recount"
```

---

### Task 12: i18n strings + cache bust

**Files:**
- Modify: `app/i18n/en.json`, `app/i18n/fr.json`, `app/i18n/de.json`
- Modify: `app/js/i18n.js` (`I18N_VERSION`), pages referencing `i18n.js?v=`

**Interfaces:**
- Keys used by Tasks 7–8: `settings.plan.title/current/storage/storageUnlimited/songs/songsUnlimited/upgrade/downgrade`, plus any upsell copy.

- [ ] **Step 1: Add identical keys to all three locale files**, e.g. (en):

```json
"settings.plan.title": "Plan",
"settings.plan.current": "Current plan:",
"settings.plan.storage": "Storage: {used} / {limit} MB",
"settings.plan.storageUnlimited": "Storage: {used} MB (unlimited)",
"settings.plan.songs": "Songs: {used} / {limit}",
"settings.plan.songsUnlimited": "Songs: {used} (unlimited)",
"settings.plan.upgrade": "Upgrade to Pro",
"settings.plan.downgrade": "Switch to Free"
```
FR/DE: machine-translate as first pass; flag for native review.

- [ ] **Step 2: Bump cache** — increment `I18N_VERSION` in `app/js/i18n.js` and the `i18n.js?v=` query on translated pages.

- [ ] **Step 3: Verify keys are in sync**

Run: `node tests/unit.js`
Expected: the `i18n` suite passes (identical key sets across en/fr/de).

- [ ] **Step 4: Commit**

```bash
git add app/i18n/ app/js/i18n.js app/*.html
git commit -m "i18n: add plan tier strings"
```

---

## Self-Review

**Spec coverage:** Registry (T1), storage column (T2), config payload (T3), feature gates incl. venues/organizers/pro-import (T4), storage limit+accounting (T5), song limit (T6), client lock+upsell (T7), self-serve upgrade + usage display (T8), super-admin overview + quick set-plan (T9–T10), CLI list/grant/recount (T11), i18n (T12). Booking key reserved in T1, no code (no booking feature yet) — matches spec. Stripe-readiness: `getPlan` single seam (T1), 402 + machine codes (T4–T6), `config.plan` write path reused by self-serve and future webhook (T8/T9). All spec sections map to a task.

**Known follow-ups (not blockers):** the self-serve `PATCH config.plan` currently trusts an admin to set their own plan — intended placeholder; when billing lands, restrict `config.plan` writes to the webhook and keep only the super-admin/`admin-set-plan` path for manual grants.
