---
name: schema-change
description: Checklist for any database schema change in smartist — adding a table, column, index or constraint to scripts/schema.sql, bumping SCHEMA_VERSION, applying it locally and on dev, and what production needs. Use whenever a change touches scripts/schema.sql or needs a new column.
---

# Schema change

`scripts/schema.sql` is the whole schema and must stay idempotent: every
database gets the blocks it has not recorded in `schema_migrations`, a fresh
one gets all of it, and CI applies it twice.

1. **Append** a dated block at the end of `scripts/schema.sql` — never edit an
   earlier block that production already ran:
   ```sql
   -- YYYY-MM-DD: why this change exists
   ALTER TABLE songs ADD COLUMN IF NOT EXISTS foo TEXT;
   CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_foo_idx ON songs(artist_id, foo);
   INSERT INTO schema_migrations (id) VALUES ('YYYY-MM-DD') ON CONFLICT DO NOTHING;
   ```
   - `IF NOT EXISTS` / `IF EXISTS` everywhere. No `DO $$` blocks: `apply_schema.js`
     splits on `;`. Constraints that cannot say `IF NOT EXISTS` are fine —
     "already exists" errors are skipped.
   - Two changes on one day: suffix the id (`2026-10-01b`).
   - A new index on an existing table: `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
     (no write lock while live traffic runs). Every other statement runs with a
     5 s `lock_timeout` (`scripts/apply_schema.js`): a deploy that cannot get its
     lock fails and is redeployed, instead of queueing every query behind it.
2. **Set `SCHEMA_VERSION`** in `api/_env.js` to the new id (`tests/unit/env.js`
   fails otherwise).
3. **Update the code and docs together:** handlers, `api/_domain/*`, the
   export in `api/_band/export.js` if the table holds band data,
   `DATABASE.md` (column tables), `openapi.json` for API-visible fields.
4. **Verify locally:** `npm run dev:up` applies it to the local database;
   `node scripts/apply_schema.js --check` there; then `npm run test:all`.
5. **Deployments migrate themselves:** each build runs `scripts/deploy_migrate.js`
   against its own database, a minute or two before the new code goes live.
   So the code on `main` must keep working on the new schema: add freely;
   drop or rename a column only in a release after the code stopped using it.
   CI's *Live code on the new schema* job runs `main`'s API suite on it.
   After the deploy, the health check must say `"schema":"current"`.
