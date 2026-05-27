const { getDb, getArtist, getSlug, parsePage } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr } = require('../_validate');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    const artist = await getArtist(slug);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    if (req.query.slim) {
      // Excludes deleted — suitable for dropdowns. Full list intentionally includes deleted for the CRM view.
      const venues = await sql`
        SELECT id, name, city FROM venues
        WHERE artist_id = ${artist.id} AND deleted = false
        ORDER BY name ASC
      `;
      return res.json(venues);
    }

    const { limit, offset } = parsePage(req);
    const q        = (req.query.q        || '').trim();
    const status   = (req.query.status   || '').trim() || null;
    const category = (req.query.category || '').trim() || null;
    const pattern  = q ? `%${q}%` : null;
    const rows = await sql`
      SELECT *, COUNT(*) OVER() AS total
      FROM venues
      WHERE artist_id = ${artist.id}
        AND (${pattern}::text IS NULL
          OR name     ILIKE ${pattern}
          OR city     ILIKE ${pattern}
          OR country  ILIKE ${pattern}
          OR postcode ILIKE ${pattern})
        AND (${status}::text   IS NULL OR status   ILIKE ${status})
        AND (${category}::text IS NULL OR category ILIKE ${category})
      ORDER BY category = 'placeholder' DESC, deleted ASC, name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const total = Number(rows[0]?.total ?? 0);
    return res.json({ rows: rows.map(({ total: _, ...r }) => r), total, limit, offset });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug);
    if (!artist) return;
    const b        = req.body ?? {};
    const name     = validateStr(b.name, 200);
    if (name === false) return res.status(400).json({ error: 'name too long' });
    if (!name)          return res.status(400).json({ error: 'name is required' });
    const city     = validateStr(b.city, 200);
    if (city     === false) return res.status(400).json({ error: 'city too long' });
    const country  = validateStr(b.country, 100);
    if (country  === false) return res.status(400).json({ error: 'country too long' });
    const category = validateStr(b.category, 100);
    if (category === false) return res.status(400).json({ error: 'category too long' });
    const status   = validateStr(b.status, 50);
    if (status   === false) return res.status(400).json({ error: 'status too long' });
    const comment  = validateStr(b.comment, 2000);
    if (comment  === false) return res.status(400).json({ error: 'comment too long' });
    const [venue] = await sql`
      INSERT INTO venues (artist_id, name, city, country, category, status, comment)
      VALUES (${artist.id}, ${name}, ${city}, ${country}, ${category}, ${status}, ${comment})
      RETURNING *
    `;
    return res.status(201).json(venue);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
