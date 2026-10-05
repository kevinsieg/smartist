# Contributing

Thank you for helping. The short version:

1. **Read [`AGENTS.md`](AGENTS.md).** Its rules apply to every change, by people
   and coding agents alike: one API function with a route table, ownership checks
   on every foreign id, no inline script, i18n parity, `?v=` bumps, dated schema
   blocks and the rest. [`docs/reference.md`](docs/reference.md) says where things
   live.
2. **Branch from `dev` and open the pull request against `dev`.** `main` is
   production and changes only through a release PR from `dev`.
3. **Before you push**, all three must pass:

   ```bash
   npm run lint
   npm run typecheck
   npm run test:unit
   ```

   For API or page changes also run `npm run test:all` (unit, API and browser
   tests on a local stack; it needs the PostgreSQL server binaries and Playwright
   — see [`tests/README.md`](tests/README.md)). Add or adjust tests for the
   behaviour you change.
4. **The repository is public.** No personal data, tenant names, email
   addresses or private infrastructure details in code, docs, commits or PR text.
5. **Schema changes** follow the checklist in
   [`.claude/skills/schema-change/SKILL.md`](.claude/skills/schema-change/SKILL.md).

Security problems: see [`SECURITY.md`](SECURITY.md), not a public issue.

By contributing you agree that your contribution is licensed under the
[GNU AGPL v3.0 or later](LICENSE), like the rest of the project.
