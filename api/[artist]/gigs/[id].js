const crypto = require('crypto');
const { getDb, getArtist, getSlug } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { wrap } = require('../../_handler');
const { validateStr } = require('../../_validate');
const { createPresignedUrl, deleteFromR2, verifyUpload, keyFromUrl } = require('../../_r2');

module.exports = wrap(async function handler(req, res) {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method))
    return res.status(405).json({ error: 'Method not allowed' });

  const slug = getSlug(req);
  const gigId = Number(req.query.id);
  if (!Number.isInteger(gigId) || gigId <= 0) return res.status(400).json({ error: 'Invalid gig id' });

  const sql = getDb();

  if (req.method === 'GET') {
    const artist = await getArtist(slug);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    const [gig] = await sql`
      SELECT g.*, v.name AS venue_name, o.name AS organizer_name
      FROM gigs g
      LEFT JOIN venues v ON v.id = g.venue_id
      LEFT JOIN organizers o ON o.id = g.organizer_id
      WHERE g.id = ${gigId} AND g.artist_id = ${artist.id}
    `;
    if (!gig) return res.status(404).json({ error: 'Gig not found' });
    if (req.query.refs) {
      const setlists = await sql`
        SELECT id, title FROM setlists
        WHERE gig_id = ${gigId} AND artist_id = ${artist.id}
        ORDER BY id DESC
      `;
      const venue = gig.venue_id
        ? (await sql`SELECT id, name, city FROM venues WHERE id = ${gig.venue_id} AND artist_id = ${artist.id}`)[0] ?? null
        : null;
      const organizer = gig.organizer_id
        ? (await sql`SELECT id, name, city FROM organizers WHERE id = ${gig.organizer_id} AND artist_id = ${artist.id}`)[0] ?? null
        : null;
      const setlistIds = setlists.map(s => s.id);
      const setlistSongs = setlistIds.length
        ? await sql`
            SELECT ss.setlist_id, ss.position, s.title
            FROM setlist_songs ss
            JOIN songs s ON s.id = ss.song_id
            WHERE ss.setlist_id = ANY(${setlistIds}::int[])
            ORDER BY ss.setlist_id, ss.position
          `
        : [];
      return res.json({ gig, refs: { setlists, setlistSongs, venue, organizer } });
    }
    return res.json(gig);
  }

  const artist = await requireAuth(req, res, slug);
  if (!artist) return;
  const [gig] = await sql`SELECT * FROM gigs WHERE id = ${gigId} AND artist_id = ${artist.id}`;
  if (!gig) return res.status(404).json({ error: 'Gig not found' });

  // ── POST ?action=poster-url — get presigned upload URLs ──────────────────
  if (req.method === 'POST' && req.query.action === 'poster-url') {
    const { contentType } = req.body ?? {};
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(contentType))
      return res.status(400).json({ error: 'Only JPEG, PNG, or WebP images are supported' });
    const uuid      = crypto.randomUUID();
    const posterKey = `gigs/${artist.slug}/${gigId}-${uuid}-poster.jpg`;
    const thumbKey  = `gigs/${artist.slug}/${gigId}-${uuid}-thumb.jpg`;
    const [poster, thumb] = await Promise.all([
      createPresignedUrl(posterKey, 'image/jpeg'),
      createPresignedUrl(thumbKey,  'image/jpeg'),
    ]);
    return res.json({
      posterUploadUrl: poster.uploadUrl,
      posterPublicUrl: poster.publicUrl,
      thumbUploadUrl:  thumb.uploadUrl,
      thumbPublicUrl:  thumb.publicUrl,
    });
  }

  // ── PUT ?action=poster — confirm upload, save to DB ──────────────────────
  if (req.method === 'PUT' && req.query.action === 'poster') {
    const { posterUrl, thumbUrl } = req.body ?? {};
    if (!posterUrl || !thumbUrl)
      return res.status(400).json({ error: 'posterUrl and thumbUrl are required' });
    const [posterOk, thumbOk] = await Promise.all([
      verifyUpload(keyFromUrl(posterUrl)),
      verifyUpload(keyFromUrl(thumbUrl)),
    ]);
    if (!posterOk) return res.status(400).json({ error: 'Poster file not found in storage' });
    if (!thumbOk)  return res.status(400).json({ error: 'Thumbnail file not found in storage' });
    const expectedPrefix = `gigs/${artist.slug}/${gigId}-`;
    if (!keyFromUrl(posterUrl)?.startsWith(expectedPrefix))
      return res.status(400).json({ error: 'Invalid poster URL' });
    if (!keyFromUrl(thumbUrl)?.startsWith(expectedPrefix))
      return res.status(400).json({ error: 'Invalid thumb URL' });
    if (posterOk.contentType !== 'image/jpeg')
      return res.status(400).json({ error: 'Poster must be a JPEG image' });
    if (thumbOk.contentType !== 'image/jpeg')
      return res.status(400).json({ error: 'Thumbnail must be a JPEG image' });
    // Delete old files if replacing
    if (gig.poster_url) {
      await Promise.all([
        deleteFromR2(gig.poster_url).catch(() => {}),
        gig.thumb_url ? deleteFromR2(gig.thumb_url).catch(() => {}) : Promise.resolve(),
      ]);
    }
    await sql`
      UPDATE gigs
      SET poster_url = ${posterUrl}, thumb_url = ${thumbUrl}, last_updated = NOW()
      WHERE id = ${gigId} AND artist_id = ${artist.id}
    `;
    return res.json({ ok: true, posterUrl, thumbUrl });
  }

  if (req.method === 'PUT') {
    if (gig.deleted) return res.status(409).json({ error: 'Gig is deleted and cannot be modified' });
    const body = req.body ?? {};
    const title = validateStr(body.title, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title required' });
    const comment  = validateStr(body.comment, 2000);
    if (comment  === false) return res.status(400).json({ error: 'comment too long' });
    const location = validateStr(body.location, 200);
    if (location === false) return res.status(400).json({ error: 'location too long' });
    const [updated] = await sql`
      UPDATE gigs SET
        title = ${title}, date = ${body.date || null},
        venue_id = ${body.venue_id ?? gig.venue_id},
        organizer_id = ${body.organizer_id ?? gig.organizer_id},
        type = ${body.type ?? gig.type},
        time_start = ${body.time_start ?? gig.time_start},
        time_end = ${body.time_end ?? gig.time_end},
        additional_link = ${body.additional_link ?? gig.additional_link},
        additional_text = ${body.additional_text ?? gig.additional_text},
        comment = ${comment ?? gig.comment},
        location = ${location ?? gig.location},
        last_updated = NOW()
      WHERE id = ${gigId} AND artist_id = ${artist.id}
      RETURNING *
    `;
    return res.json(updated);
  }

  // ── DELETE ?action=poster — remove poster files and clear DB ─────────────
  if (req.method === 'DELETE' && req.query.action === 'poster') {
    if (gig.poster_url) await deleteFromR2(gig.poster_url).catch(() => {});
    if (gig.thumb_url)  await deleteFromR2(gig.thumb_url).catch(() => {});
    await sql`
      UPDATE gigs
      SET poster_url = NULL, thumb_url = NULL, last_updated = NOW()
      WHERE id = ${gigId} AND artist_id = ${artist.id}
    `;
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { hard, cascade } = req.body ?? {};
    if (!hard) {
      const [updated] = await sql`
        UPDATE gigs SET deleted = true, last_updated = NOW()
        WHERE id = ${gigId} AND artist_id = ${artist.id} RETURNING *
      `;
      return res.json(updated);
    }
    if (cascade?.includes('setlists')) {
      await sql`DELETE FROM setlists WHERE gig_id = ${gigId} AND artist_id = ${artist.id}`;
    }
    await sql`DELETE FROM gigs WHERE id = ${gigId} AND artist_id = ${artist.id}`;
    return res.json({ deleted: true, hard: true });
  }
});
