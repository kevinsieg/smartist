const { getDb, getBand } = require('../_db');
const { requireAuth } = require('../_auth');
const { validateSongIds, validateStr, validateEmail } = require('../_validate');
const { buildSetlistPdf, setlistTitle } = require('../_pdf');
const { sendEmail } = require('../_email');
const { wrap } = require('../_handler');
const { validateSetlistRefs } = require('../_setlist_refs');
const logger = require('../_logger');

module.exports = wrap(async function handler(req, res) {
  const { band: slug } = req.query;
  const sql = getDb();

  if (req.method === 'GET') {
    const band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const setlists = await sql`
      SELECT
        s.*,
        g.name  AS gig_name,
        g.date  AS gig_date,
        g.venue AS gig_venue,
        COUNT(ss.song_id)::int AS song_count
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id AND g.band_id = s.band_id
      LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
      WHERE s.band_id = ${band.id}
      GROUP BY s.id, g.name, g.date, g.venue
      ORDER BY s.created_at DESC
    `;
    return res.json(setlists);
  }

  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const { title: rawTitle, gig_id: rawGigId, comment: rawComment, song_ids, duplicate_id: rawDupId, share_id: rawShareId } = req.body ?? {};

    // ── Duplicate an existing setlist ─────────────────────────────────────────
    if (rawDupId != null) {
      const dupId = Number(rawDupId);
      if (!Number.isInteger(dupId) || dupId <= 0) return res.status(400).json({ error: 'Invalid duplicate_id' });

      const [source] = await sql`SELECT * FROM setlists WHERE id = ${dupId} AND band_id = ${band.id}`;
      if (!source) return res.status(404).json({ error: 'Setlist not found' });

      const [copy] = await sql`
        INSERT INTO setlists (band_id, title, gig_id, comment)
        VALUES (${band.id}, ${source.title ? source.title + ' (copy)' : null}, null, ${source.comment ?? null})
        RETURNING *
      `;

      const sourceSongs = await sql`
        SELECT ss.song_id, ss.position
        FROM setlist_songs ss
        JOIN songs ON ss.song_id = songs.id AND songs.band_id = ${band.id}
        WHERE ss.setlist_id = ${dupId}
        ORDER BY ss.position
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
        SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue,
               COUNT(ss.song_id)::int AS song_count
        FROM setlists s
        LEFT JOIN gigs g ON s.gig_id = g.id AND g.band_id = s.band_id
        LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
        WHERE s.id = ${copy.id}
        GROUP BY s.id, g.name, g.date, g.venue
      `;
      return res.status(201).json(created);
    }

    // ── Share a setlist by email ───────────────────────────────────────────────
    if (rawShareId != null) {
      const shareId = Number(rawShareId);
      if (!Number.isInteger(shareId) || shareId <= 0) return res.status(400).json({ error: 'Invalid share_id' });

      const [setlist] = await sql`
        SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue
        FROM setlists s
        LEFT JOIN gigs g ON s.gig_id = g.id AND g.band_id = s.band_id
        WHERE s.id = ${shareId} AND s.band_id = ${band.id}
      `;
      if (!setlist) return res.status(404).json({ error: 'Setlist not found' });

      const songs = await sql`
        SELECT songs.*, ss.position
        FROM setlist_songs ss
        JOIN songs ON ss.song_id = songs.id AND songs.band_id = ${band.id}
        WHERE ss.setlist_id = ${shareId}
        ORDER BY ss.position
      `;

      const email = validateEmail(req.body?.email);
      if (!email) return res.status(400).json({ error: 'Valid email required' });

      await logger.info('setlist_share', { setlistId: shareId, band: slug, to: email, songCount: songs.length });

      const pdf     = await buildSetlistPdf(setlist, songs, band.name);
      const title   = setlistTitle(setlist);
      const subject = title ? `Setlist — ${title}` : `Setlist #${shareId}`;

      try {
        await sendEmail({
          to: email,
          subject,
          text: `${subject}\n\n${songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`,
          attachments: [{ filename: 'setlist.pdf', content: pdf.toString('base64') }],
        });
        await logger.info('setlist_share_sent', { setlistId: shareId, to: email });
      } catch (err) {
        await logger.error('setlist_share_failed', { setlistId: shareId, to: email, error: err.message });
        return res.status(500).json({ error: 'Failed to send email' });
      }
      return res.json({ ok: true });
    }

    if (!Array.isArray(song_ids) || song_ids.length === 0)
      return res.status(400).json({ error: 'song_ids array is required' });
    const validIds = validateSongIds(song_ids);
    if (!validIds) return res.status(400).json({ error: 'Invalid song_ids' });

    const title = validateStr(rawTitle, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    const comment = validateStr(rawComment, 2000);
    if (comment === false) return res.status(400).json({ error: 'comment too long' });
    const gigId = rawGigId != null ? Number(rawGigId) : null;
    if (gigId !== null && (!Number.isInteger(gigId) || gigId <= 0))
      return res.status(400).json({ error: 'Invalid gig_id' });
    const refsError = await validateSetlistRefs(sql, band.id, { songIds: validIds, gigId });
    if (refsError) return res.status(400).json(refsError);

    const [setlist] = await sql`
      INSERT INTO setlists (band_id, title, gig_id, comment)
      VALUES (${band.id}, ${title}, ${gigId}, ${comment})
      RETURNING *
    `;
    const setlistIds = validIds.map(() => setlist.id);
    const positions  = validIds.map((_, i) => i);
    await sql`
      INSERT INTO setlist_songs (setlist_id, song_id, position)
      SELECT * FROM unnest(${setlistIds}::int[], ${validIds}::int[], ${positions}::int[])
    `;
    const [created] = await sql`
      SELECT s.*, g.name AS gig_name, g.date AS gig_date, g.venue AS gig_venue,
             COUNT(ss.song_id)::int AS song_count
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id AND g.band_id = s.band_id
      LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
      WHERE s.id = ${setlist.id}
      GROUP BY s.id, g.name, g.date, g.venue
    `;
    return res.status(201).json(created);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
