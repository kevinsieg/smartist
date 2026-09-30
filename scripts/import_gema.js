#!/usr/bin/env node
/**
 * Band Tools — GEMA works importer
 *
 * Imports works and rightholders from GEMA CSV exports — the same import the
 * pro-import page runs (api/_domain/gema.js), from the command line.
 * Accepts any combination of the three export files from the same batch:
 *   Identifikatoren-Table 1.csv   → gema_work_number, title, iswc, isrc          (→ gema_works)
 *   Werkinformationen-Table 1.csv → language, performers, genre, duration, dates  (→ gema_works)
 *   Beteiligte-Table 1.csv        → name, role, AR/VR shares per rightholder      (→ gema_rightholders)
 *
 * Works are linked to songs by title (exact, then with umlauts and punctuation
 * folded); unmatched works are imported with song_id = NULL. Rightholders are
 * replaced per work, so re-runs are idempotent. Files are applied in the order
 * ids → info → beteiligte, so rightholders find works imported in the same run.
 *
 * Usage:
 *   node scripts/import_gema.js --artist <slug> [--ids <csv>] [--info <csv>] [--beteiligte <csv>] [--dry-run] [--yes]
 *
 * Reads DATABASE_URL from .env or .env.local in the project root.
 */

'use strict';

const fs = require('fs');
const { loadEnv, confirmDb, connect } = require('./_lib');
const { importWorks, importRightholders } = require('../api/_domain/gema');

async function main() {
  loadEnv();
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const flag   = k => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : null; };

  const slug  = flag('--artist') || process.env.ARTIST_SLUG;
  const files = [['ids', flag('--ids')], ['info', flag('--info')], ['beteiligte', flag('--beteiligte')]]
    .filter(([, file]) => file);

  if (!slug || !files.length) {
    console.error('Usage: node scripts/import_gema.js --artist <slug> [--ids <ids.csv>] [--info <info.csv>] [--beteiligte <beteiligte.csv>] [--dry-run]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

  await confirmDb(process.env.DATABASE_URL, { yes: args.includes('--yes') });
  const sql = connect(process.env.DATABASE_URL);
  try {
    const [band] = await sql`SELECT id, slug, config FROM artists WHERE slug = ${slug} LIMIT 1`;
    if (!band) { console.error(`Band "${slug}" not found`); process.exit(1); }

    for (const [type, file] of files) {
      const csv = fs.readFileSync(file, 'utf8');
      const result = type === 'beteiligte'
        ? await importRightholders(sql, band, csv, { dryRun })
        : await importWorks(sql, band, type, csv, { dryRun });
      if (result.status !== 200) { console.error(`  ${type}: ${result.body.error}`); process.exitCode = 1; continue; }
      const { rows, summary } = result.body;
      for (const row of rows.filter(r => r.error)) console.error(`  ERROR ${row.gema_work_number}: ${row.error}`);
      console.log(`${dryRun ? '[dry-run] ' : ''}${type}: ${JSON.stringify(summary)}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
