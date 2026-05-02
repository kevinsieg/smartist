const { getDb, getBand } = require('../../../_db');
const { wrap } = require('../../../_handler');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug, id } = req.query;
  const songId = Number(id);
  if (!Number.isInteger(songId) || songId <= 0)
    return res.status(400).json({ error: 'Invalid song id' });

  const band = await getBand(slug);
  if (!band) return res.status(404).json({ error: 'Band not found' });

  const sql = getDb();
  const setlists = await sql`
    SELECT sl.id, sl.title, sl.comment, sl.created_at,
           g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue
    FROM setlists sl
    JOIN setlist_songs ss ON ss.setlist_id = sl.id
    LEFT JOIN gigs g ON sl.gig_id = g.id
    WHERE ss.song_id = ${songId} AND sl.band_id = ${band.id}
    ORDER BY sl.created_at DESC
  `;

  res.json(setlists);
});
