# Working with coding agents

The repository is set up so a coding agent (Claude Code, or any tool that reads
`AGENTS.md`) can run the full test suite from its first prompt and cannot reach
production on its own.

## What is in the repository

| File | Purpose |
|------|---------|
| `AGENTS.md` | The rules: public repo, attribution, deployments, API and client conventions |
| `CLAUDE.md` | Imports `AGENTS.md`, plus Claude Code specifics |
| `docs/reference.md` | Where things live: pages, routes, helpers, scripts |
| `scripts/dev_up.sh` | Local stack: own Postgres, schema, seeded band, app on `:3000` |
| `.claude/hooks/session-start.sh` | Cloud sessions: `npm install` and the local stack at start |
| `.claude/settings.json` | Shared permissions (below) |
| `.claude/skills/release` | dev → main: prerequisites, PR, merge, health checks |
| `.claude/skills/schema-change` | Checklist for any change to `scripts/schema.sql` |
| `.claude/skills/steward` | Commit, CI and review conventions for pull requests |

Personal settings go in `.claude/settings.local.json`, which is ignored.

## Local stack

```bash
npm run test:all     # unit, API and browser tests
npm run dev:up       # start the stack and print its env; npm run dev:down stops it
npm run dev:restart  # pick up code changes (the server keeps modules in memory)
```

It runs what CI runs, with no Vercel login and no remote database. Sign in at
`http://localhost:3000/login` as `dev@example.test` / `local-password`.

## Permissions

`.claude/settings.json` sorts commands into three groups:

- **Allowed:** the test and dev scripts, `apply_schema.js --check`, read-only git.
- **Ask first:** every script that writes data (`seed`, `import_*`,
  `create_user`, `plans`, `apply_schema`, `demo_reset`, `setup`), and
  `db_backup` / `db_restore`.
- **Denied:** pushes to `main`, `delete_artist.js`, `vercel env` and production
  deploys, and reading `.env` / `.env.local`.

These are guard rails for honest mistakes, not a security boundary: the real
boundary is what credentials an agent can see.

## Guard rails outside the repository

Set these once; nothing in the repository can enforce them.

1. **Protect `main` on GitHub** (Settings → Branches → Add rule for `main`):
   require a pull request before merging, require the status checks
   *Unit tests*, *Integration + browser tests (local Postgres)* and *Live code
   on the new schema*, and do not allow force pushes or deletions.
2. **No production credentials in agent environments.** The cloud environment
   an agent runs in (environment settings → environment variables) should hold
   at most the **dev** database URL — the session hook points `DATABASE_URL` at
   the local database anyway. Production connection strings stay with people;
   schema changes reach production through each deployment's build
   (`scripts/deploy_migrate.js`), and data scripts against production are run
   by hand.
3. **Vercel tokens** in CI are repository secrets used only by the preview job;
   agents do not need them.
