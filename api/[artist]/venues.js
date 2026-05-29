const { getDb, getArtist, getSlug, parsePage } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr, validateNum } = require('../_validate');
const { VENUE_PUBLIC_STATUSES } = require('../_constants');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    if (req.query.slim) {
      const venues = await sql`
        SELECT id, name, city FROM venues
        WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug}) AND deleted = false
        ORDER BY name ASC
      `;
      return res.json(venues);
    }

    if (req.query.all) {
      const statusFilter = req.query.status ? req.query.status.toLowerCase() : null;
      const venues = await sql`
        SELECT * FROM venues
        WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug}) AND deleted = false
          AND (${statusFilter}::text IS NULL OR LOWER(status) = ${statusFilter})
        ORDER BY name ASC
      `;
      return res.json(venues);
    }

    const { limit, offset } = parsePage(req);
    const q        = (req.query.q        || '').trim();
    const status   = (req.query.status   || '').trim() || null;
    const category = (req.query.category || '').trim() || null;
    const country  = (req.query.country  || '').trim() || null;
    const has_gigs = req.query.has_gigs === '1';
    const pattern  = q ? `%${q}%` : null;
    const viewOnly = !req.headers.authorization;
    let rows;
    if (has_gigs) {
      rows = await sql`
        SELECT *, COUNT(*) OVER() AS total
        FROM venues
        WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug})
          AND (${pattern}::text IS NULL
            OR name     ILIKE ${pattern}
            OR city     ILIKE ${pattern}
            OR country  ILIKE ${pattern}
            OR postcode ILIKE ${pattern})
          AND (${status}::text   IS NULL OR status   ILIKE ${status})
          AND (${category}::text IS NULL OR category ILIKE ${category})
          AND (${country}::text  IS NULL OR country  ILIKE ${country})
          AND (NOT ${viewOnly} OR (deleted = false AND LOWER(status) = ANY(${VENUE_PUBLIC_STATUSES})))
          AND EXISTS (
            SELECT 1 FROM gigs g
            WHERE g.venue_id = venues.id AND g.deleted = false
          )
        ORDER BY category = 'placeholder' DESC, deleted ASC, name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT *, COUNT(*) OVER() AS total
        FROM venues
        WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug})
          AND (${pattern}::text IS NULL
            OR name     ILIKE ${pattern}
            OR city     ILIKE ${pattern}
            OR country  ILIKE ${pattern}
            OR postcode ILIKE ${pattern})
          AND (${status}::text   IS NULL OR status   ILIKE ${status})
          AND (${category}::text IS NULL OR category ILIKE ${category})
          AND (${country}::text  IS NULL OR country  ILIKE ${country})
          AND (NOT ${viewOnly} OR (deleted = false AND LOWER(status) = ANY(${VENUE_PUBLIC_STATUSES})))
        ORDER BY category = 'placeholder' DESC, deleted ASC, name ASC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }
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
    const b        = req.body ?? {};
    const name     = validateStr(b.name, 200);
    if (name === false) return res.status(400).json({ error: 'name too long' });
    if (!name)          return res.status(400).json({ error: 'name is required' });
    const street_number = validateStr(b.street_number, 20);
    if (street_number === false) return res.status(400).json({ error: 'street_number too long' });
    const street   = validateStr(b.street, 300);
    if (street   === false) return res.status(400).json({ error: 'street too long' });
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
    const lat = validateNum(b.lat);
    if (lat === false) return res.status(400).json({ error: 'lat must be a number' });
    const lng = validateNum(b.lng);
    if (lng === false) return res.status(400).json({ error: 'lng must be a number' });
    const [venue] = await sql`
      INSERT INTO venues (artist_id, name, street_number, street, city, country, category, status, comment, lat, lng)
      VALUES (${artist.id}, ${name}, ${street_number}, ${street}, ${city}, ${country}, ${category}, ${status}, ${comment}, ${lat}, ${lng})
      RETURNING *
    `;
    return res.status(201).json(venue);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
