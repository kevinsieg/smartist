# Tenant Onboarding Guide

Smartist supports two deployment models. Choose based on your use case.

| Model | DB | Vercel project | When to use |
|---|---|---|---|
| **A — Shared DB** | One Neon DB, multiple `artists` rows | One project per artist | Internal tenants, free/low-cost |
| **B — Dedicated DB** | One Neon DB per artist | One project per artist | Paying clients, full data isolation |

Both models use one Vercel project per artist, one GitHub repo (same code), and the same branch model.

---

## External services — what you need and where to get it

### Neon (PostgreSQL) — required

`dash.neon.tech` → create a project → copy the **pooled connection string** (`?sslmode=require` URL).

For dev/prod isolation, Neon projects have a built-in `main` branch. Create a `dev` branch under the same project for the preview environment. Each branch has its own connection string.

| Env var | Value |
|---|---|
| `DATABASE_URL` | Pooled connection string, e.g. `postgresql://user:pass@ep-xxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require` |

### Cloudflare R2 (file storage) — required

`dash.cloudflare.com` → R2 → Create bucket → Enable **Public Access** → copy the public URL.

Then: Account Home → Manage R2 API Tokens → Create token with **Object Read & Write** on that bucket.

| Env var | Value |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account ID (top-right of dashboard) |
| `R2_ACCESS_KEY_ID` | From the R2 API token |
| `R2_SECRET_ACCESS_KEY` | From the R2 API token |
| `R2_BUCKET_NAME` | Bucket name, e.g. `smartist-bandtwo` |
| `R2_PUBLIC_URL` | Public bucket URL, e.g. `https://pub-xxxx.r2.dev` |

**Per-environment:** ideally use a separate bucket for preview/dev (`smartist-bandtwo-dev`) to keep dev uploads isolated. For demos or internal deployments a single bucket shared across all environments is fine — set the same R2 vars as "All Environments" in Vercel.

**CORS policy (required for photo uploads):** R2 blocks browser presigned PUT requests unless a CORS policy is set. In Cloudflare → R2 → your bucket → Settings → CORS Policy, add:

```json
[
  {
    "AllowedOrigins": ["https://your-artist-domain.com", "http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

List only the origins that use this bucket. Each bucket gets its own CORS policy — do not include domains from other artists' buckets.

### Resend (transactional email) — required

`resend.com` → API Keys → Create key. Verify your sending domain first (DNS records).

| Env var | Value |
|---|---|
| `RESEND_API_KEY` | `re_...` |
| `RESEND_FROM` | Verified sender address, e.g. `noreply@band-two.example` |
| `CONTACT_EMAIL` | Where contact form submissions go (defaults to `ARTIST_ADMIN_EMAIL`) |

Set as "All Environments" in Vercel.

### Google Gemini (AI lyrics suggest) — required if using lyrics feature

`aistudio.google.com` → Get API Key. Free tier: 1 500 req/day, no billing required.

| Env var | Value |
|---|---|
| `GEMINI_API_KEY` | `AIza...` |

Set as "All Environments" in Vercel.

### Better Stack (logging) — optional, production only

`betterstack.com/logs` → Sources → Connect source → copy the ingestion token.

| Env var | Value |
|---|---|
| `BETTERSTACK_TOKEN` | Ingestion token |

Set in **Production environment only**. Preview/dev logs go to Vercel function stdout automatically. Do not put this in `.env` locally (local logs write to `logs/` automatically).

### OAuth login — optional

Only needed if you want Google or Facebook login buttons on the login page.

**Google:** `console.cloud.google.com` → APIs & Services → Credentials → Create OAuth 2.0 client → add `<APP_ORIGIN>/auth/callback` as authorised redirect URI.

**Facebook:** `developers.facebook.com` → Create App → add `<APP_ORIGIN>/auth/callback` as valid OAuth redirect URI.

| Env var | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | From Google Cloud console |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud console |
| `FACEBOOK_APP_ID` | From Facebook developer console |
| `FACEBOOK_APP_SECRET` | From Facebook developer console |

---

## Model A — Shared database (multi-tenant)

One Neon project, one R2 bucket (or two for dev/prod). Each artist gets a row in the `artists` table. All data is scoped by `artist_id` in every query.

**Use this for:** internal projects, personal deployments, low-cost multi-artist setups.

### Step 1 — Create the artist row in the shared DB

Run the setup wizard against the existing Neon main branch (schema is already applied — the wizard will skip it):

```bash
DATABASE_URL=<neon-main-url> node scripts/setup.js
```

The wizard will:
1. Detect schema exists — skip
2. Show existing artists — choose **new**
3. Prompt for slug (e.g. `bandtwo`), display name, and password (**minimum 6 characters**)
4. Configure song display/filter fields and logo URL
5. Write the `artists` row

The slug must match `ARTIST_SLUG` in the Vercel env vars exactly.

Repeat for the dev branch:

```bash
DATABASE_URL=<neon-dev-url> node scripts/setup.js
```

**Troubleshooting:**
- *"syntax error at end of input"* when applying schema → run `psql $DATABASE_URL < scripts/schema.sql` then re-run setup.js
- *"Password must be at least 6 characters"* → use a longer password; re-run the wizard
- Wrong slug entered → fix with `psql $DATABASE_URL -c "UPDATE artists SET slug = 'correct' WHERE slug = 'wrong';"`

### Step 2 — Create the Vercel project

1. Vercel dashboard → **New Project** → import `kevinsieg/smartist`
2. Name it, e.g. `smartist-bandtwo`
3. Framework: **Other** (no build step), production branch: **main**
4. Deploy (will fail — env vars not set yet, that is fine)

### Step 3 — Set environment variables

Vercel project → Settings → Environment Variables:

| Variable | Production | Preview + Development |
|---|---|---|
| `DATABASE_URL` | Neon `main` branch URL | Neon `dev` branch URL |
| `APP_ORIGIN` | `https://smartist.band-two.example` | leave blank (uses auto preview URL) |
| `ARTIST_ADMIN_EMAIL` | your email | your email |
| `R2_BUCKET_NAME` | `smartist-bandtwo` | `smartist-bandtwo-dev` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | prod R2 token | dev R2 token |
| `R2_PUBLIC_URL` | prod bucket public URL | dev bucket public URL |

