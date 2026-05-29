const { getDb, getArtist, getSlug, parsePage } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr } = require('../_validate');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    const { limit, offset } = parsePage(req);
    const rows = await sql`
      SELECT g.*,
             v.name AS venue_name,
             o.name AS organizer_name,
             COUNT(*) OVER() AS total
      FROM gigs g
      LEFT JOIN venues v ON v.id = g.venue_id
      LEFT JOIN organizers o ON o.id = g.organizer_id
      WHERE g.artist_id = (SELECT id FROM artists WHERE slug = ${slug})
      ORDER BY g.date DESC NULLS LAST, g.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    if (!rows.length) {
      const [exists] = await sql`SELECT 1 FROM artists WHERE slug = ${slug} LIMIT 1`;
      if (!exists) return res.status(404).json({ error: 'Artist not found' });
    }
    const total = Number(rows[0]?.total ?? 0);
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return res.json({ rows: rows.map(({ total: _, ...r }) => r), total, limit, offset });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug);
    if (!artist) return;
    const body = req.body ?? {};
    const title = validateStr(body.title, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title is required' });
    const comment  = validateStr(body.comment, 2000);
    if (comment  === false) return res.status(400).json({ error: 'comment too long' });
    const location = validateStr(body.location, 200);
    if (location === false) return res.status(400).json({ error: 'location too long' });
    const [gig] = await sql`
      INSERT INTO gigs (artist_id, title, date, venue_id, organizer_id, type, time_start, time_end, additional_link, additional_text, comment, location)
      VALUES (
        ${artist.id}, ${title}, ${body.date ?? null},
        ${body.venue_id ?? null}, ${body.organizer_id ?? null},
        ${body.type ?? null}, ${body.time_start ?? null}, ${body.time_end ?? null},
        ${body.additional_link ?? null}, ${body.additional_text ?? null}, ${comment ?? null}, ${location ?? null}
      )
      RETURNING *
    `;
    return res.status(201).json(gig);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
