# Billing Integration (Lemon Squeezy) — Design

Date: 2026-06-27
Status: Approved for planning
Builds on: `docs/2026-06-27-subscription-tiers-design.md` (the tier system this monetizes)

## Goal

Let bands pay for the existing **Pro** tier via **Lemon Squeezy (Merchant of
Record)**, with the least possible code and compliance burden. The tier system
already enforces entitlements; billing only needs to drive `artists.config.plan`
from real subscription state. `getPlan(artist)` remains the single seam — the
webhook becomes what writes `config.plan`, replacing the self-serve placeholder.

Priorities, in order: **(1) legal simplicity** (solo French founder, no company
yet), **(2) minimal code surface**, **(3) easy UX**.

## Why Lemon Squeezy (Merchant of Record)

LS is the legal seller to the customer, so LS — not the operator — handles
French/EU VAT, customer invoices, "mentions légales", and tax remittance. The
operator receives B2B payouts and declares them as income. This removes the
entire VAT/invoicing/tax surface from both the code and the operator's legal
obligations. Stripe was rejected for now because it makes the operator the
merchant (own VAT registration + filing). The architecture stays
provider-agnostic at `getPlan()`, so a future Stripe move is contained.

## Legal & business prerequisites (France) — go-live checklist

Not code, but required before connecting payouts / going live. (Operator to
verify specifics with URSSAF / an expert-comptable — this is not legal advice.)

1. **Register as micro-entrepreneur** (auto-entrepreneur) at
   `autoentrepreneur.urssaf.fr` / the guichet unique (INPI) → obtain a SIRET.
   Simplified sole-trader status; no company/capital required.
2. **Lemon Squeezy store + payout setup**: connect payout method, complete tax
   form (W-8BEN as a non-US individual).
3. **Declare LS payouts** as micro-entreprise revenue (monthly/quarterly URSSAF
   declaration). Below the franchise-en-base-de-TVA thresholds, no VAT is
   charged by the operator (and LS handles customer VAT regardless).
4. Nothing in this checklist blocks building/testing the integration — only
   going live with real payments.

## Architecture

The tier system already enforces limits/features. Billing adds exactly **one
moving part on our side: a webhook receiver.** Everything customer-facing is a
hosted Lemon Squeezy URL.

```
[Settings: Upgrade] --GET--> config.js ?action=ls-checkout
       returns LS hosted-checkout URL + signed custom_data token
                  |
                  v
   Lemon Squeezy hosted checkout (card / PayPal / SEPA; VAT handled by LS)
                  |
                  v   (LS POSTs subscription events)
       /api/lemon-webhook  --verify HMAC--> write artists.config (plan, status, ids)
                  |
                  v
        getPlan(artist) reads config.plan  (unchanged seam)
```

- **Upgrade** = hosted LS checkout URL (Monthly/Annual = two LS variants, both →
  `plan=pro`). No billing UI built.
- **Manage / cancel** = LS hosted customer-portal URL (from the subscription
  object). No billing UI built.
- **Webhook** = the only new server code. Its own function with body parsing
  disabled (raw body required for signature verification).

## Prerequisite: free one serverless-function slot

The app is at the 12-function Hobby limit. Merge `api/[artist]/gigs/[id].js`
into `api/[artist]/gigs.js` using body-field routing (the pattern `setlists.js`
already uses for duplicate/share), removing the standalone `[id].js` function.
That frees the slot for `api/lemon-webhook.js`. Net function count stays ≤ 12.
Re-run the gigs integration tests after the merge.

## Components

### 1. `api/lemon-webhook.js` (NEW function)

- Vercel config: `export const config = { api: { bodyParser: false } }` — read
  the raw body, since LS signs it.
- Verify `X-Signature` = HMAC-SHA256(rawBody, `LEMONSQUEEZY_WEBHOOK_SECRET`),
  timing-safe compare. Reject mismatches with 401.
- Parse the JSON, read `meta.event_name`, `meta.custom_data` (our signed token),
  and the subscription object.
- Verify the signed token (see §2) → resolve `artist_id`. Reject if invalid.
- Apply the lifecycle mapping (§3) via the JSONB `||` merge.
- **Idempotency**: dedupe/ignore stale events (LS retries) — compare against the
  stored `ls_subscription_id` + the subscription's `updated_at`; only apply if
  newer. Always return 200 quickly on success so LS stops retrying.

### 2. Checkout link + anti-tampering (rides `config.js`, no new function)

