const { getDb, insertAuditLog } = require('../../../_db');
const { requireAuth } = require('../../../_auth');
const { wrap } = require('../../../_handler');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug, id } = req.query;
  const songId = Number(id);
  if (!Number.isInteger(songId) || songId <= 0)
    return res.status(400).json({ error: 'Invalid song id' });

  const band = await requireAuth(req, res, slug);
  if (!band) return;

  const sql = getDb();

  const [log] = await sql`
    SELECT * FROM song_logs
    WHERE song_id = ${songId} AND band_id = ${band.id} AND action = 'delete'
    ORDER BY changed_at DESC
    LIMIT 1
  `;
  if (!log) return res.status(404).json({ error: 'No delete record found for this song' });

  let song;
  const [existing] = await sql`
    SELECT id FROM songs WHERE id = ${songId} AND band_id = ${band.id} AND deleted = true
  `;
  if (existing) {
    [song] = await sql`
      UPDATE songs SET deleted = false
      WHERE id = ${songId} AND band_id = ${band.id}
      RETURNING *
    `;
  } else {
    // Legacy hard-delete fallback: re-insert from snapshot
    const d = log.song_data;
    [song] = await sql`
      INSERT INTO songs (band_id, title, active, key, genre, tempo, length_min,
                         interpret, reference_interpret, comment, extra)
      VALUES (${band.id}, ${d.title}, ${d.active ?? true}, ${d.key ?? null},
              ${d.genre ?? null}, ${d.tempo ?? null}, ${d.length_min ?? null},
              ${d.interpret ?? null}, ${d.reference_interpret ?? null},
              ${d.comment ?? null}, ${d.extra ?? {}})
      RETURNING *
    `;
  }

  await insertAuditLog(sql, band.id, song.id, 'create', song);

  res.status(201).json(song);
});
