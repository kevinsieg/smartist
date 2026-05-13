# smartist.studio landing page — design spec

**Date:** 2026-05-13
**Branch:** dev
**Domain:** smartist.studio (OVH)
**Target deployment:** Vercel dev preview

---

## Overview

A standalone marketing/showcase landing page served at `smartist.studio`, pointing at the dev Vercel deployment and dev database. Primary audiences: independent musicians looking for a tool, and long-term investors. The page links directly into the live app (dev DB) so visitors can try a real demo immediately.

---

## Visual design

Warm editorial aesthetic: `#f5f0ea` cream background, `#b06a2a` amber accent, `#1a1a1a` near-black body text, `#ede5d8` sand for the feature section. Monospace typeface (`Courier New`) throughout. Minimal chrome, no images.

Approved mockup: `.superpowers/brainstorm/68561-1778679121/content/full-mockup-v3.html`

---

## Page structure

### Header
- Wordmark: `smartist`
- Nav links: `github` (→ GitHub repo) and `contact` (→ mailto or contact form)

### Hero
- Max-width 680px, centred
- Eyebrow label: "band management tools"
- H1: "The toolkit independent musicians *actually* need."
- 40px amber divider
- Subtitle: "Streamline your artist organisation and keep the full overview — setlists, song catalogue, GEMA reporting, social reach, platform availability. Built by a musician, for musicians. No subscriptions. No bloat."
- Decorative waveform: CSS bars (amber, 10% opacity) absolutely positioned at the right edge of the hero container
- CTA button: "Open demo →" linking to `/setlist` on the dev deployment

### Feature strip
8 tiles, each with a badge, title, and short description:

| Badge | Title | Core description |
|---|---|---|
| sets | Setlists | Generate, reorder, save to gigs, share as PDF |
| library | Songs | Catalogue, play count, AI lyrics, attachments |
| rights | PRO | Performing rights org data import — CSV, dry-run |
| gigs | Gig management | Venues, contracts, set times, finances |
| venues | Venue database | Searchable profiles, capacity, booking contacts |
| AI | Tour planning | AI routing, outreach, forecast, conflict detection |
| insights | Artist Hub | Platform availability, social reach, physical sales |
| live | Stage view | Full-screen on-stage setlist display |

**Responsive layout:** floating card (shadow, 16px horizontal margin) on mobile. Column breakpoints: 1 col (< 360px), 2 col (≥ 360px), 4 col (≥ 540px), 8 col / flat full-width strip (≥ 1050px).

### Bottom section
- Label: "open source · self-hosted · managed"
- Intro paragraph with GitHub link
- Two plan cards side by side (stacked on mobile < 560px):
  - **Self-hosted** (light card): "Free forever." — MIT, Vercel + Neon, GitHub link CTA
  - **Managed** (dark card `#2e2e2e`): "We handle everything." — hosted domain, backups, GEMA & R2 setup, priority support — "Get in touch →" CTA
- Email subscribe row (input + button), wraps on narrow viewports

### Footer
- Wordmark + "open source · MIT · built by a working musician · 2026"

---

## Routing

The landing page must only render when the request host is `smartist.studio` (or `www.smartist.studio`). All other hosts (including the Vercel preview URL) continue to serve the existing app.

**Implementation:** A `vercel.json` rewrite rule maps requests from `smartist.studio` to `app/landing.html` using the `has` condition on the `host` header. No middleware file needed — pure static rewrite, zero cold-start cost.

```
smartist.studio/* → serve app/landing.html (static, no auth)
*.vercel.app/*    → existing app (unchanged)
smartist.salmons.fr/* → existing app on main (unchanged)
```

The subscribe form POST hits a new lightweight endpoint `api/subscribe.js` (counts against the 12-function Hobby limit — see trade-offs).

---

## Subscribe endpoint

`POST /api/subscribe` — accepts `{ email }`, validates format, stores in a new `subscribers` table (email, created_at, source). Returns 200 on success, 400 on bad input, 409 on duplicate. No auth required. Rate-limited by IP (reuses `checkRateLimit` from `api/_ratelimit.js`).

The table is intentionally minimal — no confirmation flow for now. A confirmation email can be added later.

---

## DNS / domain setup

1. Add `smartist.studio` as a custom domain on the **dev** Vercel project (not production).
2. On OVH: point the apex (`@`) at Vercel's IP (`76.76.21.21`) and add a CNAME for `www` → `cname.vercel-dns.com`.
3. Vercel auto-provisions TLS.

---

## New database table

```sql
CREATE TABLE IF NOT EXISTS subscribers (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'landing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Added to `scripts/schema.sql` and applied via a migration script.

---

## File changes

| File | Action |
|---|---|
| `app/landing.html` | Create — full landing page HTML/CSS (self-contained, no `common.js`) |
| `vercel.json` | Update — add `has`-host rewrite rule for `smartist.studio` |
| `api/subscribe.js` | Create — subscribe endpoint |
| `scripts/schema.sql` | Update — add `subscribers` table |
| `scripts/migrate-subscribers.js` | Create — one-shot migration for existing DBs |

---

## Trade-offs and constraints

- **Function count:** `api/subscribe.js` uses one of the 12 Hobby-plan slots (currently 12 used). Either consolidate an existing endpoint or upgrade the plan before shipping. The simplest fix is to merge subscribe into `api/config.js` as a POST branch, keeping the slot count at 12.
- **No www redirect needed** for launch — OVH CNAME handles `www`, Vercel serves both.
- **Demo data:** a demo band already exists in the dev DB; the CTA links to `/setlist` which shows it without auth.
- **No analytics** in scope for this spec.
