'use strict';

// Foreign ids arriving in a request body must belong to the caller's artist.
// Row ids are one sequence across every tenant, and the foreign keys in
// schema.sql only say "some row with this id exists" — not "a row of yours".
// Without these checks a member of one band could put another band's songs in
// a setlist (then read them back in full through the setlist GET), or hang a
// gig off another band's venue, which also blocks that band's deletions
// through the ON DELETE RESTRICT / no-cascade references.

// true when every id is a song of this artist. Soft-deleted songs count: an
// older setlist may still list them and must stay editable. Empty list → true.
async function ownsSongs(sql, artistId, ids) {
  if (!ids.length) return true;
  const [row] = await sql`
    SELECT count(*)::int AS n FROM songs
    WHERE artist_id = ${artistId} AND id = ANY(${ids}::int[])
  `;
  return Number(row?.n) === ids.length;
}

// null / undefined id → true (nothing referenced).
async function ownsGig(sql, artistId, id) {
  if (id == null) return true;
  const [row] = await sql`SELECT 1 AS ok FROM gigs WHERE id = ${Number(id)} AND artist_id = ${artistId}`;
  return !!row;
}

async function ownsVenue(sql, artistId, id) {
  if (id == null) return true;
  const [row] = await sql`SELECT 1 AS ok FROM venues WHERE id = ${Number(id)} AND artist_id = ${artistId}`;
  return !!row;
}

async function ownsOrganizer(sql, artistId, id) {
  if (id == null) return true;
  const [row] = await sql`SELECT 1 AS ok FROM organizers WHERE id = ${Number(id)} AND artist_id = ${artistId}`;
  return !!row;
}

// Song media this artist may delete from the bucket: a key scoped to its own
// id (`audio/<id>/…`), or an unscoped key from before scoping existed.
// keyFromUrl is passed in so callers use the same _r2 instance they delete with.
function isOwnMediaUrl(url, artistId, keyFromUrl) {
  const key = keyFromUrl(url);
  if (!key) return false;
  const m = /^(audio|sheets|playback)\/([^/]+)\/[^/]+$/.exec(key);
  if (m) return m[2] === String(artistId);
  return /^(audio|sheets|playback)\/[^/]+$/.test(key);
}

module.exports = { ownsSongs, ownsGig, ownsVenue, ownsOrganizer, isOwnMediaUrl };
