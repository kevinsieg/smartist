'use strict';

const { getDb, getSlug } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { parseFields, positiveId, deleteMode } = require('../_validate');
const { updateSet, mergedTooLarge } = require('../_domain/records');
const { removeGigFiles } = require('../_domain/gigs');
const { MSG } = require('../_domain/http');
const { requireFeature } = require('../_plans');

// GET/PUT/DELETE /api/:artist/<table>/:id for the CRM records that gigs point
// at (venues, organizers). They differ only in what the spec says:
//
//   table      'venues'             the table, and the plan feature
//   key        'venue'              the record's key in a ?refs answer
//   label      'Venue'              the record in messages
//   fields     VENUE_FIELDS         api/_domain/records.js
//   jsonKeys   ['social_links']     JSONB columns merged, not overwritten
//   gigColumn  'venue_id'           the gigs column that points at the record
//   gigRefs    (sql, artistId, id) → the gigs a ?refs answer lists
function recordItemHandler(spec) {
  const notFound = `${spec.label} not found`;

  // ── GET — the record; with ?refs, the gigs that use it ─────────────────────
  // Contact data: a session is always required, no setting opens it up.
  async function get(req, res, { sql, artist, id }) {
    const [[row], gigs] = await Promise.all([
      sql`SELECT * FROM ${sql(spec.table)} WHERE id = ${id} AND artist_id = ${artist.id}`,
      req.query.refs ? spec.gigRefs(sql, artist.id, id) : null,
    ]);
    if (!row) return res.status(404).json({ error: notFound });
    if (req.query.refs) return res.json({ [spec.key]: row, refs: { gigs } });
    return res.json(row);
  }

  // ── PUT — only the fields sent are written; an empty value clears one ──────
  async function put(req, res, { sql, artist, id, row }) {
    if (row.deleted) return res.status(409).json({ error: `${spec.label} is deleted and cannot be modified` });
    const { value, error } = parseFields(req.body, spec.fields, { partial: true });
    if (error) return res.status(400).json({ error });
    if (!Object.keys(value).length) return res.json(row);
    const tooLarge = mergedTooLarge(value, row, spec.jsonKeys);
    if (tooLarge) return res.status(400).json({ error: `${tooLarge} is too large` });
    const [updated] = await sql`
      UPDATE ${sql(spec.table)} ${updateSet(sql, value, spec.jsonKeys)}
      WHERE id = ${id} AND artist_id = ${artist.id}
      RETURNING *
    `;
    return res.json(updated);
  }

  // ── DELETE — soft by default; ?hard=1&cascade=gigs,setlists ───────────────
  // A hard delete is one transaction: a refused delete (409, a gig still points
  // at the record) leaves the cascaded gigs and setlists in place.
  async function del(req, res, { sql, artist, id }) {
    const mode = deleteMode(req.query, ['gigs', 'setlists']);
    if (mode === false) return res.status(400).json({ error: 'cascade must be a list of: gigs, setlists' });
    const { hard, cascade } = mode;
    if (!hard) {
      const [updated] = await sql`
        UPDATE ${sql(spec.table)} SET deleted = true, last_updated = NOW()
        WHERE id = ${id} AND artist_id = ${artist.id} RETURNING *
      `;
      return res.json(updated);
    }
    // The statements go out together (one array); the gigs' answer is kept
    // by the index it was given, for the poster files.
    let gigsAt = -1;
    let results;
    try {
      results = await sql.begin(tx => {
        const steps = [];
        if (cascade.includes('setlists')) steps.push(tx`
          DELETE FROM setlists
          WHERE artist_id = ${artist.id}
            AND gig_id IN (SELECT id FROM gigs WHERE ${tx(spec.gigColumn)} = ${id} AND artist_id = ${artist.id})`);
        if (cascade.includes('gigs')) gigsAt = steps.push(tx`
          DELETE FROM gigs WHERE ${tx(spec.gigColumn)} = ${id} AND artist_id = ${artist.id}
          RETURNING poster_url, thumb_url`) - 1;
        steps.push(tx`DELETE FROM ${tx(spec.table)} WHERE id = ${id} AND artist_id = ${artist.id}`);
        return steps;
      });
    } catch (e) {
      if (e.code === '23503') {
        const noun = spec.label.toLowerCase();
        return res.status(409).json({ error: `This ${noun} is still linked to one or more gigs. Remove the ${noun} from those gigs first, then delete.` });
      }
      throw e;
    }
    // Deleted gigs take their poster files with them.
    const deletedGigs = gigsAt >= 0 ? results[gigsAt] : [];
    await removeGigFiles(req.user, artist, deletedGigs.flatMap(g => [g.poster_url, g.thumb_url]));
    return res.json({ deleted: true, hard: true });
  }

  const METHODS = { PUT: put, DELETE: del };

  return wrap(async function handler(req, res) {
    const slug = getSlug(req);
    const id = positiveId(req.query.path?.[0]);
    if (!id) return res.status(400).json({ error: `Invalid ${spec.label.toLowerCase()} id` });
    const write = Object.hasOwn(METHODS, req.method) ? METHODS[req.method] : null;
    if (req.method !== 'GET' && !write) return res.status(405).json({ error: MSG.methodNotAllowed });
    const sql = getDb();

    const artist = await requireAuth(req, res, slug, write ? 'member' : null);
    if (!artist) return;
    if (!requireFeature(res, artist, spec.table)) return;
    if (!write) return get(req, res, { sql, artist, id });

    const [row] = await sql`SELECT * FROM ${sql(spec.table)} WHERE id = ${id} AND artist_id = ${artist.id}`;
    if (!row) return res.status(404).json({ error: notFound });
    return write(req, res, { sql, artist, id, row });
  });
}

module.exports = { recordItemHandler };
