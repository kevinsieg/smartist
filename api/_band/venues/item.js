const { VENUE_FIELDS } = require('../../_domain/records');
const { recordItemHandler } = require('../record_item');

// GET/PUT/DELETE /api/:artist/venues/:id (see ../record_item.js).
module.exports = recordItemHandler({
  table: 'venues', key: 'venue', label: 'Venue',
  fields: VENUE_FIELDS, jsonKeys: ['social_links'], gigColumn: 'venue_id',
  gigRefs: (sql, artistId, id) => sql`
    SELECT id, title, date FROM gigs
    WHERE venue_id = ${id} AND artist_id = ${artistId} AND deleted = false
    ORDER BY date DESC NULLS LAST
  `,
});
