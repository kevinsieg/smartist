---
name: release
description: Promote dev to production — open the dev → main PR, check schema and env prerequisites on every deployment, merge once CI is green, then verify each deployment's health check. Use when asked to release, deploy, ship, merge to main or open the PR to main.
---

# Release dev → main

`main` is production and changes only through a PR from `dev`. Several Vercel
projects deploy `main`, each with its own database and env vars.

1. **Start from green.** `git fetch origin main dev`. CI on the latest `dev`
   commit must be green. List what ships: `git log --oneline origin/main..origin/dev`.
2. **Prerequisites — ask the user, never do these yourself:**
   - A schema change in the range (`git diff origin/main..origin/dev -- scripts/schema.sql`)
     must be applied to **every** production database *before* the merge:
     `DATABASE_URL=<prod> node scripts/apply_schema.js`, then `--check`.
     Production connection strings are the user's; do not ask for them.
   - A new variable in `api/_env.js` must be set on every Vercel project.
   - Anything that changes who can sign in (see recent commits) needs a note.
3. **Open the PR** `dev` → `main`. Body: what ships, grouped by theme, plus a
   "Before deploy" section with the prerequisites above. **No attribution:** no
   "Generated with Claude Code" line or session link. If the tool appends a
   footer, read the PR back and update the body without it.
4. **Wait for CI on the PR** (unit, local Postgres + browser, Vercel preview).
   Red → fix on `dev`, never on `main`.
5. **Merge** only when the user asked for it and checks are green. Merge commit
   (not squash), explicit title `Merge dev: <summary>` — never a `claude/…`
   branch name — and pass `expectedHeadSha`.
6. **After deploy:** `GET https://<deployment>/api/config?action=health` on each
   production domain → 200, `"schema":"current"`, `missing: []`. Report any
   deployment that is not.
