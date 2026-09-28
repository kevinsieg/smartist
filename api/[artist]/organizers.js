const { getDb, getArtist, getSlug, parsePage } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr } = require('../_validate');
const { requireFeature } = require('../_plans');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    // Organizer records are private CRM data (contact emails, notes) — no
    // public view mode for this resource.
    const authArtist = await requireAuth(req, res, slug);
    if (!authArtist) return;
    if (!requireFeature(res, authArtist, 'organizers')) return;
    if (req.query.slim) {
      const orgs = await sql`
        SELECT id, name, city FROM organizers
        WHERE artist_id = ${authArtist.id} AND deleted = false
        ORDER BY name ASC
      `;
      return res.json(orgs);
    }

    const { limit, offset } = parsePage(req);
    const q = (req.query.q || '').trim();
    const pattern = q ? `%${q}%` : null;
    const favourite = req.query.favourite === '1';
    const rows = await sql`
      SELECT *, COUNT(*) OVER() AS total
      FROM organizers
      WHERE artist_id = (SELECT id FROM artists WHERE slug = ${slug})
        AND (${pattern}::text IS NULL
          OR name    ILIKE ${pattern}
          OR type    ILIKE ${pattern}
          OR city    ILIKE ${pattern}
          OR country ILIKE ${pattern}
          OR email   ILIKE ${pattern})
        AND (NOT ${favourite} OR heart)
      ORDER BY deleted ASC, heart DESC, name ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    if (!rows.length) {
      const [exists] = await sql`SELECT 1 FROM artists WHERE slug = ${slug} LIMIT 1`;
      if (!exists) return res.status(404).json({ error: 'Artist not found' });
    }
    const total = Number(rows[0]?.total ?? 0);
    return res.json({ rows: rows.map(({ total: _, ...r }) => r), total, limit, offset });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug, 'member');
    if (!artist) return;
    if (!requireFeature(res, artist, 'organizers')) return;
    const b       = req.body ?? {};
    const name    = validateStr(b.name, 200);
    if (name    === false) return res.status(400).json({ error: 'name too long' });
    if (!name)             return res.status(400).json({ error: 'name is required' });
    const type    = validateStr(b.type, 50);
    if (type    === false) return res.status(400).json({ error: 'type too long' });
    const city    = validateStr(b.city, 200);
    if (city    === false) return res.status(400).json({ error: 'city too long' });
    const country = validateStr(b.country, 100);
    if (country === false) return res.status(400).json({ error: 'country too long' });
    const comment = validateStr(b.comment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long' });
    const [org] = await sql`
      INSERT INTO organizers (artist_id, name, type, email, city, country, comment)
      VALUES (${artist.id}, ${name}, ${type}, ${b.email ?? null}, ${city}, ${country}, ${comment})
      RETURNING *
    `;
    return res.status(201).json(org);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
