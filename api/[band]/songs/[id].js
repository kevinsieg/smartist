const { getDb, insertAuditLog } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { wrap } = require('../../_handler');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug, id } = req.query;
  const songId = Number(id);
  if (!Number.isInteger(songId) || songId <= 0)
    return res.status(400).json({ error: 'Invalid song id' });

  const band = await requireAuth(req, res, slug);
  if (!band) return;

  const sql = getDb();

  const [song] = await sql`
    UPDATE songs SET deleted = true
    WHERE id = ${songId} AND band_id = ${band.id} AND deleted = false
    RETURNING *
  `;
  if (!song) return res.status(404).json({ error: 'Song not found' });

  await insertAuditLog(sql, band.id, songId, 'delete', song);

  res.status(204).end();
});
