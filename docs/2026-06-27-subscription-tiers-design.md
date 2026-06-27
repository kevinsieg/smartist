# Subscription Tiers — Design

Date: 2026-06-27
Status: Approved for planning

## Goal

Introduce a plan/tier system that gates features and limits per band (the
`artist` tenant), so the developer can manage what is free vs paid from **one
file**, display and enforce storage/song limits, grant unlimited access to
chosen accounts from day one, and offer a one-click upgrade. Real billing
(Stripe etc.) is explicitly **out of scope** — this lays the groundwork so
billing later only swaps the plan source, not the enforcement code.

## Plans

| Plan | Storage | Songs | Features |
|------|---------|-------|----------|
| `free` | 30 MB | 20 | songs, setlists, gigs, hub |
| `pro`  | unlimited | unlimited | everything (adds venues, organizers, pro-import, booking) |

- `null` limit = unlimited.
- Hub (social/streaming links) is **free** (public-facing, not in the paid list).
- Default plan for any band is `free` (via fallback, no migration needed).

## Design principles (Stripe-ready, state of the art)

The system is built so that wiring real billing later is additive, never a
rewrite:

- **Single entitlement seam.** `getPlan(artist)` is the *only* place that
  resolves a band to its plan. Today it reads `artists.config.plan`; later a
  Stripe webhook writes that same field, so `getPlan` and every enforcement
  call site stay untouched.
- **Server-authoritative enforcement.** All gating is enforced on the server
  (402); the client only mirrors it for UX. The client is never trusted to
  grant access.
- **Stable, billing-agnostic keys.** Plan keys (`free`, `pro`) and feature keys
  (`venues`, `organizers`, …) are stable identifiers that map 1:1 to future
  Stripe Products / Prices / Entitlement feature keys. Renaming a label never
  changes a key.
- **Structured error codes.** Gated/limit responses return machine-readable
  codes (`upgrade_required`, `storage_limit`, `song_limit`) the frontend maps to
  upgrade UI — not human strings.
- **Reserved billing fields.** `artists.config` will later carry
  `stripe_customer_id`, `stripe_subscription_id`, and `plan_status` (e.g.
  `active` / `past_due`). We do **not** add them now, but the JSONB `||` merge
  pattern accommodates them without migration. `plan_status` is where dunning
  (failed payment) state will live; enforcement can later treat `past_due` as a
  downgrade.
- **One upgrade write path.** The self-serve placeholder upgrade and the future
  Stripe webhook both do the same thing: merge `config.plan`. The placeholder
  `PATCH /api/config` is literally the call Stripe's webhook/checkout-success
  handler replaces, so the upgrade flow is proven before money is involved.
- **Idempotent accounting.** Storage counter updates are atomic
  (`storage_used_bytes + n`); `--recount` provides a self-healing source of
  truth if drift ever occurs.

When billing is added, the new surface is: a Stripe Checkout/Portal link from
the `/settings` Plan section, one webhook handler that merges `config.plan` +
the reserved fields, and (optionally) reading Stripe Entitlements inside
`getPlan`. No enforcement, UI-gating, or limit code changes.

## Architecture

### 1. Plan registry — `api/_plans.js` (NEW, single source of truth)

The one file the developer edits to manage paid access.

```js
const PLANS = {
  free: { label: 'Free', limits: { storageMB: 30,   songs: 20 },
          features: ['songs', 'setlists', 'gigs', 'hub'] },
  pro:  { label: 'Pro',  limits: { storageMB: null, songs: null },
          features: ['songs','setlists','gigs','hub','venues','organizers','pro-import','booking'] },
};

function getPlan(artist) { return PLANS[artist?.config?.plan || 'free']; }

function hasFeature(artist, key) {
  const f = getPlan(artist).features;
  return f.includes('*') || f.includes(key);
}

// Returns limit in bytes (or null = unlimited).
function storageLimitBytes(artist) {
  const mb = getPlan(artist).limits.storageMB;
  return mb == null ? null : mb * 1024 * 1024;
}

function songLimit(artist) { return getPlan(artist).limits.songs; }

module.exports = { PLANS, getPlan, hasFeature, storageLimitBytes, songLimit };
```

