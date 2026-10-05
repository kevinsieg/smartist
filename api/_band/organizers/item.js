const { ORGANIZER_FIELDS } = require('../../_domain/records');
const { recordItemHandler } = require('../record_item');

// GET/PUT/DELETE /api/:artist/organizers/:id (see ../record_item.js).
module.exports = recordItemHandler({
  table: 'organizers', key: 'organizer', label: 'Organizer',
  fields: ORGANIZER_FIELDS, jsonKeys: ['social_links', 'extra'], gigColumn: 'organizer_id',
  gigRefs: (sql, artistId, id) => sql`
    SELECT g.id, g.title, g.date, v.name AS venue_name, v.city AS venue_city
    FROM gigs g
    LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
    WHERE g.organizer_id = ${id} AND g.artist_id = ${artistId} AND g.deleted = false
    ORDER BY g.date DESC NULLS LAST
  `,
});
