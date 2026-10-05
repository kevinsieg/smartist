const { getDb, getSlug, parsePage } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr, parseFields, positiveId, likePattern, F } = require('../_validate');
const { VENUE_FIELDS } = require('../_domain/records');
const { MSG } = require('../_domain/http');
const { requireFeature } = require('../_plans');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    // Venue rows carry contact_name, phone and generic_email. No flag opens
    // that up — a session is always required, as for organizers.
    const artist = await requireAuth(req, res, slug);
    if (!artist) return;
    if (!requireFeature(res, artist, 'venues')) return;

    if (req.query.slim) {
      const venues = await sql`
        SELECT id, name, city FROM venues
        WHERE artist_id = ${artist.id} AND deleted = false
        ORDER BY name ASC
      `;
      return res.json(venues);
    }

    // Filter options must cover the whole workspace, not just the page on screen.
    if (req.query.facet === 'country') {
      const rows = await sql`
        SELECT DISTINCT country FROM venues
        WHERE artist_id = ${artist.id} AND deleted = false AND country IS NOT NULL AND country <> ''
        ORDER BY country ASC`;
      return res.json(rows.map(r => r.country));
    }

    if (req.query.all) {
      const statusFilter = req.query.status ? req.query.status.toLowerCase() : null;
      // Map payload: no comment (private CRM notes) and no audit columns, and only
      // venues that can actually be placed — a row without coordinates is dead weight.
      const venues = await sql`
        SELECT id, name, street_number, street, city, postcode, country,
               category, status, size, lat, lng
        FROM venues
        WHERE artist_id = ${artist.id} AND deleted = false
          AND lat IS NOT NULL AND lng IS NOT NULL
          AND (${statusFilter}::text IS NULL OR LOWER(status) = ${statusFilter})
        ORDER BY name ASC
      `;
      return res.json(venues);
    }

    const { limit, offset } = parsePage(req);
    const q        = (req.query.q        || '').trim();
    // Whitelisted sort — the column name goes into the query unquoted, so it may
    // never come straight from the request.
    const SORTABLE = ['name', 'city', 'status', 'category', 'last_communication',
                      'deadline', 'season', 'preferred_period'];
    const sortField = SORTABLE.includes(req.query.sort) ? req.query.sort : null;
    const sortDir   = req.query.dir === 'desc' ? sql`DESC` : sql`ASC`;
    // Favourites always lead; without an explicit sort, placeholders next, then by name.
    const orderBy   = sortField
      ? sql`heart DESC, ${sql(sortField)} ${sortDir} NULLS LAST, name ASC`
      : sql`heart DESC, category = 'placeholder' DESC, name ASC`;
    const favourite = req.query.favourite === '1';
    // A–Z jump: single letter, or '#' for names starting with anything else.
    const rawLetter = (req.query.letter || '').trim();
    const letter    = /^[A-Za-z]$/.test(rawLetter) ? `${rawLetter}%` : null;
    const nonAlpha  = rawLetter === '#';
    // Status, category and country are picked from lists: exact values, any case.
    const status   = (req.query.status   || '').trim() || null;
    const category = (req.query.category || '').trim() || null;
    const country  = (req.query.country  || '').trim() || null;
    const pattern  = likePattern(q);
    const rows = await sql`
      SELECT *, COUNT(*) OVER() AS total
      FROM venues
      WHERE artist_id = ${artist.id}
        AND (${pattern}::text IS NULL
          OR name     ILIKE ${pattern}
          OR city     ILIKE ${pattern}
          OR country  ILIKE ${pattern}
          OR postcode ILIKE ${pattern})
        AND (${status}::text   IS NULL OR lower(status)   = lower(${status}))
        AND (${category}::text IS NULL OR lower(category) = lower(${category}))
        AND (${country}::text  IS NULL OR lower(country)  = lower(${country}))
        AND (${letter}::text IS NULL OR name ILIKE ${letter})
        AND (NOT ${nonAlpha} OR name !~* '^[a-z]')
        AND (NOT ${favourite} OR heart)
      ORDER BY deleted ASC, ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;
    const total = Number(rows[0]?.total ?? 0);
    return res.json({ rows: rows.map(({ total: _, ...r }) => r), total, limit, offset });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug, 'member');
    if (!artist) return;
    if (!requireFeature(res, artist, 'venues')) return;
    const { value, error } = parseFields(req.body, VENUE_FIELDS);
    if (error) return res.status(400).json({ error });
    const [venue] = await sql`INSERT INTO venues ${sql({ ...value, artist_id: artist.id })} RETURNING *`;
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

    // A row that is not an object, or has no valid id, is rejected on its own.
    const rowId = u => (u && typeof u === 'object' ? positiveId(u.id) : false);
    const ids = updates.map(rowId).filter(Boolean);
    const rows = ids.length ? await sql`
      SELECT * FROM venues WHERE artist_id = ${artist.id} AND deleted = false AND id = ANY(${ids}::int[])` : [];
    const byId = new Map(rows.map(r => [r.id, r]));

    // field → max length; dates are validated separately.
    const TEXT_FIELDS = { status: 50, category: 100, booking_channel: 50, remuneration: 100,
                          season: 50, preferred_period: 100, comment: 2000 };
    // Real calendar dates: a well-formed 2026-02-30 failed the ::date[] cast and
    // took the whole batch down with a 500.
    const DATE_FIELDS = { last_communication: F.date(), deadline: F.date() };

    const rejected = [];
    const accepted = [];
    for (const update of updates) {
      const id = rowId(update);
      if (!id) { rejected.push({ id: update?.id ?? null, error: 'invalid venue id' }); continue; }
      const venue = byId.get(id);
      if (!venue) { rejected.push({ id, error: 'venue not found' }); continue; }

      const next = { id };
      let error = null;
      for (const [field, maxLen] of Object.entries(TEXT_FIELDS)) {
        if (!(field in update)) { next[field] = venue[field]; continue; }
        const value = validateStr(update[field], maxLen);
        if (value === false) { error = `${field} too long (max ${maxLen})`; break; }
        next[field] = value;
      }
      if (!error) {
        const dates = parseFields(update, DATE_FIELDS, { partial: true });
        if (dates.error) error = dates.error;
        else for (const field of Object.keys(DATE_FIELDS)) next[field] = field in dates.value ? dates.value[field] : venue[field];
      }
      if (!error && 'heart' in update && typeof update.heart !== 'boolean') error = 'heart must be a boolean';
      next.heart = 'heart' in update ? update.heart : venue.heart;
      if (error) rejected.push({ id, error });
      else accepted.push(next);
    }

    // One statement for the whole batch instead of up to 200 round-trips (and,
    // being one statement, all rows or none).
    let count = 0;
    if (accepted.length) {
      const col = f => accepted.map(r => r[f] ?? null);
      const updated = await sql`
        UPDATE venues SET
          status             = u.status,
          category           = u.category,
          booking_channel    = u.booking_channel,
          remuneration       = u.remuneration,
          season             = u.season,
          preferred_period   = u.preferred_period,
          comment            = u.comment,
          last_communication = u.last_communication,
          deadline           = u.deadline,
          heart              = u.heart::boolean,  -- sent as text: postgres.js does not serialise boolean arrays
          last_updated       = NOW()
        FROM unnest(${col('id')}::int[], ${col('status')}::text[], ${col('category')}::text[],
                    ${col('booking_channel')}::text[], ${col('remuneration')}::text[], ${col('season')}::text[],
                    ${col('preferred_period')}::text[], ${col('comment')}::text[],
                    ${col('last_communication')}::date[], ${col('deadline')}::date[], ${col('heart').map(String)}::text[])
             AS u(id, status, category, booking_channel, remuneration, season,
                  preferred_period, comment, last_communication, deadline, heart)
        WHERE venues.id = u.id AND venues.artist_id = ${artist.id} AND venues.deleted = false
        RETURNING venues.id`;
      count = updated.length;
    }

    return res.json({ ok: true, count, rejected });
  }

  res.status(405).json({ error: MSG.methodNotAllowed });
});
