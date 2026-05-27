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

For the branch model (dev/prod isolation), Neon projects have a built-in `main` branch. Create a `dev` branch under the same project for the preview environment. Each branch has its own connection string.

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
| `R2_BUCKET_NAME` | Bucket name, e.g. `smartist-klang` |
| `R2_PUBLIC_URL` | Public bucket URL, e.g. `https://pub-xxxx.r2.dev` |

**Per-environment:** use a separate bucket for preview/dev (`smartist-klang-dev`) to keep dev uploads isolated.

### Resend (transactional email) — required

`resend.com` → API Keys → Create key. Verify your sending domain first (DNS records).

| Env var | Value |
|---|---|
| `RESEND_API_KEY` | `re_...` |
| `RESEND_FROM` | Verified sender address, e.g. `noreply@kevinklang.de` |
| `CONTACT_EMAIL` | Where contact form submissions go (defaults to `ARTIST_ADMIN_EMAIL`) |

These are the same across all environments — set them as "All Environments" in Vercel.

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

One Neon project, one R2 bucket (or two buckets for dev/prod). Each artist gets a row in the `artists` table. All artist data is scoped by `artist_id` in every query.

**Use this for:** internal projects, personal deployments, low-cost multi-artist setups.

### Step 1 — Create the Vercel project

1. Vercel dashboard → **New Project** → import the `smartist` GitHub repo
2. Name it, e.g. `smartist-klang`
3. Do not change framework or build settings (no build step)
4. Deploy (will fail — env vars not set yet, that is OK)

### Step 2 — Set environment variables

In the new Vercel project → Settings → Environment Variables, add:

| Variable | Production | Preview | Development |
|---|---|---|---|
| `DATABASE_URL` | Neon `main` branch URL | Neon `dev` branch URL | Neon `dev` branch URL |
| `ARTIST_SLUG` | `klang` | `klang` | `klang` |
| `ARTIST_ADMIN_EMAIL` | admin email | dev alias, e.g. `you+klang-dev@domain.com` | — |
| `APP_ORIGIN` | `https://smartist.kevinklang.de` | your stable preview URL or `https://smartist-klang.vercel.app` | `http://localhost:3000` |
| `R2_ACCOUNT_ID` | same for all | same for all | same |
| `R2_ACCESS_KEY_ID` | same for all | same for all | same |
| `R2_SECRET_ACCESS_KEY` | same for all | same for all | same |
| `R2_BUCKET_NAME` | `smartist-klang` | `smartist-klang-dev` | `smartist-klang-dev` |
| `R2_PUBLIC_URL` | prod bucket public URL | dev bucket public URL | dev bucket public URL |
| `RESEND_API_KEY` | all environments | all environments | all environments |
| `RESEND_FROM` | all environments | all environments | all environments |
| `GEMINI_API_KEY` | all environments | all environments | all environments |
| `BETTERSTACK_TOKEN` | Production only | — | — |

### Step 3 — Create the artist row in the shared DB

Point `DATABASE_URL` at the **Neon main branch** (the same DB the existing artist uses):

```bash
DATABASE_URL=<neon-main-url> node scripts/setup.js
```

The wizard will:
1. Detect the schema is already applied — skip
2. Show existing artists — choose **new**
3. Prompt for slug (`klang`), display name, and password
4. Configure song display/filter fields and logo URL
5. Write the `artists` row and seed placeholder venues

The slug you enter here must match `ARTIST_SLUG` in the Vercel env vars exactly.

Repeat with the **Neon dev branch URL** to create the same artist row on the dev DB:

```bash
DATABASE_URL=<neon-dev-url> node scripts/setup.js
```

### Step 4 — Add the production domain

Vercel project → Settings → Domains → Add `smartist.kevinklang.de` → assign to `main` branch.

Configure your DNS provider: add a CNAME record pointing `smartist.kevinklang.de` → `cname.vercel-dns.com`.

### Step 5 — Redeploy

Trigger a redeploy (push any commit or click Redeploy in Vercel). The production deployment will now serve artist `klang` at `smartist.kevinklang.de`.

The `dev` branch automatically gets a preview deployment at the auto-generated `.vercel.app` URL.

---

## Model B — Dedicated database (single-tenant)

Each artist gets their own Neon project entirely. Complete data isolation: the `DATABASE_URL` in one Vercel project never shares a DB with any other project.

**Use this for:** paying clients, contractual data separation requirements, situations where one client must be able to export/delete all their data without touching others.

### Step 1 — Create a new Neon project

`dash.neon.tech` → New Project → name it, e.g. `smartist-klang`.

The project comes with a `main` branch. Create a `dev` branch under it for the preview environment.

