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
// query waiting for its description holds up the ones behind it on its
// connection. Fewer statements (one CTE instead of three queries) is still
// what saves the most time.
// max: 4 — with Fluid compute one instance serves several requests at once,
// and on a single connection a slow one (an export, an import, a transaction,
// which holds its connection to the end) stalled every other request on that
// instance. Connections open only when needed, so an instance serving one
// request at a time keeps one, unless it runs queries side by side
// (Promise.all), which then overlap for real. Neon's pooled endpoint takes
// thousands of client connections (health warns about a direct one).
// connect_timeout: fail a request after 10 s instead of the 30 s default when
// the database does not answer (a suspended compute that never wakes).
// fetch_types stays on: without it postgres.js cannot send JS arrays as
// parameters (`${ids}::int[]`), which every batch query here relies on.
// ssl: off only for a database on this machine (the CI integration job).
const DB = {
  connect: url => postgres(url, {
    ssl: /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) ? false : 'require',
    max: 4, prepare: false, connect_timeout: 10,
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
  await trimSongLogs(sql, artistId, songId);
}

// Each entry is a full snapshot of the song, so the history would grow with
// every edit forever. A song keeps its newest SONG_LOG_KEEP entries
// (api/_constants.js): the last one is what restore reads, and the list shows
// 20 at most. Only the songs a write touched are trimmed, on every write:
// song_logs_song_id_idx finds their rows, so the cost does not grow with the
// band. The song edits do it inside their own statement (a `trimmed` CTE);
// this is for the writes that log separately (media). Takes one song id or a
// list. A failed trim never fails the request.
async function trimSongLogs(sql, artistId, songIds) {
  const ids = (Array.isArray(songIds) ? songIds : [songIds]).map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return;
  try {
    await sql`
      DELETE FROM song_logs WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY song_id ORDER BY changed_at DESC, id DESC) AS n
          FROM song_logs
          WHERE song_id = ANY(${ids}::int[]) AND artist_id = ${artistId}
        ) ranked
        WHERE n > ${SONG_LOG_KEEP}
      )
    `;
  } catch (err) {
    console.error('[audit] failed to trim:', err.message);
  }
}

// Deleted songs stay restorable from the change log, but they never left the
// database: row, lyrics, arrangements and history piled up for good, outside
// the plan's song count. A song deleted more than PURGE_AFTER_DAYS ago goes
// for good, with its history, unless it still has an uploaded file (those
// count towards the band's storage, and removing them is the media endpoints'
// job). A saved setlist that still lists it keeps the row (setlist history
// shows its title), but its lyrics, arrangements and history go: otherwise
// "create, save as a setlist, delete" would store without bound. About one
// deletion in PURGE_EVERY sweeps the band; a failed sweep never fails the
// request.
const PURGE_AFTER_DAYS = 90;
const PURGE_EVERY = 10;
async function purgeDeletedSongs(sql, artistId, { always = false } = {}) {
  if (!always && Math.random() >= 1 / PURGE_EVERY) return;
  try {
    await sql`
      WITH old AS (
        SELECT s.id, EXISTS (SELECT 1 FROM setlist_songs ss WHERE ss.song_id = s.id) AS listed
        FROM songs s
        WHERE s.artist_id = ${artistId} AND s.deleted
          AND NOT (s.extra ?| ARRAY['listenUrl', 'sheetUrl', 'playbackUrl'])
          AND (SELECT max(l.changed_at) FROM song_logs l WHERE l.song_id = s.id)
              < now() - make_interval(days => ${PURGE_AFTER_DAYS})
      ), logs AS (
        DELETE FROM song_logs WHERE song_id IN (SELECT id FROM old)
      ), lyrics AS (
        DELETE FROM song_lyrics WHERE song_id IN (SELECT id FROM old WHERE listed) AND artist_id = ${artistId}
      ), charts AS (
        DELETE FROM song_arrangements WHERE song_id IN (SELECT id FROM old WHERE listed) AND artist_id = ${artistId}
      )
      DELETE FROM songs WHERE id IN (SELECT id FROM old WHERE NOT listed) AND artist_id = ${artistId}
    `;
  } catch (err) {
    console.error('[songs] failed to purge deleted songs:', err.message);
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

module.exports = {
  getDb, getArtist, insertAuditLog, trimSongLogs, SONG_LOG_KEEP, purgeDeletedSongs, PURGE_AFTER_DAYS,
  getSlug, parsePage,
};
