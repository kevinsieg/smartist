'use strict';
const { unsafeKey } = require('./_validate');

// Foreign ids arriving in a request body must belong to the caller's artist.
// Row ids are one sequence across every tenant, and the foreign keys in
// schema.sql only say "some row with this id exists" — not "a row of yours".
// Without these checks a member of one band could put another band's songs in
// a setlist (then read them back in full through the setlist GET), or hang a
// gig off another band's venue, which also blocks that band's deletions
// through the ON DELETE RESTRICT / no-cascade references.

// Every foreign id of one request body, checked in one statement (each
// statement costs two round-trips). Returns { songs, gig, venue, organizer }:
// true when the ids belong to this artist or nothing was sent for that key.
// Soft-deleted songs count: an older setlist may still list them and must stay
// editable. No ids at all → no query.
async function ownsRefs(sql, artistId, { songIds = [], gigId = null, venueId = null, organizerId = null } = {}) {
  const ids = songIds.map(Number);
  const gig = gigId == null ? null : Number(gigId);
  const venue = venueId == null ? null : Number(venueId);
  const organizer = organizerId == null ? null : Number(organizerId);
  if (!ids.length && gig == null && venue == null && organizer == null)
    return { songs: true, gig: true, venue: true, organizer: true };
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM songs
       WHERE artist_id = ${artistId} AND id = ANY(${ids}::int[])) = ${ids.length}::int AS songs,
      (${gig}::int IS NULL OR EXISTS (
        SELECT 1 FROM gigs WHERE id = ${gig}::int AND artist_id = ${artistId})) AS gig,
      (${venue}::int IS NULL OR EXISTS (
        SELECT 1 FROM venues WHERE id = ${venue}::int AND artist_id = ${artistId})) AS venue,
      (${organizer}::int IS NULL OR EXISTS (
        SELECT 1 FROM organizers WHERE id = ${organizer}::int AND artist_id = ${artistId})) AS organizer
  `;
  return { songs: !!row?.songs, gig: !!row?.gig, venue: !!row?.venue, organizer: !!row?.organizer };
}

// Song media this artist may delete from the bucket: a key scoped to its own
// id (`audio/<id>/…`).
// keyFromUrl is passed in so callers use the same _r2 instance they delete with.
function isOwnMediaUrl(url, artistId, keyFromUrl) {
  const key = keyFromUrl(url);
  if (!key || unsafeKey(key)) return false;
  const m = /^(audio|sheets|playback)\/([^/]+)\/[^/]+$/.exec(key);
  return !!m && m[2] === String(artistId);
}

module.exports = { ownsRefs, isOwnMediaUrl };