Copy both connection strings (pooled).

### Step 2 — Apply the schema

The new DB is empty. Run the setup wizard against the new DB's main branch — it will detect no schema and offer to apply it:

```bash
DATABASE_URL=<new-neon-main-url> node scripts/setup.js
```

Then for the dev branch:

```bash
DATABASE_URL=<new-neon-dev-url> node scripts/setup.js
```

### Steps 3–5

Follow Model A steps 1–5 exactly, substituting the new Neon project's connection strings for `DATABASE_URL`. Everything else is identical.

**Only difference from Model A:** `DATABASE_URL` points to a Neon project that contains only this artist's data.

---

## Branch / environment model (both models)

```
GitHub branch    →    Vercel environment    →    Neon branch    →    Domain
─────────────────────────────────────────────────────────────────────────────
main             →    Production            →    main           →    custom domain
dev              →    Preview               →    dev            →    *.vercel.app or custom preview domain
(any PR branch)  →    Preview               →    dev            →    auto *.vercel.app
```

Push to `dev` freely. Merge to `main` via PR only.

---

## Local development

```bash
# In the project root — reads .env (not .env.local, CLI 52.x quirk)
vercel dev
```

Pull env vars from the linked project:

```bash
vercel env pull .env.local   # wraps values in quotes — loadEnv() strips them
```

Copy `.env.local` to `.env` (the CLI reads `.env`). Set `DATABASE_URL` to the Neon `dev` branch URL. Do not set `BETTERSTACK_TOKEN` locally.

---

## DNS configuration

Vercel needs a DNS record per custom domain. The record type depends on whether it is an apex domain (no subdomain) or a subdomain.

| Domain type | Record type | Value |
|---|---|---|
| Apex (`smartist.studio`, `salmons.fr`) | **A** | `76.76.21.21` |
| Subdomain (`smartist.kevinklang.de`, `demo.smartist.studio`) | **CNAME** | `cname.vercel-dns.com` |

Add these at your DNS provider (Cloudflare, OVH, Namecheap, etc.). TTL 300–3600 is fine.

**How to add a domain in Vercel:** Vercel project → Settings → Domains → Add domain → assign to a branch (`main` for production, `dev` for a stable preview domain).

Vercel will show an error banner until the DNS record propagates (usually under 5 minutes on Cloudflare, up to an hour elsewhere). SSL is provisioned automatically once the record resolves.

### Deployment-to-domain map

| Vercel project | Repo | Branch | Domain | DNS |
|---|---|---|---|---|
| `smartist-salmons` | `smartist` | `main` | `smartist.salmons.fr` | A → `76.76.21.21` |
| `smartist-salmons` | `smartist` | `dev` | *(auto preview URL)* | — |
| `smartist-klang` | `smartist` | `main` | `smartist.kevinklang.de` | CNAME → `cname.vercel-dns.com` |
| `smartist-klang` | `smartist` | `dev` | *(auto preview URL)* | — |
| `smartist-demo` | `smartist` | `main` | `demo.smartist.studio` | CNAME → `cname.vercel-dns.com` |
| `smartist-studio` | `smartist-studio` | `main` | `smartist.studio` | A → `76.76.21.21` |
| `smartist-studio` | `smartist-studio` | `dev` | *(auto preview URL)* | — |

### Email domain (Resend)

Resend requires DNS records to verify your sending domain before it will deliver email. In the Resend dashboard: Domains → Add domain → copy the three records it provides:

| Type | Purpose |
|---|---|
| TXT | SPF — authorises Resend to send on your behalf |
| TXT (DKIM) | Signs outgoing mail to prove authenticity |
| TXT (DMARC) | Tells receivers what to do with unauthenticated mail |

Resend shows exact record values per domain. Add them all — delivery will be blocked until all three verify (green in Resend dashboard).

Each sending domain needs its own set of records. If you send from `noreply@salmons.fr` and `noreply@kevinklang.de`, both domains need verification.

---

## Checklist

- [ ] Neon DB exists, schema applied to both `main` and `dev` branches
- [ ] Artist row created in both `main` and `dev` DBs — slug matches `ARTIST_SLUG` exactly
- [ ] R2 bucket (prod) and dev bucket created — both with public access enabled
- [ ] Vercel project created, all env vars set per environment
- [ ] Custom domain added in Vercel (Settings → Domains → assign to `main` branch)
- [ ] DNS A or CNAME record added at your DNS provider — record resolves, Vercel shows green
- [ ] Resend sending domain verified — SPF, DKIM, DMARC all green in Resend dashboard
- [ ] At least one successful production deploy completed
- [ ] Login works at the custom domain with the password set during `setup.js`
