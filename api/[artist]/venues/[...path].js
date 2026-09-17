const { getDb, getSlug } = require('../../_db');
const { requireAuth, getAccess, isPrivate } = require('../../_auth');
const { VENUE_PUBLIC_STATUSES } = require('../../_constants');
const { wrap } = require('../../_handler');
const { validateStr, validateNum } = require('../../_validate');
const { requireFeature } = require('../../_plans');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  // vercel dev 52.x does not populate req.query.path for catch-alls inside dynamic dirs
  const pathParts = Array.isArray(req.query.path) && req.query.path.length
    ? req.query.path
    : req.url.split('?')[0].split('/venues/')[1]?.split('/') ?? [];
  const id = Number(pathParts[0]);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid venue id' });
  const sql = getDb();

  if (req.method === 'GET') {
    const { artist, user } = await getAccess(req, slug);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    if (!user && isPrivate(artist))
      return res.status(401).json({ error: 'This workspace is private' });
    if (!requireFeature(res, artist, 'venues')) return;
    let [venue] = await sql`SELECT * FROM venues WHERE id = ${id} AND artist_id = ${artist.id}`;
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    if (!user) {
      // Public visitors only see non-deleted venues with a public status,
      // and never the private CRM comment.
      const publicStatus = VENUE_PUBLIC_STATUSES.includes((venue.status || '').toLowerCase());
      if (venue.deleted || !publicStatus) return res.status(404).json({ error: 'Venue not found' });
      const { comment: _, ...rest } = venue;
      venue = rest;
    }
    if (req.query.refs) {
      const gigs = await sql`
        SELECT id, title, date FROM gigs
        WHERE venue_id = ${id} AND artist_id = ${artist.id} AND deleted = false
        ORDER BY date DESC NULLS LAST
      `;
      return res.json({ venue, refs: { gigs } });
    }
    return res.json(venue);
  }

  const artist = await requireAuth(req, res, slug, 'member');
  if (!artist) return;
  if (!requireFeature(res, artist, 'venues')) return;
  const [venue] = await sql`SELECT * FROM venues WHERE id = ${id} AND artist_id = ${artist.id}`;
  if (!venue) return res.status(404).json({ error: 'Venue not found' });

  if (req.method === 'PUT') {
    if (venue.deleted) return res.status(409).json({ error: 'Venue is deleted and cannot be modified' });
    const body     = req.body ?? {};
    const name     = validateStr(body.name, 200);
    if (name     === false) return res.status(400).json({ error: 'name too long' });
    if (!name)              return res.status(400).json({ error: 'name is required' });
    const street_number = validateStr(body.street_number, 20);
    if (street_number === false) return res.status(400).json({ error: 'street_number too long' });
    const street   = validateStr(body.street, 300);
    if (street   === false) return res.status(400).json({ error: 'street too long' });
    const city     = validateStr(body.city, 200);
    if (city     === false) return res.status(400).json({ error: 'city too long' });
    const country  = validateStr(body.country, 100);
    if (country  === false) return res.status(400).json({ error: 'country too long' });
    const category = validateStr(body.category, 100);
    if (category === false) return res.status(400).json({ error: 'category too long' });
    const status   = validateStr(body.status, 50);
    if (status   === false) return res.status(400).json({ error: 'status too long' });
    const comment  = validateStr(body.comment, 2000);
    if (comment  === false) return res.status(400).json({ error: 'comment too long' });
    const lat = validateNum(body.lat);
    if (lat === false) return res.status(400).json({ error: 'lat must be a number' });
    const lng = validateNum(body.lng);
    if (lng === false) return res.status(400).json({ error: 'lng must be a number' });
    const [updated] = await sql`
      UPDATE venues SET
        name = ${name},
        street_number = ${street_number ?? venue.street_number},
        street = ${street ?? venue.street},
        alive = ${body.alive ?? venue.alive},
        activated = ${body.activated ?? venue.activated},
        declined = ${body.declined ?? venue.declined},
        status = ${status ?? venue.status},
        category = ${category ?? venue.category},
        postcode = ${body.postcode ?? venue.postcode},
        city = ${city ?? venue.city},
        state = ${body.state ?? venue.state},
        country = ${country ?? venue.country},
        generic_email = ${body.generic_email ?? venue.generic_email},
        website = ${body.website ?? venue.website},
        social_links = ${venue.social_links}::jsonb || ${body.social_links ?? {}}::jsonb,
        last_communication = ${body.last_communication ?? venue.last_communication},
        booking_channel = ${body.booking_channel ?? venue.booking_channel},
        number_of_cold_contacts = ${body.number_of_cold_contacts ?? venue.number_of_cold_contacts},
        turnus = ${body.turnus ?? venue.turnus},
        remuneration = ${body.remuneration ?? venue.remuneration},
        overnight = ${body.overnight ?? venue.overnight},
        season = ${body.season ?? venue.season},
        preferred_period = ${body.preferred_period ?? venue.preferred_period},
        comment = ${comment ?? venue.comment},
        deadline = ${body.deadline ?? venue.deadline},
        main_genre = ${body.main_genre ?? venue.main_genre},
        size = ${body.size ?? venue.size},
        language = ${body.language ?? venue.language},
        lat = ${'lat' in body ? lat : venue.lat},
        lng = ${'lng' in body ? lng : venue.lng},
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
        UPDATE venues SET deleted = true, last_updated = NOW()
        WHERE id = ${id} AND artist_id = ${artist.id} RETURNING *
      `;
      return res.json(updated);
    }
    if (cascade?.includes('setlists')) {
      await sql`DELETE FROM setlists WHERE gig_id IN (SELECT id FROM gigs WHERE venue_id = ${id} AND artist_id = ${artist.id})`;
    }
    if (cascade?.includes('gigs')) {
      await sql`DELETE FROM gigs WHERE venue_id = ${id} AND artist_id = ${artist.id}`;
    }
    try {
      await sql`DELETE FROM venues WHERE id = ${id} AND artist_id = ${artist.id}`;
    } catch (e) {
      if (e.code === '23503') {
        return res.status(409).json({ error: 'This venue is still linked to one or more gigs. Remove the venue from those gigs first, then delete.' });
      }
      throw e;
    }
    return res.json({ deleted: true, hard: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