`getPlan()` is the **single seam**: later it returns the plan from Stripe
Entitlements instead of `config.plan`, and nothing else changes. Adding a paid
feature = move its key between the two `features` arrays.

### 2. Data model

- **Current plan:** `artists.config.plan` (`'free'` | `'pro'`), default `free`
  via `getPlan` fallback. Set through the existing JSONB `||` merge on
  `PATCH /api/config`. No migration for the plan itself.
- **Storage usage:** new column on `artists`, added idempotently in
  `scripts/schema.sql`:
  ```sql
  ALTER TABLE artists ADD COLUMN IF NOT EXISTS storage_used_bytes BIGINT NOT NULL DEFAULT 0;
  ```
  A real column (not JSONB) so increments are atomic and race-free:
  `UPDATE artists SET storage_used_bytes = storage_used_bytes + ${n}`.

### 3. Server enforcement (zero new serverless functions)

**Feature gate** — after `requireAuth`, in each paid handler:
```js
if (!hasFeature(artist, 'venues'))
  return res.status(402).json({ error: 'upgrade_required' });
```
`402 Payment Required` is the honest status. Applied in:
- `api/[artist]/venues.js`, `api/[artist]/venues/[...path].js` → `'venues'`
- `api/[artist]/organizers.js`, `api/[artist]/organizers/[...path].js` → `'organizers'`
- PRO/GEMA import segment in `api/[artist]/songs/[...path].js` → `'pro-import'`
- Booking: no code yet; key reserved for when it lands.

**Storage limit + accounting** — counts **song media only** (audio / sheet /
playback). Band photo/favicon are excluded: each uses a single fixed R2 key, is
tiny, and is not the storage-cost driver. Hook at the song-media upload-confirm
sites (`api/_media.js:makeMediaFn` — the shared path — and the
`media_confirm_id` branch in `api/[artist]/songs.js`), where
`verifyUpload`/`head.size` already runs:
```js
const limit = storageLimitBytes(artist);
if (limit != null && usedBytes + size > limit)
  return res.status(402).json({ error: 'storage_limit', limit, used: usedBytes });
await sql`UPDATE artists SET storage_used_bytes = storage_used_bytes + ${size} WHERE id = ${artist.id}`;
```
On every media **delete** (each `deleteFromR2` site), decrement by the deleted
object's size (clamped at 0).

**Song limit** — on song create in `api/[artist]/songs.js`:
```js
const max = songLimit(artist);
if (max != null) {
  const [{ count }] = await sql`SELECT count(*)::int FROM songs WHERE artist_id = ${artist.id} AND NOT deleted`;
  if (count >= max) return res.status(402).json({ error: 'song_limit', limit: max });
}
```

### 4. Config payload (existing `GET /api/config`)

Add, for the authenticated band:
```json
"plan":  { "key": "free", "label": "Free", "limits": { "storageMB": 30, "songs": 20 }, "features": ["songs","setlists","gigs","hub"] },
"usage": { "storageUsedBytes": 8800000, "songs": 12 }
```
After any plan change, the client calls `invalidateConfigCache()` (existing).

### 5. Client enforcement — show-but-locked + upsell (`app/js/common.js`)

- Map each gateable nav item's `href` to a feature key (venues, organizers,
  pro-import, booking).
- Using `cfg.plan.features`, add a `plan-locked` class + lock icon to nav items
  whose feature is not granted — same mechanism as the existing `auth-only` /
  `admin-only` CSS classes set early in `injectShell`.
- Clicking a `plan-locked` item shows an "Upgrade to Pro" prompt linking to the
  `/settings` Plan section, instead of navigating.
- The server still rejects (402) regardless of client state.

### 6. Self-serve upgrade + usage display — `/settings` (admin only)