Set as "All Environments": `ARTIST_SLUG`, `R2_ACCOUNT_ID`, `RESEND_API_KEY`, `RESEND_FROM`, `GEMINI_API_KEY`.

Set as "Production" only: `BETTERSTACK_TOKEN`.

### Step 4 — Add the domain

Vercel project → Settings → Domains → add `smartist.band-two.example` → assign to `main`.

See the DNS section below for the CNAME record to add in Cloudflare.

### Step 5 — Redeploy

Click Redeploy in Vercel (or push any commit). Once DNS propagates, `smartist.band-two.example` serves the artist.

---

## Model B — Dedicated database (single-tenant)

Each artist gets their own Neon project. Complete data isolation.

**Use this for:** paying clients, contractual data separation, demo environments.

### Step 1 — Create a new Neon project

`dash.neon.tech` → New Project → name it, e.g. `smartist-demo`. Create a `dev` branch under it. Copy both pooled connection strings.

### Step 2 — Apply schema and create artist

The new DB is empty. The wizard will detect this and offer to apply the schema:

```bash
DATABASE_URL=<neon-main-url> node scripts/setup.js
# → apply schema when prompted, then create artist (slug: demo, password: 6+ chars)

DATABASE_URL=<neon-dev-url> node scripts/setup.js
# → same
```

**If schema apply fails** ("syntax error at end of input"):
```bash
psql <neon-main-url> < scripts/schema.sql
DATABASE_URL=<neon-main-url> node scripts/setup.js   # re-run, will skip schema
```

### Step 3 — Seed demo data (for demo deployments)

```bash
DATABASE_URL=<neon-main-url> ARTIST_SLUG=demo node scripts/seed.js --force
DATABASE_URL=<neon-dev-url>  ARTIST_SLUG=demo node scripts/seed.js --force
```

### Steps 4–6

Follow Model A steps 2–5 exactly, using the new Neon project's connection strings for `DATABASE_URL`.

---

## Branch / environment model (both models)

```
GitHub branch    →    Vercel environment    →    Neon branch    →    Domain
─────────────────────────────────────────────────────────────────────────────
main             →    Production            →    main           →    custom domain
dev              →    Preview               →    dev            →    auto *.vercel.app
(any PR branch)  →    Preview               →    dev            →    auto *.vercel.app
```

Push to `dev` freely. Merge to `main` via PR only.

---

## Local development

```bash
# Reads .env (not .env.local — vercel dev CLI quirk; keep all vars in .env)
vercel dev
```

