---
name: steward
description: Conventions for driving a smartist pull request to green — commits, pushes, CI failures, review comments and attribution. Read before acting on CI or review events on a PR in this repository.
---

# Steward — PR and CI conventions

Commit identity, the no-attribution rule (read every PR body and comment back
and strip the tool's footer) and the public-repository rules are in
`AGENTS.md` → *Commits and pull requests* and *The repository is public*.
Follow them on every commit, push, PR body and comment.

- **Branches:** work on the assigned branch; `dev` takes direct pushes; `main`
  only through a PR (see the `release` skill), merged only after the user
  says so. Merge `origin/dev` into a feature branch rather than rebasing
  someone else's history. Delete the branch once its PR is merged.
- **Fewer, bigger pushes:** every push to a PR branch costs a Vercel preview
  deploy. Batch fixes locally and push once, not commit by commit.
- **Before every push:** `npm run lint`, `npm run typecheck` and `npm run test:unit`; for API or page changes also
  `npm run test:api` and `npm run test:smoke` (local stack, same as CI).
- **CI red:** reproduce locally first with the same command, fix the cause,
  push once. The browser job fails on any console error — a missing script or
  helper is the usual cause (`tests/unit/page_scripts.js` catches most).
  "Integration tests (Vercel preview)" talks to the dev database: a failure
  there that the local job does not show is often data or env, not code.
- **Review comments:** small, local asks → fix and push; design-level asks →
  answer with a proposal and let the user decide.
