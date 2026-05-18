async function validateSetlistRefs(sql, bandId, { songIds = [], gigId = null } = {}) {
  if (gigId !== null) {
    const rows = await sql`
      SELECT id FROM gigs
      WHERE id = ${gigId} AND band_id = ${bandId}
      LIMIT 1
    `;
    if (rows.length === 0) return { error: 'Invalid gig_id' };
  }

  if (songIds.length > 0) {
    const rows = await sql`
      SELECT id FROM songs
      WHERE band_id = ${bandId} AND id = ANY(${songIds}::int[])
    `;
    if (rows.length !== songIds.length) return { error: 'Invalid song_ids' };
  }

  return null;
}

module.exports = { validateSetlistRefs };