Pull env vars from the linked Vercel project:

```bash
vercel env pull .env.local   # wraps values in quotes — loadEnv() in scripts strips them
```

Copy values from `.env.local` into `.env`. Set `DATABASE_URL` to the Neon `dev` branch URL. Do not set `BETTERSTACK_TOKEN` locally.

---

## DNS configuration

### Prerequisite: point your nameservers to Cloudflare

**You must use Cloudflare as your DNS provider** — not your registrar's default DNS — for two reasons:
1. Cloudflare is required to connect a custom domain to an R2 bucket with public access
2. Cloudflare gives full control over DNS records (DMARC, SPF, DKIM, CNAME flattening for apex domains)

At your registrar (OVH, Dogado, Namecheap, etc.): change the nameservers to the two Cloudflare nameservers shown in your Cloudflare dashboard (Websites → your domain → DNS → Nameservers). This is a one-time step per domain. Propagation takes up to 24 hours but is usually under an hour.

Once Cloudflare is active, **all DNS records are managed in Cloudflare** — not at your registrar.

### Adding Vercel records

Add one record per custom domain in Cloudflare → DNS → Records. Set proxy status to **DNS only** (grey cloud) — proxying through Cloudflare breaks Vercel's SSL.

| Domain type | Record type | Name | Value |
|---|---|---|---|
| Apex (`smartist.studio`) | A | `@` | `76.76.21.21` |
| Subdomain (`smartist.band-two.example`) | CNAME | `smartist` | `cname.vercel-dns.com` |
| Subdomain on same domain (`demo.smartist.studio`) | CNAME | `demo` | `cname.vercel-dns.com` |
| www redirect | CNAME | `www` | `cname.vercel-dns.com` |

Then in Vercel: project → Settings → Domains → add the domain → assign to `main`. Vercel will show a banner until DNS propagates (usually under 5 minutes on Cloudflare). SSL is provisioned automatically.

For www: Vercel will offer to set up an automatic redirect from `www` to the apex — accept it.

### DMARC — block email spoofing

Add for every domain you own, even if you are not sending email from it yet. Prevents anyone from spoofing `@yourdomain.com` addresses.

In Cloudflare → DNS → add:

| Type | Name | Content |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=reject;` |

When you set up Resend for that domain later, Resend will add SPF and DKIM alongside it. The DMARC record stays.

### Email domain verification (Resend)

When ready to send email from a domain: Resend dashboard → Domains → Add domain → copy the three records it provides and add them in Cloudflare:

| Type | Purpose |
|---|---|
| TXT | SPF — authorises Resend to send on your behalf |
| TXT (DKIM) | Signs outgoing mail |
| TXT (DMARC) | Replaces the `p=reject` placeholder above — Resend provides a more complete value |

Delivery is blocked until all three show green in the Resend dashboard. Each sending domain needs its own set.

### Deployment-to-domain map

| Vercel project | Repo | Branch | Domain | Status |
|---|---|---|---|---|
| `smartist-bandone` | `smartist` | `main` | `smartist.band-one.example` | live |
| `smartist-demo` | `smartist` | `main` | `demo.smartist.studio` | live |
| `smartist-studio` | `smartist-studio` | `main` | `smartist.studio` | live |
| `smartist-bandtwo` | `smartist` | `main` | `smartist.band-two.example` | ⚠ DNS pending — move band-two.example to Cloudflare, then add CNAME + DMARC |

---

## Checklist

- [ ] Nameservers for the domain updated to Cloudflare at the registrar
- [ ] Cloudflare shows the domain as active
- [ ] Neon DB exists — `main` and `dev` branches — schema applied to both
- [ ] Artist row created in both DBs — slug matches `ARTIST_SLUG` exactly — password 6+ chars
- [ ] R2 bucket created with public access enabled — API token generated
- [ ] Vercel project created, all env vars set per environment
- [ ] Domain added in Vercel (Settings → Domains → assign to `main`)
- [ ] A or CNAME record added in Cloudflare (DNS only — grey cloud)
- [ ] www CNAME added + Vercel redirect configured (optional but recommended)
- [ ] DMARC TXT record added (`_dmarc` → `v=DMARC1; p=reject;`)
- [ ] At least one successful production deploy — Vercel shows green
- [ ] Login works at the custom domain with the password set during `setup.js`
- [ ] (When ready) Resend domain verified — SPF, DKIM, DMARC all green
