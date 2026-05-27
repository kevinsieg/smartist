#!/usr/bin/env node
/**
 * Migration: rename tempo→energy, add time_signature, add heart
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node scripts/migrate-energy-heart.js
 */

'use strict';

const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  console.error('Usage: DATABASE_URL="postgres://..." node scripts/migrate-energy-heart.js');
  process.exit(1);
}

let host;
try { host = new URL(DATABASE_URL).hostname; } catch { host = '(unknown)'; }
console.log(`\nDatabase: ${host}`);
console.log('Running migration…\n');

const sql = neon(DATABASE_URL);

(async () => {
  await sql`ALTER TABLE songs RENAME COLUMN tempo TO energy`;
  console.log('✓  renamed tempo → energy');

  await sql`ALTER TABLE songs ADD COLUMN IF NOT EXISTS time_signature TEXT`;
  console.log('✓  added time_signature TEXT');

  await sql`ALTER TABLE songs ADD COLUMN IF NOT EXISTS heart BOOLEAN NOT NULL DEFAULT false`;
  console.log('✓  added heart BOOLEAN DEFAULT false');

  console.log('\nMigration complete.');
})().catch(e => {
  console.error('\nMigration failed:', e.message);
  process.exit(1);
});
