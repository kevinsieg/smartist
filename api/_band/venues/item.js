const { getDb, getSlug } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { VENUE_PUBLIC_STATUSES } = require('../../_constants');
const { wrap } = require('../../_handler');
const { parseFields } = require('../../_validate');
const { VENUE_FIELDS, mergeJson } = require('../../_domain/records');
const { requireFeature } = require('../../_plans');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const id = Number(req.query.path?.[0]);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid venue id' });
  const sql = getDb();

  if (req.method === 'GET') {
    // See venues.js: contact data, never public.
    const artist = await requireAuth(req, res, slug);
    if (!artist) return;
    const user = req.user;
    if (!requireFeature(res, artist, 'venues')) return;
    let [[venue], gigs] = await Promise.all([
      sql`SELECT * FROM venues WHERE id = ${id} AND artist_id = ${artist.id}`,
      req.query.refs ? sql`
        SELECT id, title, date FROM gigs
        WHERE venue_id = ${id} AND artist_id = ${artist.id} AND deleted = false
        ORDER BY date DESC NULLS LAST
      ` : null,
    ]);
    if (!venue) return res.status(404).json({ error: 'Venue not found' });
    if (!user) {
      // Public visitors only see non-deleted venues with a public status,
      // and never the private CRM comment.
      const publicStatus = VENUE_PUBLIC_STATUSES.includes((venue.status || '').toLowerCase());
      if (venue.deleted || !publicStatus) return res.status(404).json({ error: 'Venue not found' });
      const { comment: _, ...rest } = venue;
      venue = rest;
    }
    if (req.query.refs) return res.json({ venue, refs: { gigs } });
    return res.json(venue);
  }

  const artist = await requireAuth(req, res, slug, 'member');
  if (!artist) return;
  if (!requireFeature(res, artist, 'venues')) return;
  const [venue] = await sql`SELECT * FROM venues WHERE id = ${id} AND artist_id = ${artist.id}`;
  if (!venue) return res.status(404).json({ error: 'Venue not found' });

  if (req.method === 'PUT') {
    if (venue.deleted) return res.status(409).json({ error: 'Venue is deleted and cannot be modified' });
    // Only the fields sent are written; an empty value clears one.
    const { value, error } = parseFields(req.body, VENUE_FIELDS, { partial: true });
    if (error) return res.status(400).json({ error });
    if (!Object.keys(value).length) return res.json(venue);
    mergeJson(value, venue, ['social_links']);
    const [updated] = await sql`
      UPDATE venues SET ${sql(value)}, last_updated = NOW()
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
    // One transaction: a refused delete (409) leaves the cascaded
    // gigs and setlists in place instead of already gone.
    try {
      await sql.begin(tx => [
        ...(cascade?.includes('setlists') ? [tx`
          DELETE FROM setlists
          WHERE artist_id = ${artist.id}
            AND gig_id IN (SELECT id FROM gigs WHERE venue_id = ${id} AND artist_id = ${artist.id})
        `] : []),
        ...(cascade?.includes('gigs') ? [tx`DELETE FROM gigs WHERE venue_id = ${id} AND artist_id = ${artist.id}`] : []),
        tx`DELETE FROM venues WHERE id = ${id} AND artist_id = ${artist.id}`,
      ]);
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
