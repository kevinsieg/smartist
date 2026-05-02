const { getDb, getBand } = require('../_db');
const { requireAuth } = require('../_auth');
const { validateSongIds, validateStr } = require('../_validate');
const { wrap } = require('../_handler');

module.exports = wrap(async function handler(req, res) {
  const { band: slug } = req.query;
  const sql = getDb();

  if (req.method === 'GET') {
    const band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const setlists = await sql`
      SELECT
        s.*,
        g.name  AS gig_name,
        g.date  AS gig_date,
        g.venue AS gig_venue,
        COUNT(ss.song_id)::int AS song_count
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id
      LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
      WHERE s.band_id = ${band.id}
      GROUP BY s.id, g.name, g.date, g.venue
      ORDER BY s.created_at DESC
    `;
    return res.json(setlists);
  }

  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const { title: rawTitle, gig_id: rawGigId, comment: rawComment, song_ids } = req.body ?? {};

    if (!Array.isArray(song_ids) || song_ids.length === 0)
      return res.status(400).json({ error: 'song_ids array is required' });
    const validIds = validateSongIds(song_ids);
    if (!validIds) return res.status(400).json({ error: 'Invalid song_ids' });

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    const comment = validateStr(rawComment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long' });
    const gigId = rawGigId != null ? Number(rawGigId) : null;
    if (gigId !== null && (!Number.isInteger(gigId) || gigId <= 0))
      return res.status(400).json({ error: 'Invalid gig_id' });

    const [setlist] = await sql`
      INSERT INTO setlists (band_id, title, gig_id, comment)
      VALUES (${band.id}, ${title}, ${gigId}, ${comment})
      RETURNING *
    `;
    const setlistIds = validIds.map(() => setlist.id);
    const positions  = validIds.map((_, i) => i);
    await sql`
      INSERT INTO setlist_songs (setlist_id, song_id, position)
      SELECT * FROM unnest(${setlistIds}::int[], ${validIds}::int[], ${positions}::int[])
    `;
    const [created] = await sql`
      SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue,
             COUNT(ss.song_id)::int AS song_count
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id
      LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
      WHERE s.id = ${setlist.id}
      GROUP BY s.id, g.name, g.date, g.venue
    `;
    return res.status(201).json(created);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
