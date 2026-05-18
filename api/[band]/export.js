const { getDb } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const { band: slug } = req.query;
  const band = await requireAuth(req, res, slug);
  if (!band) return;
  const sql = getDb();

  const [songs, gigs, setlists, setlist_songs] = await Promise.all([
    sql`SELECT * FROM songs WHERE band_id = ${band.id} ORDER BY id`,
    sql`SELECT * FROM gigs WHERE band_id = ${band.id} ORDER BY id`,
    sql`SELECT * FROM setlists WHERE band_id = ${band.id} ORDER BY id`,
    sql`
      SELECT ss.* FROM setlist_songs ss
      JOIN setlists s ON ss.setlist_id = s.id
      JOIN songs ON ss.song_id = songs.id AND songs.band_id = s.band_id
      WHERE s.band_id = ${band.id}
      ORDER BY ss.setlist_id, ss.position
    `
  ]);

  const date = new Date().toISOString().slice(0, 10);
  const safeSlug = String(slug ?? 'band')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'band';
  res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}-export-${date}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ band: { slug: band.slug, name: band.name }, songs, gigs, setlists, setlist_songs });
});
