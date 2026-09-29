const { getDb, getSlug } = require('../_db');
const { requireAuth, getAccess, refuseDemo } = require('../_auth');
const { validateSongIds, validateStr, validateEmail } = require('../_validate');
const { ownsSongs, ownsGig } = require('../_ownership');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { buildSetlistPdf, setlistTitle } = require('../_pdf');
const { sendEmail } = require('../_email');
const { wrap } = require('../_handler');
const logger = require('../_logger');
const { duplicateSetlist, setlistForShare } = require('../_domain/setlists');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    const { artist, user } = await getAccess(req, slug);
    if (!artist) return res.status(404).json({ error: 'Band not found' });
    // The list of setlists is never public — only an individual one, reached
    // from a stage link (see setlists/[...path].js).
    if (!user) return res.status(401).json({ error: 'Sign in to view this' });

    // ?song_q=<text>: the setlists (and their gigs) that contain a song whose
    // title contains <text>. The gig and history filters asked
    // /songs/:id/setlists once per matching song — one request per song.
    if (req.query.song_q != null) {
      const q = String(req.query.song_q).trim().slice(0, 100);
      if (!q) return res.json([]);
      const pattern = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
      const rows = await sql`
        SELECT DISTINCT sl.id, sl.gig_id
        FROM setlists sl
        JOIN setlist_songs ss ON ss.setlist_id = sl.id
        JOIN songs s ON s.id = ss.song_id AND s.artist_id = sl.artist_id
        WHERE sl.artist_id = ${artist.id} AND s.deleted = false AND s.title ILIKE ${pattern}
      `;
      return res.json(rows);
    }

    const setlists = await sql`
      SELECT
        s.*,
        g.title AS gig_name,
        g.date  AS gig_date,
        v.name  AS gig_venue,
        COUNT(ss.song_id)::int AS song_count
      FROM setlists s
      LEFT JOIN gigs g ON s.gig_id = g.id AND g.artist_id = s.artist_id
      LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
      LEFT JOIN setlist_songs ss ON s.id = ss.setlist_id
      WHERE s.artist_id = ${artist.id}
      GROUP BY s.id, g.title, g.date, v.name
      ORDER BY s.created_at DESC
    `;
    return res.json(setlists);
  }

  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const { title: rawTitle, gig_id: rawGigId, comment: rawComment, song_ids, duplicate_id: rawDupId, share_id: rawShareId } = req.body ?? {};

    // ── Duplicate an existing setlist ─────────────────────────────────────────
    // One statement: copy the row and its songs, scoped to this band.
    if (rawDupId != null) {
      const dupId = Number(rawDupId);
      if (!Number.isInteger(dupId) || dupId <= 0) return res.status(400).json({ error: 'Invalid duplicate_id' });
      const [created] = await duplicateSetlist(sql, band.id, dupId);
      if (!created) return res.status(404).json({ error: 'Setlist not found' });
      return res.status(201).json(created);
    }

    // ── Share a setlist by email ───────────────────────────────────────────────
    if (rawShareId != null) {
      if (refuseDemo(req, res)) return;
      const shareId = Number(rawShareId);
      if (!Number.isInteger(shareId) || shareId <= 0) return res.status(400).json({ error: 'Invalid share_id' });
      const email = validateEmail(req.body?.email);
      if (!email) return res.status(400).json({ error: 'Valid email required' });

      const { setlist, songs } = await setlistForShare(sql, band.id, shareId);
      if (!setlist) return res.status(404).json({ error: 'Setlist not found' });

      // Mail to any address: capped per band and per IP so a session is not a relay.
      if (await checkRateLimit(`share:${band.id}`, 30, 3600)
          || await checkRateLimit(`share-ip:${clientIp(req)}`, 30, 3600))
        return res.status(429).json({ error: 'Too many shares — try again later' });

      await logger.info('setlist_share', { setlistId: shareId, band: slug, to: email, songCount: songs.length });

      const pdf     = await buildSetlistPdf(setlist, songs, band.name);
      const title   = setlistTitle(setlist);
      const subject = title ? `Setlist — ${String(title).replace(/[\r\n]+/g, ' ')}` : `Setlist #${shareId}`;

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
    const [songsOk, gigOk] = await Promise.all([
      ownsSongs(sql, band.id, validIds),
      ownsGig(sql, band.id, gigId),
    ]);
    if (!songsOk) return res.status(400).json({ error: 'Invalid song_ids' });
    if (!gigOk)   return res.status(400).json({ error: 'Invalid gig_id' });

    // Setlist, its songs and the list row the client shows — one statement,
    // so a failure never leaves a setlist without its songs.
    const [created] = await sql`
      WITH s AS (
        INSERT INTO setlists (artist_id, title, gig_id, comment)
        VALUES (${band.id}, ${title}, ${gigId}, ${comment})
        RETURNING *
      ), ins AS (
        INSERT INTO setlist_songs (setlist_id, song_id, position)
        SELECT s.id, u.song_id, u.ord - 1
        FROM s, unnest(${validIds}::int[]) WITH ORDINALITY AS u(song_id, ord)
      )
      SELECT s.*, g.title AS gig_name, g.date AS gig_date, v.name AS gig_venue,
             ${validIds.length}::int AS song_count
      FROM s
      LEFT JOIN gigs g ON s.gig_id = g.id AND g.artist_id = s.artist_id
      LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
    `;
    return res.status(201).json(created);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
