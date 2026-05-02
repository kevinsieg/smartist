const { getBand, getDb } = require('./_db');
const { wrap } = require('./_handler');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const slug = process.env.BAND_SLUG;
  if (!slug) return res.status(500).json({ error: 'BAND_SLUG not configured' });
  const band = await getBand(slug);
  if (!band) return res.status(404).json({ error: 'Band not found in database' });

  const sql = getDb();
  const songs = await sql`
    SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language
    FROM songs s
    LEFT JOIN LATERAL (
      SELECT iswc, gema_work_number, language
      FROM gema_works
      WHERE song_id = s.id
      ORDER BY gema_work_number
      LIMIT 1
    ) g ON true
    WHERE s.band_id = ${band.id} AND s.deleted = false
    ORDER BY s.title
  `;

  res.json({ slug: band.slug, name: band.name, config: band.config, songs });
});
