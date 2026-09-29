# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Cloud sessions start with the local stack up (`.claude/hooks/session-start.sh`):
  `DATABASE_URL` points at the local database, the app runs on `:3000`, and
  `npm run test:all` works from the first prompt. Sign in there as
  `dev@example.test` / `local-password`.
- Shared permissions in `.claude/settings.json`: tests and read-only git are
  allowed, data scripts ask, pushes to `main`, `delete_artist` and Vercel
  production commands are denied. Personal overrides go in
  `.claude/settings.local.json` (ignored).
- Skills: `release` (dev → main), `schema-change`, `steward` (PR and CI
  conventions — read it before acting on CI or review events).
- Before editing an area, read its section in `docs/reference.md`.
