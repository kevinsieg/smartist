const { getDb, getSlug, parsePage } = require('../_db');
const { requireAuth, getAccess, isPrivate } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr, validateNum } = require('../_validate');
const { VENUE_PUBLIC_STATUSES } = require('../_constants');
const { requireFeature } = require('../_plans');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    const { artist, user } = await getAccess(req, slug);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    const viewOnly = !user;
    if (viewOnly && isPrivate(artist))
      return res.status(401).json({ error: 'This workspace is private' });
    if (!requireFeature(res, artist, 'venues')) return;

    if (req.query.slim) {
      const venues = await sql`
        SELECT id, name, city FROM venues
        WHERE artist_id = ${artist.id} AND deleted = false
          AND (NOT ${viewOnly} OR LOWER(status) = ANY(${VENUE_PUBLIC_STATUSES}))
        ORDER BY name ASC
      `;
      return res.json(venues);
    }

    if (req.query.all) {
      const statusFilter = req.query.status ? req.query.status.toLowerCase() : null;
      // Map payload: no comment (private CRM notes) and no audit columns.
      const venues = await sql`
        SELECT id, name, street_number, street, city, postcode, country,
               category, status, size, lat, lng
        FROM venues
        WHERE artist_id = ${artist.id} AND deleted = false
          AND (${statusFilter}::text IS NULL OR LOWER(status) = ${statusFilter})
          AND (NOT ${viewOnly} OR LOWER(status) = ANY(${VENUE_PUBLIC_STATUSES}))
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
    let rows;
    if (has_gigs) {
      rows = await sql`
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
        WHERE artist_id = ${artist.id}
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
    const total = Number(rows[0]?.total ?? 0);
    // Only the public (view-mode) response may be CDN-cached — authed responses
    // contain non-public venues and must not be served from a shared cache.
    if (viewOnly) res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return res.json({ rows: rows.map(({ total: _, ...r }) => r), total, limit, offset });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug, 'member');
    if (!artist) return;
    if (!requireFeature(res, artist, 'venues')) return;
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
    const phone = validateStr(b.phone, 100);
    if (phone === false) return res.status(400).json({ error: 'phone too long' });
    const contact_name = validateStr(b.contact_name, 200);
    if (contact_name === false) return res.status(400).json({ error: 'contact_name too long' });
    const postcode = validateStr(b.postcode, 20);
    if (postcode === false) return res.status(400).json({ error: 'postcode too long' });
    const generic_email = validateStr(b.generic_email, 254);
    if (generic_email === false) return res.status(400).json({ error: 'generic_email too long' });
    const website = validateStr(b.website, 500);
    if (website === false) return res.status(400).json({ error: 'website too long' });
    const lat = validateNum(b.lat);
    if (lat === false) return res.status(400).json({ error: 'lat must be a number' });
    const lng = validateNum(b.lng);
    if (lng === false) return res.status(400).json({ error: 'lng must be a number' });
    const [venue] = await sql`
      INSERT INTO venues (artist_id, name, street_number, street, postcode, city, country, category, status, comment,
                          generic_email, website, lat, lng, phone, contact_name)
      VALUES (${artist.id}, ${name}, ${street_number}, ${street}, ${postcode}, ${city}, ${country}, ${category}, ${status}, ${comment},
              ${generic_email}, ${website}, ${lat}, ${lng}, ${phone}, ${contact_name})
      RETURNING *
    `;
    return res.status(201).json(venue);
  }

  // Bulk edit of the CRM fields — one request for all rows changed in the table.
  // Only the fields present per row are written; everything else keeps its stored value.
  if (req.method === 'PATCH') {
    const artist = await requireAuth(req, res, slug, 'member');
    if (!artist) return;
    if (!requireFeature(res, artist, 'venues')) return;
    const updates = req.body;
    if (!Array.isArray(updates) || updates.length === 0)
      return res.status(400).json({ error: 'Array of updates required' });
    if (updates.length > 200)
      return res.status(400).json({ error: 'Too many updates (max 200)' });

    const ids = updates.map(u => Number(u.id)).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.json({ ok: true, count: 0 });
    const rows = await sql`
      SELECT * FROM venues WHERE artist_id = ${artist.id} AND deleted = false AND id = ANY(${ids}::int[])`;
    const byId = new Map(rows.map(r => [r.id, r]));

    // field → max length; dates are validated separately.
    const TEXT_FIELDS = { status: 50, category: 100, booking_channel: 50, remuneration: 100,
                          season: 50, preferred_period: 100, comment: 2000 };
    const DATE_FIELDS = ['last_communication', 'deadline'];
    const isDate = v => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v);

    let count = 0;
    for (const update of updates) {
      const venue = byId.get(Number(update.id));
      if (!venue) continue;

      const next = {};
      let invalid = false;
      for (const [field, maxLen] of Object.entries(TEXT_FIELDS)) {
        if (!(field in update)) { next[field] = venue[field]; continue; }
        const value = validateStr(update[field], maxLen);
        if (value === false) { invalid = true; break; }
        next[field] = value;
      }
      if (invalid) continue;
      for (const field of DATE_FIELDS) {
        if (!(field in update)) { next[field] = venue[field]; continue; }
        const value = validateStr(update[field], 10);
        if (value === false || !isDate(value)) { invalid = true; break; }
        next[field] = value;
      }
      if (invalid) continue;

      const [updated] = await sql`
        UPDATE venues SET
          status             = ${next.status},
          category           = ${next.category},
          booking_channel    = ${next.booking_channel},
          remuneration       = ${next.remuneration},
          season             = ${next.season},
          preferred_period   = ${next.preferred_period},
          comment            = ${next.comment},
          last_communication = ${next.last_communication},
          deadline           = ${next.deadline},
          last_updated       = NOW()
        WHERE id = ${venue.id} AND artist_id = ${artist.id}
        RETURNING id`;
      if (updated) count++;
    }
    return res.json({ ok: true, count });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
