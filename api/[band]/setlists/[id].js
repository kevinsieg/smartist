const { getDb, getBand } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { validateSongIds, validateStr } = require('../../_validate');
const { wrap } = require('../../_handler');

module.exports = wrap(async function handler(req, res) {
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug, id } = req.query;
  const setlistId = Number(id);
  if (!Number.isInteger(setlistId) || setlistId <= 0)
    return res.status(400).json({ error: 'Invalid setlist id' });

  const sql = getDb();

  // Auth-gate PUT early; GET uses public band lookup
  let band;
  if (req.method === 'PUT') {
    band = await requireAuth(req, res, slug);
    if (!band) return;
  } else {
    band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
  }

  const [setlist] = await sql`
    SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue
    FROM setlists s
    LEFT JOIN gigs g ON s.gig_id = g.id
    WHERE s.id = ${setlistId} AND s.band_id = ${band.id}
  `;
  if (!setlist) return res.status(404).json({ error: 'Setlist not found' });

  if (req.method === 'GET') {
    const songs = await sql`
      SELECT songs.*, ss.position
      FROM setlist_songs ss
      JOIN songs ON ss.song_id = songs.id
      WHERE ss.setlist_id = ${setlistId}
      ORDER BY ss.position
    `;
    return res.json({ ...setlist, songs });
  }

  // PUT — update metadata + rebuild song list
  const { title: rawTitle, comment: rawComment, gig_id: rawGigId, song_ids } = req.body ?? {};

  const validIds = validateSongIds(song_ids ?? []);
  if (!validIds) return res.status(400).json({ error: 'Invalid song_ids' });

  const title = validateStr(rawTitle, 200);
  if (title === false) return res.status(400).json({ error: 'title too long' });
  const comment = validateStr(rawComment, 2000);
  if (comment === false) return res.status(400).json({ error: 'comment too long' });
  const gigId = rawGigId != null ? Number(rawGigId) : null;
  if (gigId !== null && (!Number.isInteger(gigId) || gigId <= 0))
    return res.status(400).json({ error: 'Invalid gig_id' });

  await sql`
    UPDATE setlists
    SET title   = ${title},
        comment = ${comment},
        gig_id  = ${gigId}
    WHERE id = ${setlistId} AND band_id = ${band.id}
  `;
  await sql`DELETE FROM setlist_songs WHERE setlist_id = ${setlistId}`;

  if (validIds.length > 0) {
    const setlistIds = validIds.map(() => setlistId);
    const positions  = validIds.map((_, i) => i);
    await sql`
      INSERT INTO setlist_songs (setlist_id, song_id, position)
      SELECT * FROM unnest(${setlistIds}::int[], ${validIds}::int[], ${positions}::int[])
    `;
  }

  const [updated] = await sql`
    SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue,
           COUNT(ss.song_id)::int AS song_count
    FROM setlists s
    LEFT JOIN gigs g ON s.gig_id = g.id
    LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
    WHERE s.id = ${setlistId} AND s.band_id = ${band.id}
    GROUP BY s.id, g.name, g.date, g.venue
  `;
  return res.json(updated);
});
