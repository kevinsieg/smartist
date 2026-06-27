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

### 3. Settings Plan section — remove self-serve upgrade

Pro is now invite-only, so the self-serve upgrade/downgrade button built earlier
must be **removed** (otherwise any admin self-grants Pro). In
`app/js/settings.js` `renderPlan()` / `app/settings.html`:
- Keep the plan label and the storage/song usage meters.
- Replace the `#plan-toggle` button with a short note (i18n
  `settings.plan.inviteOnly`, e.g. "Pro is invite-only for now.") followed by the
  shared support links (`renderSupportLinks`).
- Granting Pro stays operator-only via `/admin` + `scripts/plans.js`.

### 4. Lock down client-set plan (security)

With Pro invite-only there is no legitimate client reason to set the plan, so
harden `PATCH /api/config` now (the billing spec planned this; doing it here is
correct): before the `config || ${req.body.config}` merge, **strip the keys**
`plan`, `plan_status`, `ls_subscription_id`, `ls_customer_id`, `renews_at` from
the client-supplied `config` object. The super-admin `?action=admin-set-plan`
(direct UPDATE) and `scripts/plans.js` (direct DB) are unaffected and remain the
only ways to change a plan. (The reserved-key comment already at that line marks
this.)

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

- **Unit** (`tests/unit.js`): reserved-key stripping in the config PATCH —
  `plan` (and the other reserved keys) supplied by a client are NOT written;
  a normal config key (e.g. `displayFields`) still is. i18n parity stays green.
- **Manual**: footer shows Liberapay + Buy Me a Coffee buttons (once URLs set),
  open in a new tab; an empty-url entry is skipped; Settings shows the
  invite-only note + links and no upgrade button; a client `PATCH /api/config`
  with `{config:{plan:'pro'}}` does NOT upgrade the band.

## Out of scope (YAGNI)

Per-band fan-support links, any payment processing or webhooks, donations
granting Pro, env/DB-driven link config (code constant chosen), and the full
Lemon Squeezy paid rollout (separate parked spec).
