const { getDb, getSlug } = require('../../_db');
const { requireAuth, getAccess, canOpenStage, refuseDemo } = require('../../_auth');
const { validateSongIds, validateStr, validateEmail } = require('../../_validate');
const { ownsSongs, ownsGig } = require('../../_ownership');
const { checkRateLimit, clientIp } = require('../../_ratelimit');
const { buildSetlistPdf, setlistTitle } = require('../../_pdf');
const { sendEmail } = require('../../_email');
const { wrap } = require('../../_handler');
const logger = require('../../_logger');
const { toCsv, buildZip } = require('../../_export');
const { duplicateSetlist, setlistForShare } = require('../../_domain/setlists');
const { publicSong } = require('../../_domain/songs');

module.exports = wrap(async function handler(req, res) {
  // vercel dev 52.x does not populate req.query.path for catch-alls inside dynamic dirs
  const _rawUrl   = req.url.split('?')[0];
  const pathParts = Array.isArray(req.query.path) && req.query.path.length
    ? req.query.path
    : _rawUrl.split('/setlists/')[1]?.split('/')
      ?? (_rawUrl.endsWith('/export') ? ['export'] : []);
  const [rawId, action] = pathParts;
  const slug = getSlug(req);

  // ── Export (merged from export.js via vercel.json rewrite) ───────────────
  if (rawId === 'export') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const band = await requireAuth(req, res, slug, 'member');
    if (!band) return;
    const sql = getDb();
    const [songs, song_arrangements, gigs, setlists, setlist_songs, venues, organizers, gema_works, gema_rightholders, song_logs, account, members] = await Promise.all([
      // Lyrics live in their own table; in the CSV they stay a column of songs.
      sql`
        SELECT s.*, l.lyrics FROM songs s
        LEFT JOIN song_lyrics l ON l.song_id = s.id
        WHERE s.artist_id = ${band.id} ORDER BY s.id
      `,
      // Arrangements are real, hand-entered data and this export is offered on
      // /profile as the last chance before permanent deletion — anything the
      // deletion destroys has to be in here.
      sql`SELECT * FROM song_arrangements WHERE artist_id = ${band.id} ORDER BY song_id, id`,
      sql`SELECT * FROM gigs WHERE artist_id = ${band.id} ORDER BY id`,
      sql`SELECT * FROM setlists WHERE artist_id = ${band.id} ORDER BY id`,
      sql`
        SELECT ss.* FROM setlist_songs ss
        JOIN setlists s ON ss.setlist_id = s.id
        WHERE s.artist_id = ${band.id}
        ORDER BY ss.setlist_id, ss.position
      `,
      sql`SELECT * FROM venues WHERE artist_id = ${band.id} ORDER BY id`,
      sql`SELECT * FROM organizers WHERE artist_id = ${band.id} ORDER BY id`,
      sql`SELECT * FROM gema_works WHERE artist_id = ${band.id} ORDER BY id`,
      sql`
        SELECT r.* FROM gema_rightholders r
        JOIN gema_works gw ON gw.id = r.gema_work_id
        WHERE gw.artist_id = ${band.id}
        ORDER BY r.gema_work_id, r.id
      `,
      sql`SELECT * FROM song_logs WHERE artist_id = ${band.id} ORDER BY id`,
      // The person's own account (Art. 15/20 GDPR): every workspace their address
      // belongs to, never hashes or tokens. The demo session has no user row.
      req.user.id === null ? [] : sql`
        SELECT a.slug AS workspace, a.name AS workspace_name, u.email, u.role,
               u.pending_email, u.created_at, (u.password_hash IS NOT NULL) AS has_password
        FROM users me
        JOIN users u   ON u.email = me.email
        JOIN artists a ON a.id = u.artist_id
        WHERE me.id = ${req.user.id}
        ORDER BY a.name
      `,
      // Who else is in the band: admins only, as on the members page.
      req.user.role === 'admin'
        ? sql`SELECT email, role, created_at FROM users WHERE artist_id = ${band.id} ORDER BY id`
        : [],
    ]);
    const date = new Date().toISOString().slice(0, 10);
    const safeSlug = String(slug ?? 'artist').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'artist';
    // config carries the band's own settings (displayFields, platforms, logo) —
    // destroyed with the artists row, and not reconstructible from any other table.
    const tables = { artist: [{ slug: band.slug, name: band.name, config: band.config }], account, members, songs, song_arrangements, gigs, setlists, setlist_songs, venues, organizers, gema_works, gema_rightholders, song_logs };
    const files = {};
    for (const [name, all] of Object.entries(tables)) {
      // The CSVs drop the `deleted` column, so soft-deleted rows would read as live.
      const rows = all.filter(r => r.deleted !== true);
      if (rows.length) files[`${name}.csv`] = toCsv(rows);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}-export-${date}.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    return res.send(buildZip(files));
  }

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
    // Existence and ownership checks are independent of each other.
    const [[setlist], songsOk, gigOk] = await Promise.all([
      sql`SELECT id FROM setlists WHERE id = ${setlistId} AND artist_id = ${band.id}`,
      ownsSongs(sql, band.id, validIds),
      ownsGig(sql, band.id, gigId),
    ]);
    if (!setlist) return res.status(404).json({ error: 'Setlist not found' });
    if (!songsOk) return res.status(400).json({ error: 'Invalid song_ids' });
    if (!gigOk)   return res.status(400).json({ error: 'Invalid gig_id' });

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
        || await checkRateLimit(`share-ip:${clientIp(req)}`, 30, 3600))
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
