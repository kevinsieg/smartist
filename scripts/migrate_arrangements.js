#!/usr/bin/env node
// Adds song_arrangements table and indexes if they don't exist.
// Usage: node scripts/migrate_arrangements.js <database_url>
//        DATABASE_URL=<url> node scripts/migrate_arrangements.js
'use strict';

function loadEnv() {
  try {
    const fs = require('fs'), path = require('path');
    const lines = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n');
    lines.forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (_) {}
}
loadEnv();

const { neon } = require('@neondatabase/serverless');

async function main() {
  const dbUrl = process.argv[2] || process.env.DATABASE_URL;
  if (!dbUrl) { console.error('No DATABASE_URL'); process.exit(1); }

  const sql = neon(dbUrl);
  console.log('DB host:', new URL(dbUrl).hostname);

  await sql`
    CREATE TABLE IF NOT EXISTS song_arrangements (
      id                 SERIAL PRIMARY KEY,
      song_id            INTEGER NOT NULL REFERENCES songs(id)   ON DELETE CASCADE,
      artist_id          INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
      name               TEXT    NOT NULL DEFAULT 'Default',
      is_active          BOOLEAN NOT NULL DEFAULT false,
      hidden_instruments JSONB   NOT NULL DEFAULT '[]',
      rows               JSONB   NOT NULL DEFAULT '[]',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS song_arrangements_song_id_idx ON song_arrangements(song_id)`;
  await sql`CREATE INDEX IF NOT EXISTS song_arrangements_artist_id_idx ON song_arrangements(artist_id, song_id)`;

  console.log('Done — song_arrangements table and indexes are in place.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
