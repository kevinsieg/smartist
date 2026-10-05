# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull
request: open this repository's **Security** tab on GitHub and choose
**Report a vulnerability** (GitHub's private vulnerability reporting). The
report, the discussion and any fix stay private until a security advisory is
published.

Helpful to include:

- what an attacker can do, and against which deployment kind (public
  multi-tenant, or one pinned band) if it matters;
- steps or a request sequence that shows it, against your own deployment or
  the local stack (`npm run dev:up`) — never against other people's data;
- the commit or release you tested.

You will get an answer once the report has been read. Please give a fix time
before disclosing anything publicly.

## Scope

The code in this repository: the API (`api/`), the pages (`app/`), the scripts
(`scripts/`) and the CI workflows (`.github/`). Problems in a third-party
service (Vercel, Neon, Cloudflare R2, Resend, Google, Facebook) go to that
service.

## Supported versions

Only the current `main` branch (what production runs) receives fixes.
Self-hosted deployments get a fix by deploying a newer `main`.
