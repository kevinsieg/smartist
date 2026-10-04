const postgres = require('postgres');
const { SONG_LOG_KEEP } = require('./_constants');

// ── Database provider ─────────────────────────────────────────────────────────
// Current: postgres.js (standard PostgreSQL wire protocol, supports transactions)
// postgres.js connects over port 5432. Neon supports both the HTTP endpoint
// (@neondatabase/serverless) and the standard wire protocol — the DATABASE_URL
// pooler connection string works with both.
//
// postgres.js was chosen over @neondatabase/serverless because:
//   - sql.begin() / transactions are required for multi-step writes
//   - the tagged-template interface is identical — no query changes needed
//
// To switch drivers, replace the connect line only:
//   neon HTTP (no transactions; npm install it first): connect: url => require('@neondatabase/serverless').neon(url)
//   pg Pool:                     connect: url => { ... }  (see DATABASE.md)
// prepare: false — Neon's pooler keeps named prepared statements on its server
// connections, so after a column changes type every `SELECT *` on that table
// failed with "cached plan must not change result type" until the pool recycled.
// Cost of that: postgres.js sends every query with parameters as Parse/Describe,
// waits for the parameter types, then Bind/Execute — two round-trips — and a
// query waiting for its description holds up the ones behind it. So on this
// single connection (max: 1) queries started together with Promise.all still
// run one after the other. Fewer statements (one CTE instead of three
// queries) is what saves time here, not more parallelism.
// connect_timeout: fail a request after 10 s instead of the 30 s default when
// the database does not answer (a suspended compute that never wakes).
// fetch_types stays on: without it postgres.js cannot send JS arrays as
// parameters (`${ids}::int[]`), which every batch query here relies on.
// ssl: off only for a database on this machine (the CI integration job).
const DB = {
  connect: url => postgres(url, {
    ssl: /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) ? false : 'require',
    max: 1, prepare: false, connect_timeout: 10,
  }),
};
// ─────────────────────────────────────────────────────────────────────────────

let _sql;
function getDb() {
  if (!_sql && process.env.DATABASE_URL) _sql = DB.connect(process.env.DATABASE_URL);
  if (!_sql) throw new Error('DATABASE_URL environment variable is not set');
  return _sql;
}

async function getArtist(slug) {
  const sql = getDb();
  const rows = await sql`SELECT * FROM artists WHERE slug = ${slug} LIMIT 1`;
  return rows[0] ?? null;
}

async function insertAuditLog(sql, artistId, songId, action, songData) {
  try {
    await sql`
      INSERT INTO song_logs (artist_id, song_id, action, song_data)
      VALUES (${artistId}, ${songId}, ${action}, ${songData})
    `;
  } catch (err) {
    console.error('[audit] failed to log:', err.message);
  }
  await trimSongLogs(sql, artistId, [songId]);
}

// Each entry is a full snapshot of the song, so the history would grow with
// every edit forever. A song keeps its newest SONG_LOG_KEEP entries
// (api/_constants.js). Only the songs a write touched are trimmed
// (song_logs_song_id_idx), so it is cheap enough to run on every write. The
// song edits do it inside their own statement (a `trimmed` CTE); this is for
// the writes that log separately (media).
// Entries of songs that no longer exist (song_id NULL) are left alone. A
// failed trim never fails the request. Takes one song id or a list.
async function trimSongLogs(sql, artistId, songIds) {
  const ids = [].concat(songIds ?? []).map(Number).filter(Number.isInteger);
  if (!ids.length) return;
  try {
    await sql`
      DELETE FROM song_logs WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY song_id ORDER BY changed_at DESC, id DESC) AS n
          FROM song_logs
          WHERE artist_id = ${artistId} AND song_id = ANY(${ids}::int[])
        ) ranked
        WHERE n > ${SONG_LOG_KEEP}
      )
    `;
  } catch (err) {
    console.error('[audit] failed to trim:', err.message);
  }
}

// The band's slug, set by the router from /api/:artist/….
function getSlug(req) {
  return req.query.artist;
}

function parsePage(req) {
  const limit  = Math.min(Math.max(parseInt(req.query.limit)  || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  return { limit, offset };
}

module.exports = { getDb, getArtist, insertAuditLog, trimSongLogs, SONG_LOG_KEEP, getSlug, parsePage };
