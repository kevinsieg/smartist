const { getDb, getSlug } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { wrap } = require('../../_handler');
const { parseFields } = require('../../_validate');
const { ORGANIZER_FIELDS, updateSet, mergedTooLarge } = require('../../_domain/records');
const { requireFeature } = require('../../_plans');
const { removeGigFiles } = require('../gigs');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const id = Number(req.query.path?.[0]);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid organizer id' });
  const sql = getDb();

  if (req.method === 'GET') {
    // Private CRM data — auth required even for reads.
    const artist = await requireAuth(req, res, slug);
    if (!artist) return;
    if (!requireFeature(res, artist, 'organizers')) return;
    const [[org], gigs] = await Promise.all([
      sql`SELECT * FROM organizers WHERE id = ${id} AND artist_id = ${artist.id}`,
      req.query.refs ? sql`
        SELECT g.id, g.title, g.date, v.name AS venue_name, v.city AS venue_city
        FROM gigs g
        LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
        WHERE g.organizer_id = ${id} AND g.artist_id = ${artist.id} AND g.deleted = false
        ORDER BY g.date DESC NULLS LAST
      ` : null,
    ]);
    if (!org) return res.status(404).json({ error: 'Organizer not found' });
    if (req.query.refs) return res.json({ organizer: org, refs: { gigs } });
    return res.json(org);
  }

  const artist = await requireAuth(req, res, slug, 'member');
  if (!artist) return;
  if (!requireFeature(res, artist, 'organizers')) return;
  const [org] = await sql`SELECT * FROM organizers WHERE id = ${id} AND artist_id = ${artist.id}`;
  if (!org) return res.status(404).json({ error: 'Organizer not found' });

  if (req.method === 'PUT') {
    if (org.deleted) return res.status(409).json({ error: 'Organizer is deleted and cannot be modified' });
    // Only the fields sent are written; an empty value clears one.
    const { value, error } = parseFields(req.body, ORGANIZER_FIELDS, { partial: true });
    if (error) return res.status(400).json({ error });
    if (!Object.keys(value).length) return res.json(org);
    const tooLarge = mergedTooLarge(value, org, ['social_links', 'extra']);
    if (tooLarge) return res.status(400).json({ error: `${tooLarge} is too large` });
    const [updated] = await sql`
      UPDATE organizers ${updateSet(sql, value, ['social_links', 'extra'])}
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
    // One transaction: a refused delete (409) leaves the cascaded
    // gigs and setlists in place instead of already gone.
    let deleted;
    try {
      deleted = await sql.begin(tx => [
        ...(cascade?.includes('setlists') ? [tx`
          DELETE FROM setlists
          WHERE artist_id = ${artist.id}
            AND gig_id IN (SELECT id FROM gigs WHERE organizer_id = ${id} AND artist_id = ${artist.id})
        `] : []),
        ...(cascade?.includes('gigs') ? [tx`
          DELETE FROM gigs WHERE organizer_id = ${id} AND artist_id = ${artist.id}
          RETURNING poster_url, thumb_url
        `] : []),
        tx`DELETE FROM organizers WHERE id = ${id} AND artist_id = ${artist.id}`,
      ]);
    } catch (e) {
      if (e.code === '23503') {
        return res.status(409).json({ error: 'This organizer is still linked to one or more gigs. Remove the organizer from those gigs first, then delete.' });
      }
      throw e;
    }
    // Deleted gigs take their poster files with them.
    if (cascade?.includes('gigs')) {
      const gigs = deleted[deleted.length - 2];
      await removeGigFiles(req, artist, gigs.flatMap(g => [g.poster_url, g.thumb_url]));
    }
    return res.json({ deleted: true, hard: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
