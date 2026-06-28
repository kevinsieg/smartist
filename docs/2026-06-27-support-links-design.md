# Support-the-Project Links + Manual-Pro Lockdown — Design

Date: 2026-06-27
Status: Approved for planning
Relates to: `docs/2026-06-27-subscription-tiers-design.md` (tiers),
`docs/2026-06-27-billing-lemonsqueezy-design.md` (parked paid rollout)

## Goal

Until real billing is registered/enabled, **Pro is invite-only** (granted by the
operator) and the app shows an optional, multilingual **"Support the project"**
set of donation links. The links must support **multiple providers that are
easily interchangeable** (start with Liberapay + Buy Me a Coffee). No payment
backend, no entitlement is ever sold — donations grant nothing, which keeps this
legally a tip jar, not a sale (see billing spec for the France/MoR rationale).

## Why this shape

- The tier system already supports manual Pro grants (`/admin`,
  `scripts/plans.js`). So monetization can wait; this just adds a voluntary
  support channel and closes the self-serve upgrade path.
- Donation links are pure external links — zero serverless functions, zero
  webhook, nothing to maintain. The Lemon Squeezy billing spec stays parked for
  when the operator registers a micro-entreprise and wants to actually sell Pro.

## Components

### 1. `SUPPORT_LINKS` constant (single source of truth)

A code constant — the one place to add/remove/reorder providers — near the top
of `app/js/common.js`:

```js
// Edit this list to change which "Support the project" links appear.
// Entries with an empty url are skipped. Order = display order.
const SUPPORT_LINKS = [
  { id: 'liberapay',    label: 'Liberapay',       url: '' },
  { id: 'buymeacoffee', label: 'Buy Me a Coffee', url: '' },
];
```

Provider-agnostic: adding Tipeee/Patreon/PayPal later is one new entry; swapping
is an edit; an empty list renders nothing. The operator fills the real URLs.

### 2. Footer rendering (no backend)

`injectShell()` in `common.js` builds the shared footer. Add a "Support" group
that renders one external-link button per non-empty `SUPPORT_LINKS` entry:
`<a href="{url}" target="_blank" rel="noopener noreferrer">{label}</a>`, with a
leading label from the i18n key `support.label`. Brand `label`s are set via
`textContent` (static constants; no interpolation). If every entry has an empty
url, the group is omitted entirely. Appears on every `common.js` page;
`stage.html` (no shell) is unaffected.

A small reusable helper `renderSupportLinks(containerEl)` builds the buttons, so
the footer and the Settings section share one implementation.

### 3. Self-serve upgrade through a swappable seam

The self-serve upgrade button **stays**, but routes through one server action so
a future paid solution (Lemon Squeezy) is a one-function swap, not a refactor.

- **Server:** `POST /api/config?action=upgrade` — `requireAuth(..., 'admin')`,
  then today it does the free flip and tracking (§4) and returns
  `{ ok: true, mode: 'self-serve' }`. Later (paid): same action returns
  `{ ok: true, mode: 'checkout', url: '<LS checkout URL>' }` and does **not** set
  the plan (the LS webhook does). This action is the single seam.
- **Client (`settings.js` `renderPlan`):** the upgrade button calls the action
  and branches on `mode`: `self-serve` → show the donation panel (§5) + refresh
  the Pro state; `checkout` → `window.location.href = url`. Downgrade ("Switch to
  Free") stays a plain `patchConfig({ plan: 'free' })`.

### 4. Track upgrades

On each self-serve upgrade, set a **sticky** `config.upgradedAt` (ISO timestamp)
alongside `plan='pro'` via the JSONB `||` merge. It is *not* cleared on
downgrade, so it preserves the "this band wanted Pro" signal. The super-admin
`admin-overview` adds `upgraded` = count of bands with `upgradedAt` set, shown on
`/admin` ("N upgraded / M currently Pro"). That is the demand metric.

### 5. Donation prompt at the upgrade moment

When a `self-serve` upgrade succeeds, the Settings Plan section reveals a
donation panel: a thank-you line (i18n `settings.plan.donatePrompt`) followed by
the shared `renderSupportLinks` buttons (Liberapay + Buy Me a Coffee). Support
links also remain in the footer (§2).

### 6. Plan stays client-settable (for now)

Because self-serve upgrade is intentional, `config.plan` remains writable via
`PATCH /api/config` and the new `?action=upgrade`. The reserved-key lockdown
(stripping `plan`/`plan_status`/`ls_*`/`renews_at` from the client config merge)
moves to the day Lemon Squeezy is switched on — the reserved-key comment already
marks that spot. Operator grants via `/admin` + `scripts/plans.js` continue to
work regardless.

### 5. i18n

Add to all three locale files (identical key set; parity enforced by
`tests/unit/i18n.js`):
- `support.label` — "Support the project" / "Soutenir le projet" / "Projekt
  unterstützen"
- `settings.plan.inviteOnly` — "Pro is invite-only for now." (+ FR/DE)

Brand names are not translated. Bump `I18N_VERSION` in `app/js/i18n.js` and the
`i18n.js?v=` query on translated pages; run `node tests/unit.js`.

## Data model

No schema change. No new env vars. No new serverless functions (function count
unchanged).

## Error handling / edge cases

- Empty/whitespace url → entry skipped (no broken link).
- All entries empty → support group not rendered.
- External links always `rel="noopener noreferrer"` + `target="_blank"`.

## Testing

- **Unit** (`tests/unit.js`): i18n parity stays green with the new keys; existing
  238 suite unaffected. (`?action=upgrade` is verified manually/integration like
  the other `config.js` actions — no handler unit harness for config.js.)
- **Manual**: footer shows Liberapay + Buy Me a Coffee buttons (once URLs set),
  open in a new tab; an empty-url entry is skipped; Settings upgrade button flips
  to Pro and reveals the donation panel; `config.upgradedAt` is set; `/admin`
  shows the upgraded count; the future `mode:'checkout'` branch redirects (when a
  paid provider returns a URL).

## Out of scope (YAGNI)

Per-band fan-support links, any payment processing or webhooks, donations
granting Pro, env/DB-driven link config (code constant chosen), and the full
Lemon Squeezy paid rollout (separate parked spec).
