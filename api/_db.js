const { neon } = require('@neondatabase/serverless');

// ── Database provider ─────────────────────────────────────────────────────────
// Current: Neon (serverless PostgreSQL over HTTP, @neondatabase/serverless)
// To switch to a standard PostgreSQL pool replace the connect function —
// both postgres.js and pg return an sql tagged-template executor with the
// same interface used throughout this codebase (sql`SELECT ...`).
//   postgres.js:  connect: url => require('postgres')(url)
//   pg (Pool):    connect: url => { const { Pool } = require('pg'); ... }
const DB = {
  connect: url => neon(url),
};
// ─────────────────────────────────────────────────────────────────────────────

let _sql;
function getDb() {
  if (!_sql && process.env.DATABASE_URL) _sql = DB.connect(process.env.DATABASE_URL);
  if (!_sql) throw new Error('DATABASE_URL environment variable is not set');
  return _sql;
}

async function getBand(slug) {
  const sql = getDb();
  const rows = await sql`SELECT * FROM bands WHERE slug = ${slug} LIMIT 1`;
  return rows[0] ?? null;
}

async function insertAuditLog(sql, bandId, songId, action, songData) {
  try {
    await sql`
      INSERT INTO song_logs (band_id, song_id, action, song_data)
      VALUES (${bandId}, ${songId}, ${action}, ${songData})
    `;
  } catch (err) {
    console.error('[audit] failed to log:', err.message);
  }
}

module.exports = { getDb, getBand, insertAuditLog };