A new **Plan** section in `app/js/settings.js` / `settings.html`:
- Current plan label.
- **Storage meter**: "8.4 / 30 MB" with a bar; "unlimited" for Pro.
- **Songs counter**: "12 / 20"; "unlimited" for Pro.
- **Upgrade / Downgrade** button → `PATCH /api/config` setting `config.plan`,
  then `invalidateConfigCache()`. No payment — this is the exact call Stripe
  Checkout replaces later.

### 7. Super-admin global view — `/admin` (NEW static page)

Cross-tenant overview for the app owner. Authorized by a new env allowlist
`SUPER_ADMIN_EMAILS` (comma-separated). The check rides the existing
`config.js` function (no new serverless function) and uses the globally
verifiable user token:
```js
const claim = verifyUserToken(bearerToken(req));        // { userId, role } or null
if (!claim) return res.status(401)...
const [u] = await sql`SELECT email FROM users WHERE id = ${claim.userId}`;
const allow = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase());
if (!u || !allow.includes(u.email.toLowerCase())) return res.status(403)...
```

- **`GET /api/config?action=admin-overview`** → for every band: slug, name,
  plan, `storage_used_bytes` + limit, song count, # users, created date; plus
  app totals (total storage, band count, Free/Pro split).
- **`POST /api/config?action=admin-set-plan`** `{ slug, plan }` → quick action:
  change any band's plan from the admin table (reuses the JSONB `||` merge).
- **`/admin`** static page (`app/admin.html` + `app/js/admin.js`), rewritten in
  `vercel.json` (`/admin` → `app/admin.html`). Static pages are not serverless
  functions, so the 12-function limit is unaffected. Renders the overview table
  with a plan dropdown per row wired to `admin-set-plan`.

### 8. Developer CLI — `scripts/plans.js` (NEW)

Terminal overview + management (always-available fallback, zero web surface):
- `node scripts/plans.js` → list every band: plan, storage used/limit, songs,
  users, created.
- `node scripts/plans.js --artist <slug> --plan pro` → grant a plan. Run for the
  accounts to be paid from the start.
- `node scripts/plans.js --recount` → recompute `storage_used_bytes` from actual
  R2 objects (per-artist key prefix), so displayed usage is accurate from day
  one rather than only from new uploads onward.

Follows existing script conventions (shows DB host, `y` confirmation,
`loadEnv`).

### 9. i18n

Add keys to `app/i18n/{en,fr,de}.json` (identical key set) for: plan labels,
upgrade/locked prompts, storage/song meters, and the settings Plan section,
following the standard `data-i18n` / `t()` rules. `/admin` is a developer-only
tool and is **English-only** (like `stage` and `api-docs`) — no i18n keys.
Bump `I18N_VERSION` and the `i18n.js?v=` query. Run `node tests/unit.js`.

## Testing

- **Unit** (`tests/unit.js`): `getPlan` fallback, `hasFeature`,
  `storageLimitBytes`, `songLimit`.
- **Integration** (`tests/api.js`): 402 on a gated handler for a `free` band;
  song-limit rejection at the cap; storage counter increments on upload-confirm
  and decrements on delete; super-admin overview requires an allowlisted email
  (403 otherwise).

## Out of scope (YAGNI)

Real payment/Stripe, proration, invoices, usage-metering dashboards, per-feature
pricing, activity/engagement analytics (logins, last-active), and any
non-developer plan-management UI beyond the self-serve upgrade button and the
super-admin quick action.

## Files touched

New: `api/_plans.js`, `app/admin.html`, `app/js/admin.js`, `scripts/plans.js`.
Modified: `scripts/schema.sql`, `api/config.js`, `app/js/common.js`,
`app/js/settings.js`, `settings.html`, `vercel.json`,
`api/[artist]/venues.js`, `api/[artist]/venues/[...path].js`,
`api/[artist]/organizers.js`, `api/[artist]/organizers/[...path].js`,
`api/[artist]/songs.js`, `api/[artist]/songs/[...path].js`,
`app/i18n/{en,fr,de}.json`, `app/js/i18n.js`, tests.

No new serverless functions (stays within the 12-function Hobby limit).
New env var: `SUPER_ADMIN_EMAILS`.
