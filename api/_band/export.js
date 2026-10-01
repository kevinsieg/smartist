const { getDb, getSlug } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { toCsv, buildZip } = require('../_export');

// GET /api/:artist/export — every table of the band as a ZIP of CSVs.
module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const band = await requireAuth(req, res, slug, 'member');
  if (!band) return;
  const sql = getDb();
  const [songs, song_arrangements, gigs, setlists, setlist_songs, venues, organizers, gema_works, gema_rightholders, song_logs, account, members] = await Promise.all([
    // Lyrics live in their own table; in the CSV they stay a column of songs.
    sql`
      SELECT s.*, l.lyrics FROM songs s
      LEFT JOIN song_lyrics l ON l.song_id = s.id
      WHERE s.artist_id = ${band.id} ORDER BY s.id
    `,
    // Arrangements are real, hand-entered data and this export is offered on
    // /profile as the last chance before permanent deletion — anything the
    // deletion destroys has to be in here.
    sql`SELECT * FROM song_arrangements WHERE artist_id = ${band.id} ORDER BY song_id, id`,
    sql`SELECT * FROM gigs WHERE artist_id = ${band.id} ORDER BY id`,
    sql`SELECT * FROM setlists WHERE artist_id = ${band.id} ORDER BY id`,
    sql`
      SELECT ss.* FROM setlist_songs ss
      JOIN setlists s ON ss.setlist_id = s.id
      WHERE s.artist_id = ${band.id}
      ORDER BY ss.setlist_id, ss.position
    `,
    sql`SELECT * FROM venues WHERE artist_id = ${band.id} ORDER BY id`,
    sql`SELECT * FROM organizers WHERE artist_id = ${band.id} ORDER BY id`,
    sql`SELECT * FROM gema_works WHERE artist_id = ${band.id} ORDER BY id`,
    sql`
      SELECT r.* FROM gema_rightholders r
      JOIN gema_works gw ON gw.id = r.gema_work_id
      WHERE gw.artist_id = ${band.id}
      ORDER BY r.gema_work_id, r.id
    `,
    sql`SELECT * FROM song_logs WHERE artist_id = ${band.id} ORDER BY id`,
    // The person's own account (Art. 15/20 GDPR): every workspace their address
    // belongs to, never hashes or tokens. The demo session has no user row.
    req.user.id === null ? [] : sql`
      SELECT a.slug AS workspace, a.name AS workspace_name, u.email, u.role,
             u.pending_email, u.created_at, (u.password_hash IS NOT NULL) AS has_password
      FROM users me
      JOIN users u   ON u.email = me.email
      JOIN artists a ON a.id = u.artist_id
      WHERE me.id = ${req.user.id}
      ORDER BY a.name
    `,
    // Who else is in the band: admins only, as on the members page.
    req.user.role === 'admin'
      ? sql`SELECT email, role, created_at FROM users WHERE artist_id = ${band.id} ORDER BY id`
      : [],
  ]);
  const date = new Date().toISOString().slice(0, 10);
  const safeSlug = String(slug ?? 'artist').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'artist';
  // config carries the band's own settings (displayFields, platforms, logo) —
  // destroyed with the artists row, and not reconstructible from any other table.
  const tables = { artist: [{ slug: band.slug, name: band.name, config: band.config }], account, members, songs, song_arrangements, gigs, setlists, setlist_songs, venues, organizers, gema_works, gema_rightholders, song_logs };
  const files = {};
  for (const [name, all] of Object.entries(tables)) {
    // The CSVs drop the `deleted` column, so soft-deleted rows would read as live.
    const rows = all.filter(r => r.deleted !== true);
    if (rows.length) files[`${name}.csv`] = toCsv(rows);
  }
  res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}-export-${date}.zip"`);
  res.setHeader('Content-Type', 'application/zip');
  return res.send(buildZip(files));
});
