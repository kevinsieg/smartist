const { getDb, getBand } = require('../../../_db');
const { wrap } = require('../../../_handler');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { band: slug, id } = req.query;
  const songId = parseInt(id, 10);
  if (!Number.isInteger(songId) || songId <= 0) return res.status(400).json({ error: 'Invalid song id' });

  const sql = getDb();
  const band = await getBand(slug);
  if (!band) return res.status(404).json({ error: 'Band not found' });

  const works = await sql`
    SELECT * FROM gema_works
    WHERE band_id = ${band.id} AND song_id = ${songId}
    ORDER BY gema_work_number
  `;

  if (!works.length) return res.json({ works: [], rightholders: [] });

  const workIds = works.map(w => w.id);
  const rightholders = await sql`
    SELECT r.*, g.gema_work_number
    FROM gema_rightholders r
    JOIN gema_works g ON g.id = r.gema_work_id
    WHERE r.gema_work_id = ANY(${workIds})
    ORDER BY g.gema_work_number, r.role, r.role_order NULLS LAST, r.name
  `;

  res.json({ works, rightholders });
});
