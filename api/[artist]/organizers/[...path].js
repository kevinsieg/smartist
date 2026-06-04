const { getDb, getArtist, getSlug } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { wrap } = require('../../_handler');
const { validateStr } = require('../../_validate');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  // vercel dev 52.x does not populate req.query.path for catch-alls inside dynamic dirs
  const pathParts = Array.isArray(req.query.path) && req.query.path.length
    ? req.query.path
    : req.url.split('?')[0].split('/organizers/')[1]?.split('/') ?? [];
  const id = Number(pathParts[0]);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid organizer id' });
  const sql = getDb();

  if (req.method === 'GET') {
    const artist = await getArtist(slug);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    const [org] = await sql`SELECT * FROM organizers WHERE id = ${id} AND artist_id = ${artist.id}`;
    if (!org) return res.status(404).json({ error: 'Organizer not found' });
    if (req.query.refs) {
      const gigs = await sql`
        SELECT g.id, g.title, g.date, v.name AS venue_name, v.city AS venue_city
        FROM gigs g
        LEFT JOIN venues v ON v.id = g.venue_id
        WHERE g.organizer_id = ${id} AND g.artist_id = ${artist.id} AND g.deleted = false
        ORDER BY g.date DESC NULLS LAST
      `;
      return res.json({ organizer: org, refs: { gigs } });
    }
    return res.json(org);
  }

  const artist = await requireAuth(req, res, slug, 'member');
  if (!artist) return;
  const [org] = await sql`SELECT * FROM organizers WHERE id = ${id} AND artist_id = ${artist.id}`;
  if (!org) return res.status(404).json({ error: 'Organizer not found' });

  if (req.method === 'PUT') {
    if (org.deleted) return res.status(409).json({ error: 'Organizer is deleted and cannot be modified' });
    const body    = req.body ?? {};
    const name    = validateStr(body.name, 200);
    if (name    === false) return res.status(400).json({ error: 'name too long' });
    if (!name)             return res.status(400).json({ error: 'name is required' });
    const type    = validateStr(body.type, 50);
    if (type    === false) return res.status(400).json({ error: 'type too long' });
    const city    = validateStr(body.city, 200);
    if (city    === false) return res.status(400).json({ error: 'city too long' });
    const country = validateStr(body.country, 100);
    if (country === false) return res.status(400).json({ error: 'country too long' });
    const comment = validateStr(body.comment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long' });
    const [updated] = await sql`
      UPDATE organizers SET
        name = ${name},
        type = ${type ?? org.type},
        email = ${body.email ?? org.email},
        phone = ${body.phone ?? org.phone},
        website = ${body.website ?? org.website},
        social_links = ${org.social_links}::jsonb || ${body.social_links ?? {}}::jsonb,
        city = ${city ?? org.city},
        country = ${country ?? org.country},
        last_communication = ${body.last_communication ?? org.last_communication},
        comment = ${comment ?? org.comment},
        extra = ${org.extra}::jsonb || ${body.extra ?? {}}::jsonb,
        last_updated = NOW()
      WHERE id = ${id} AND artist_id = ${artist.id}
      RETURNING *
    `;
    return res.json(updated);
  }

  if (req.method === 'DELETE') {
    const { hard, cascade } = req.body ?? {};
    if (!hard) {
      const [updated] = await sql`
        UPDATE organizers SET deleted = true, last_updated = NOW()
        WHERE id = ${id} AND artist_id = ${artist.id} RETURNING *
      `;
      return res.json(updated);
    }
    if (cascade?.includes('setlists')) {
      await sql`DELETE FROM setlists WHERE gig_id IN (SELECT id FROM gigs WHERE organizer_id = ${id} AND artist_id = ${artist.id})`;
    }
    if (cascade?.includes('gigs')) {
      await sql`DELETE FROM gigs WHERE organizer_id = ${id} AND artist_id = ${artist.id}`;
    }
    await sql`DELETE FROM organizers WHERE id = ${id} AND artist_id = ${artist.id}`;
    return res.json({ deleted: true, hard: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
