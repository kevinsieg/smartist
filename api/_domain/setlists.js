'use strict';

// Setlist reads and writes shared by api/_band/setlists.js and
// api/_band/setlists/item.js.

// The gig a setlist row is shown with: its name, date and where it is (the
// venue, or the gig's free-text location when it has no venue). Every answer
// that carries a setlist row uses these two fragments, so they all say the
// same; the setlist is aliased `s`.
function gigColumns(sql) {
  return sql`g.title AS gig_name, g.date AS gig_date, COALESCE(v.name, g.location) AS gig_venue`;
}
function gigJoins(sql) {
  return sql`
    LEFT JOIN gigs g ON g.id = s.gig_id AND g.artist_id = s.artist_id
    LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id`;
}

// Copy one of this band's setlists with its songs, in one statement. The copy
// has no gig. Resolves to [] when the source is not this band's.
function duplicateSetlist(sql, artistId, sourceId) {
  return sql`
    WITH src AS (
      SELECT * FROM setlists WHERE id = ${sourceId} AND artist_id = ${artistId}
    ), s AS (
      INSERT INTO setlists (artist_id, title, gig_id, comment)
      SELECT artist_id, CASE WHEN NULLIF(title, '') IS NULL THEN NULL ELSE title || ' (copy)' END, NULL, comment
      FROM src
      RETURNING *
    ), ins AS (
      INSERT INTO setlist_songs (setlist_id, song_id, position)
      SELECT s.id, ss.song_id, ss.position FROM s JOIN setlist_songs ss ON ss.setlist_id = ${sourceId}
      RETURNING 1
    )
    SELECT s.*, NULL::text AS gig_name, NULL::date AS gig_date, NULL::text AS gig_venue,
           (SELECT count(*)::int FROM ins) AS song_count
    FROM s
  `;
}

// One setlist with the songs to print or mail, both scoped to the band.
async function setlistForShare(sql, artistId, setlistId) {
  const [[setlist], songs] = await Promise.all([
    sql`
      SELECT s.*, ${gigColumns(sql)}
      FROM setlists s
      ${gigJoins(sql)}
      WHERE s.id = ${setlistId} AND s.artist_id = ${artistId}
    `,
    sql`
      SELECT songs.*, ss.position
      FROM setlist_songs ss
      JOIN songs ON ss.song_id = songs.id
      WHERE ss.setlist_id = ${setlistId} AND songs.artist_id = ${artistId}
      ORDER BY ss.position
    `,
  ]);
  return { setlist: setlist ?? null, songs };
}

module.exports = { gigColumns, gigJoins, duplicateSetlist, setlistForShare };
