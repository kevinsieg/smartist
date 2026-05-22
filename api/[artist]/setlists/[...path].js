const { getDb, getArtist, getSlug } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { validateSongIds, validateStr, validateEmail } = require('../../_validate');
const { buildSetlistPdf, setlistTitle } = require('../../_pdf');
const { sendEmail } = require('../../_email');
const { wrap } = require('../../_handler');
const logger = require('../../_logger');

module.exports = wrap(async function handler(req, res) {
  // vercel dev 52.x does not populate req.query.path for catch-alls inside dynamic dirs
  const pathParts = Array.isArray(req.query.path) && req.query.path.length
    ? req.query.path
    : req.url.split('?')[0].split('/setlists/')[1]?.split('/') ?? [];
  const [rawId, action] = pathParts;
  const slug = getSlug(req);

  // ── Export (merged from export.js via vercel.json rewrite) ───────────────
  if (rawId === 'export') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const sql = getDb();
    const [songs, gigs, setlists, setlist_songs] = await Promise.all([
      sql`SELECT * FROM songs WHERE artist_id = ${band.id} ORDER BY id`,
      sql`SELECT * FROM gigs WHERE artist_id = ${band.id} ORDER BY id`,
      sql`SELECT * FROM setlists WHERE artist_id = ${band.id} ORDER BY id`,
      sql`
        SELECT ss.* FROM setlist_songs ss
        JOIN setlists s ON ss.setlist_id = s.id
        WHERE s.artist_id = ${band.id}
        ORDER BY ss.setlist_id, ss.position
      `,
    ]);
    const date = new Date().toISOString().slice(0, 10);
    const safeSlug = String(slug ?? 'artist').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'artist';
    res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}-export-${date}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.json({ artist: { slug: band.slug, name: band.name }, songs, gigs, setlists, setlist_songs });
  }

  const setlistId = Number(rawId);
  if (!Number.isInteger(setlistId) || setlistId <= 0)
    return res.status(400).json({ error: 'Invalid setlist id' });

  const sql = getDb();

  // ── GET/PUT setlist ───────────────────────────────────────────────────────
  if (!action) {
    if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

    let band;
    if (req.method === 'PUT') {
      band = await requireAuth(req, res, slug);
      if (!band) return;
    } else {
      band = await getArtist(slug);
      if (!band) return res.status(404).json({ error: 'Band not found' });
    }

    const [setlist] = await sql`
      SELECT s.*, g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id
      LEFT JOIN venues v ON v.id = g.venue_id
      WHERE s.id = ${setlistId} AND s.artist_id = ${band.id}
    `;
    if (!setlist) return res.status(404).json({ error: 'Setlist not found' });

    if (req.method === 'GET') {
      const songs = await sql`
        SELECT songs.*, ss.position
        FROM setlist_songs ss
        JOIN songs ON ss.song_id = songs.id
        WHERE ss.setlist_id = ${setlistId}
        ORDER BY ss.position
      `;
      return res.json({ ...setlist, songs });
    }

    // PUT — update metadata + rebuild song list
    const { title: rawTitle, comment: rawComment, gig_id: rawGigId, song_ids } = req.body ?? {};

    const validIds = validateSongIds(song_ids ?? []);
    if (!validIds) return res.status(400).json({ error: 'Invalid song_ids' });

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    const comment = validateStr(rawComment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long' });
    const gigId = rawGigId != null ? Number(rawGigId) : null;
    if (gigId !== null && (!Number.isInteger(gigId) || gigId <= 0))
      return res.status(400).json({ error: 'Invalid gig_id' });

    await sql`
      UPDATE setlists SET title = ${title}, comment = ${comment}, gig_id = ${gigId}
      WHERE id = ${setlistId} AND artist_id = ${band.id}
    `;
    await sql`DELETE FROM setlist_songs WHERE setlist_id = ${setlistId}`;

    if (validIds.length > 0) {
      const setlistIds = validIds.map(() => setlistId);
      const positions  = validIds.map((_, i) => i);
      await sql`
        INSERT INTO setlist_songs (setlist_id, song_id, position)
        SELECT * FROM unnest(${setlistIds}::int[], ${validIds}::int[], ${positions}::int[])
      `;
    }

    const [updated] = await sql`
      SELECT s.*, g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue,
             COUNT(ss.song_id)::int AS song_count
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id
      LEFT JOIN venues v ON v.id = g.venue_id
      LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
      WHERE s.id = ${setlistId} AND s.artist_id = ${band.id}
      GROUP BY s.id, g.title, g.date, v.name
    `;
    return res.json(updated);
  }

  // ── POST duplicate ────────────────────────────────────────────────────────
  if (action === 'duplicate') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const [source] = await sql`
      SELECT * FROM setlists WHERE id = ${setlistId} AND artist_id = ${band.id}
    `;
    if (!source) return res.status(404).json({ error: 'Setlist not found' });

    const [copy] = await sql`
      INSERT INTO setlists (artist_id, title, gig_id, comment)
      VALUES (${band.id}, ${source.title ? source.title + ' (copy)' : null}, null, ${source.comment ?? null})
      RETURNING *
    `;

    const sourceSongs = await sql`
      SELECT song_id, position FROM setlist_songs
      WHERE setlist_id = ${setlistId}
      ORDER BY position
    `;

    if (sourceSongs.length > 0) {
      const copyIds   = sourceSongs.map(() => copy.id);
      const songIds   = sourceSongs.map(s => s.song_id);
      const positions = sourceSongs.map(s => s.position);
      await sql`
        INSERT INTO setlist_songs (setlist_id, song_id, position)
        SELECT * FROM unnest(${copyIds}::int[], ${songIds}::int[], ${positions}::int[])
      `;
    }

    const [created] = await sql`
      SELECT s.*, g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue,
             COUNT(ss.song_id)::int AS song_count
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id
      LEFT JOIN venues v ON v.id = g.venue_id
      LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
      WHERE s.id = ${copy.id}
      GROUP BY s.id, g.title, g.date, v.name
    `;
    return res.status(201).json(created);
  }

  // ── POST share ────────────────────────────────────────────────────────────
  if (action === 'share') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const band = await requireAuth(req, res, slug);
    if (!band) return;

    const [setlist] = await sql`
      SELECT s.*, g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id
      LEFT JOIN venues v ON v.id = g.venue_id
      WHERE s.id = ${setlistId} AND s.artist_id = ${band.id}
    `;
    if (!setlist) return res.status(404).json({ error: 'Setlist not found' });

    const songs = await sql`
      SELECT songs.*, ss.position
      FROM setlist_songs ss
      JOIN songs ON ss.song_id = songs.id
      WHERE ss.setlist_id = ${setlistId}
      ORDER BY ss.position
    `;

    const email = validateEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Valid email required' });

    await logger.info('setlist_share', { setlistId, band: slug, to: email, songCount: songs.length });

    const pdf     = await buildSetlistPdf(setlist, songs, band.name);
    const title   = setlistTitle(setlist);
    const subject = title ? `Setlist — ${title}` : `Setlist #${setlistId}`;

    try {
      await sendEmail({
        to: email,
        subject,
        text: `${subject}\n\n${songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`,
        attachments: [{ filename: 'setlist.pdf', content: pdf.toString('base64') }],
      });
      await logger.info('setlist_share_sent', { setlistId, to: email });
    } catch (err) {
      await logger.error('setlist_share_failed', { setlistId, to: email, error: err.message });
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.json({ ok: true });
  }

  return res.status(404).json({ error: 'Not found' });
});