- New GET action `?action=ls-checkout&slug=<slug>&variant=<monthly|annual>`:
  - `requireAuth(..., 'admin')` — only a band admin can start an upgrade.
  - Mint a short **signed token** (reuse the existing HMAC helper in
    `api/_token.js`, e.g. a `generateUserToken`-style signature) embedding
    `artist_id` + buyer `user_id`. This is the LS `custom_data`.
  - Build the LS hosted-checkout URL for the requested variant with
    `checkout[custom][token]=<token>` and `checkout[email]=<buyer email>`
    prefilled. Return `{ url }`.
- Because the band binding is a server-signed token (not a raw slug), a user
  cannot upgrade a band they do not administer by editing the URL.

### 3. Webhook lifecycle → state mapping

Written into `artists.config` (JSONB `||` merge; never `JSON.stringify`):

| LS event | `plan` | `plan_status` | also store |
|----------|--------|---------------|------------|
| `subscription_created`, `subscription_payment_success`, `subscription_resumed` | `pro` | `active` | `ls_subscription_id`, `ls_customer_id`, `renews_at` |
| `subscription_payment_failed` | `pro` (unchanged) | `past_due` | — |
| `subscription_cancelled` | `pro` (unchanged) | `cancelled` | `renews_at` = period end |
| `subscription_expired`, `subscription_unpaid` | `free` | `expired` | clear `renews_at` |

Behavioral defaults (confirmed): **cancel keeps Pro until period end**;
**payment failure keeps Pro through LS dunning, downgrades only on expiry.**
The only actual downgrade point is `expired`.

### 4. Settings UI

Replace the placeholder upgrade button (`settings.js` Plan section):
- **Free band**: "Upgrade to Pro" → two links (Monthly / Annual) that call
  `?action=ls-checkout` and redirect to the returned LS URL.
- **Pro band**: status line from `config` — `active` → "Pro — renews {renews_at}";
  `cancelled` → "Pro — cancels {renews_at}"; `past_due` → "Payment failed —
  update your payment method" — plus a **"Manage subscription"** link to the LS
  customer-portal URL.

### 5. Lock down client-set plan (security)

`PATCH /api/config`'s config merge currently accepts any keys (the placeholder
upgrade). After billing, **strip `plan`, `plan_status`, `ls_subscription_id`,
`ls_customer_id`, `renews_at`** from the client-supplied `config` before the
merge — these become webhook-only. The super-admin `?action=admin-set-plan`
remains the sole manual override. (The reserved-key comment already added in
`api/config.js` marks this spot.)

## Data model

All on `artists.config` (JSONB), no schema migration:
`plan` (`free|pro`), `plan_status` (`active|past_due|cancelled|expired`),
`ls_subscription_id`, `ls_customer_id`, `renews_at` (ISO). `getPlan` /
`planSummary` already read `config.plan`; add the billing fields to the config
payload's `plan` object for the Settings status line.

## Environment variables

`LEMONSQUEEZY_WEBHOOK_SECRET` (signature), `LEMONSQUEEZY_STORE` and the variant
identifiers / checkout base URLs for Monthly and Annual (`LS_VARIANT_MONTHLY`,
`LS_VARIANT_ANNUAL`), and `LS_API_KEY` only if checkout URLs must be created via
API rather than static hosted links. Verify exact LS field names/URL shapes
against current Lemon Squeezy docs during implementation.

## Error handling

- Bad/absent signature → 401, no state change.
- Valid signature but invalid/missing token → 400, log, no state change.
- Unknown event name → 200 (acknowledge, ignore) so LS does not retry.
- Stale event (older than stored state) → 200, ignore.
- DB write failure → 500 so LS retries (idempotent merge makes retries safe).

## Testing

- **Unit**: signature verification (good/bad/timing), token mint+verify roundtrip,
  the event→state mapping as a pure function (`mapLemonEvent(eventName, sub) ->
  {plan, plan_status, ...}`), reserved-key stripping in the config PATCH.
- **Integration**: post sample LS payloads (from LS docs) to `/api/lemon-webhook`
  with a valid signature and assert `config` transitions free→pro→cancelled→
  expired; assert tampered/invalid signatures are rejected.
- **Manual (test mode)**: LS test-mode checkout → observe webhook → band flips to
  Pro in Settings; cancel in portal → status `cancelled`; let it expire → free.

## Out of scope (YAGNI)

Proration math (LS handles), invoices/receipts (LS emails as MoR), tax (LS),
multiple paid tiers, usage-metered billing, in-app payment forms, annual→monthly
self-serve switching beyond what the LS portal offers, Stripe.

## Open items to verify during implementation

1. Exact LS webhook event names, payload field paths (`renews_at`,
   `customer_portal` URL, `custom_data` location), and signature header — against
   current LS docs.
2. Whether hosted-checkout static URLs accept our `checkout[custom]` token, or
   whether a create-checkout API call is needed (would still ride `config.js`).
3. Final function count after the gigs merge (must be ≤ 12).
