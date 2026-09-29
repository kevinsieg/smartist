---
name: steward
description: Conventions for driving a smartist pull request to green — commits, pushes, CI failures, review comments and attribution. Read before acting on CI or review events on a PR in this repository.
---

# Steward — PR and CI conventions

- **Commit as the owner, no attribution:**
  `git -c user.name="Käv" -c user.email="35451482+kevinsieg@users.noreply.github.com" commit …`
  No `Co-Authored-By:` / `Claude-Session:` trailers, no "Generated with Claude
  Code" line in PR bodies, comments or review replies. If a tool appends a
  footer, edit it out.
- **Branches:** work on the assigned branch; `dev` takes direct pushes; `main`
  only through a PR (see the `release` skill). Merge `origin/dev` into a
  feature branch rather than rebasing someone else's history.
- **Before every push:** `npm run test:unit`; for API or page changes also
  `npm run test:api` and `npm run test:smoke` (local stack, same as CI).
- **CI red:** reproduce locally first with the same command, fix the cause,
  push once. The browser job fails on any console error — a missing script or
  helper is the usual cause (`tests/unit/page_scripts.js` catches most).
  "Integration tests (Vercel preview)" talks to the dev database: a failure
  there that the local job does not show is often data or env, not code.
- **Review comments:** small, local asks → fix and push; design-level asks →
  answer with a proposal and let the user decide.
- **Public repository:** no tenant names, emails or hostnames in commits,
  code, docs or PR text. Plans and notes go to `docs/plans/` (git-ignored).
