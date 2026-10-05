const { getDb, getSlug, parsePage } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { parseFields, likePattern } = require('../_validate');
const { ORGANIZER_FIELDS } = require('../_domain/records');
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
    const pattern = likePattern(q);
    const favourite = req.query.favourite === '1';
    const rows = await sql`
      SELECT *, COUNT(*) OVER() AS total
      FROM organizers
      WHERE artist_id = ${authArtist.id}
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
    const total = Number(rows[0]?.total ?? 0);
    return res.json({ rows: rows.map(({ total: _, ...r }) => r), total, limit, offset });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug, 'member');
    if (!artist) return;
    if (!requireFeature(res, artist, 'organizers')) return;
    const { value, error } = parseFields(req.body, ORGANIZER_FIELDS);
    if (error) return res.status(400).json({ error });
    const [org] = await sql`INSERT INTO organizers ${sql({ ...value, artist_id: artist.id })} RETURNING *`;
    return res.status(201).json(org);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
