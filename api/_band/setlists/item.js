const { getDb, getSlug } = require('../../_db');
const { requireAuth, getAccess, canOpenStage, refuseDemo } = require('../../_auth');
const { validateSongIds, validateStr, validateEmail } = require('../../_validate');
const { ownsRefs } = require('../../_ownership');
const { checkRateLimit, clientIp, outboundMailLimited } = require('../../_ratelimit');
const { buildSetlistPdf, setlistTitle } = require('../../_pdf');
const { sendEmail } = require('../../_email');
const { wrap } = require('../../_handler');
const logger = require('../../_logger');
const { duplicateSetlist, setlistForShare } = require('../../_domain/setlists');
const { publicSong } = require('../../_domain/songs');

module.exports = wrap(async function handler(req, res) {
  const [rawId, action] = req.query.path || [];
  const slug = getSlug(req);

  const setlistId = Number(rawId);
  if (!Number.isInteger(setlistId) || setlistId <= 0)
    return res.status(400).json({ error: 'Invalid setlist id' });

  const sql = getDb();

  // ── GET/PUT/DELETE setlist ────────────────────────────────────────────────
  if (!action) {
    if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

    if (req.method === 'GET') {
      const { artist: band, user } = await getAccess(req, slug);
      if (!band) return res.status(404).json({ error: 'Band not found' });
      // A single setlist by id is what a shared /stage link opens. The list of
      // setlists stays private, so nobody can enumerate them from here.
      if (!user && !canOpenStage(band))
        return res.status(401).json({ error: 'Sign in to view this' });
      const [[setlist], songs] = await Promise.all([
        sql`
          SELECT s.*, g.title AS gig_name, g.date AS gig_date, COALESCE(v.name, g.location) AS gig_venue
          FROM setlists s
          LEFT JOIN gigs g ON s.gig_id = g.id AND g.artist_id = s.artist_id
          LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
          WHERE s.id = ${setlistId} AND s.artist_id = ${band.id}
        `,
        sql`
          SELECT songs.*, ss.position,
                 EXISTS (SELECT 1 FROM song_lyrics l WHERE l.song_id = songs.id) AS has_lyrics
          FROM setlist_songs ss
          JOIN songs ON ss.song_id = songs.id
          WHERE ss.setlist_id = ${setlistId} AND songs.artist_id = ${band.id}
          ORDER BY ss.position
        `,
      ]);
      if (!setlist) return res.status(404).json({ error: 'Setlist not found' });
      // Visitors on a public stage link never see the band's private song
      // notes. The setlist's own comment stays: stage shows it as a subtitle.
      return res.json({ ...setlist, songs: user ? songs : songs.map(publicSong) });
    }

    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;

    if (req.method === 'DELETE') {
      const [deleted] = await sql`
        DELETE FROM setlists WHERE id = ${setlistId} AND artist_id = ${band.id} RETURNING id
      `;
      if (!deleted) return res.status(404).json({ error: 'Setlist not found' });
      return res.json({ deleted: true });
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
    const [[setlist], owned] = await Promise.all([
      sql`SELECT id FROM setlists WHERE id = ${setlistId} AND artist_id = ${band.id}`,
      ownsRefs(sql, band.id, { songIds: validIds, gigId }),
    ]);
    if (!setlist)     return res.status(404).json({ error: 'Setlist not found' });
    if (!owned.songs) return res.status(400).json({ error: 'Invalid song_ids' });
    if (!owned.gig)   return res.status(400).json({ error: 'Invalid gig_id' });

    // One transaction: a failed insert can no longer leave the
    // setlist emptied by the delete before it.
    const results = await sql.begin(tx => [
      tx`
        UPDATE setlists SET title = ${title}, comment = ${comment}, gig_id = ${gigId}
        WHERE id = ${setlistId} AND artist_id = ${band.id}
      `,
      tx`DELETE FROM setlist_songs WHERE setlist_id = ${setlistId}`,
      ...(validIds.length ? [tx`
        INSERT INTO setlist_songs (setlist_id, song_id, position)
        SELECT ${setlistId}, u.song_id, u.ord - 1
        FROM unnest(${validIds}::int[]) WITH ORDINALITY AS u(song_id, ord)
      `] : []),
      tx`
        SELECT s.*, g.title AS gig_name, g.date AS gig_date, COALESCE(v.name, g.location) AS gig_venue,
               ${validIds.length}::int AS song_count
        FROM setlists s
        LEFT JOIN gigs g ON s.gig_id = g.id AND g.artist_id = s.artist_id
        LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
        WHERE s.id = ${setlistId} AND s.artist_id = ${band.id}
      `,
    ]);
    return res.json(results[results.length - 1][0]);
  }

  // ── POST /setlists/:id/duplicate — copy the row and its songs ─────────────
  if (action === 'duplicate' || action === 'share') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;

    if (action === 'duplicate') {
      const [created] = await duplicateSetlist(sql, band.id, setlistId);
      if (!created) return res.status(404).json({ error: 'Setlist not found' });
      return res.status(201).json(created);
    }

    // ── POST /setlists/:id/share — email it as a PDF ────────────────────────
    if (refuseDemo(req, res)) return;
    const email = validateEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Valid email required' });

    const { setlist, songs } = await setlistForShare(sql, band.id, setlistId);
    if (!setlist) return res.status(404).json({ error: 'Setlist not found' });

    // Mail to any address: capped per band and per IP so a session is not a relay.
    if (await checkRateLimit(`share:${band.id}`, 30, 3600)
        || await checkRateLimit(`share-ip:${clientIp(req)}`, 30, 3600)
        || await outboundMailLimited(req.user.email || `user:${req.user.id}`))
      return res.status(429).json({ error: 'Too many shares — try again later' });

    await logger.info('setlist_share', { setlistId, band: slug, to: email, songCount: songs.length });

    const pdf     = await buildSetlistPdf(setlist, songs, band.name);
    const title   = setlistTitle(setlist);
    const subject = title ? `Setlist — ${String(title).replace(/[\r\n]+/g, ' ')}` : `Setlist #${setlistId}`;

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
