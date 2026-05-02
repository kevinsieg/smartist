const { getDb } = require('../../../_db');
const { requireAuth } = require('../../../_auth');
const { wrap } = require('../../../_handler');

module.exports = wrap(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug, id } = req.query;
  const setlistId = Number(id);
  if (!Number.isInteger(setlistId) || setlistId <= 0)
    return res.status(400).json({ error: 'Invalid setlist id' });

  const band = await requireAuth(req, res, slug);
  if (!band) return;

  const sql = getDb();

  const [source] = await sql`
    SELECT * FROM setlists WHERE id = ${setlistId} AND band_id = ${band.id}
  `;
  if (!source) return res.status(404).json({ error: 'Setlist not found' });

  const [copy] = await sql`
    INSERT INTO setlists (band_id, title, gig_id, comment)
    VALUES (${band.id}, ${source.title ? source.title + ' (copy)' : null}, null, ${source.comment ?? null})
    RETURNING *
  `;

  const sourceSongs = await sql`
    SELECT song_id, position FROM setlist_songs
    WHERE setlist_id = ${setlistId}
    ORDER BY position
  `;

  if (sourceSongs.length > 0) {
    const copyIds   = sourceSongs.map(() => copy.id);
    const songIds   = sourceSongs.map(s => s.song_id);
    const positions = sourceSongs.map(s => s.position);
    await sql`
      INSERT INTO setlist_songs (setlist_id, song_id, position)
      SELECT * FROM unnest(${copyIds}::int[], ${songIds}::int[], ${positions}::int[])
    `;
  }

  const [created] = await sql`
    SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue,
           COUNT(ss.song_id)::int AS song_count
    FROM setlists s
    LEFT JOIN gigs g ON s.gig_id = g.id
    LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
    WHERE s.id = ${copy.id}
    GROUP BY s.id, g.name, g.date, g.venue
  `;

  res.status(201).json(created);
});
