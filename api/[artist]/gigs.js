const crypto = require('crypto');
const { getDb, getSlug, parsePage } = require('../_db');
const { requireAuth, getAccess, canBrowseCatalogue } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr } = require('../_validate');
const { createPresignedUrl, deleteFromR2, verifyUpload, keyFromUrl } = require('../_r2');
const { ownsVenue, ownsOrganizer } = require('../_ownership');

// venue_id / organizer_id come from the body; both must be this artist's rows.
async function checkRefs(sql, artistId, body, res) {
  if (!await ownsVenue(sql, artistId, body.venue_id ?? null)) {
    res.status(400).json({ error: 'Invalid venue_id' }); return false;
  }
  if (!await ownsOrganizer(sql, artistId, body.organizer_id ?? null)) {
    res.status(400).json({ error: 'Invalid organizer_id' }); return false;
  }
  return true;
}

// One gig: /api/:artist/gigs/:id is rewritten to /api/:artist/gigs?id=:id so both live in
// a single serverless function (Hobby plan allows 12, and all 12 are in use).
async function handleOneGig(req, res, { slug, sql, gigId }) {
  if (req.method === 'GET') {
      const { artist, user } = await getAccess(req, slug);
      if (!artist) return res.status(404).json({ error: 'Artist not found' });
      if (!user && !canBrowseCatalogue(artist))
        return res.status(401).json({ error: 'Sign in to view this' });
      let [gig] = await sql`
        SELECT g.*, v.name AS venue_name, o.name AS organizer_name
        FROM gigs g
        LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
        LEFT JOIN organizers o ON o.id = g.organizer_id AND o.artist_id = g.artist_id
        WHERE g.id = ${gigId} AND g.artist_id = ${artist.id}
      `;
      if (!gig) return res.status(404).json({ error: 'Gig not found' });
      // Public visitors never see the private gig comment.
      if (!user) { const { comment: _, ...rest } = gig; gig = rest; }
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
              JOIN songs s ON s.id = ss.song_id AND s.artist_id = ${artist.id}
              WHERE ss.setlist_id = ANY(${setlistIds}::int[])
              ORDER BY ss.setlist_id, ss.position
            `
          : [];
        return res.json({ gig, refs: { setlists, setlistSongs, venue, organizer } });
      }
      return res.json(gig);
    }

    const artist = await requireAuth(req, res, slug, 'member');
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
      if (gig.deleted) return res.status(409).json({ error: 'Gig is deleted and cannot be modified' });
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
      if (!await checkRefs(sql, artist.id, body, res)) return;
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
      await sql.begin(async tx => {
        if (cascade?.includes('setlists')) {
          await tx`DELETE FROM setlists WHERE gig_id = ${gigId} AND artist_id = ${artist.id}`;
        }
        await tx`DELETE FROM gigs WHERE id = ${gigId} AND artist_id = ${artist.id}`;
      });
      return res.json({ deleted: true, hard: true });
    }
}

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  // vercel dev does not always populate req.query for rewrites, so fall back to the path.
  const rawId = req.query.id ?? req.url.split('?')[0].split('/gigs/')[1];
  if (rawId !== undefined && rawId !== '') {
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });
    const gigId = Number(rawId);
    if (!Number.isInteger(gigId) || gigId <= 0) return res.status(400).json({ error: 'Invalid gig id' });
    return handleOneGig(req, res, { slug, sql, gigId });
  }

  if (req.method === 'GET') {
    const { artist, user } = await getAccess(req, slug);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    if (!user && !canBrowseCatalogue(artist))
      return res.status(401).json({ error: 'Sign in to view this' });

    if (req.query.format === 'ics') {
      const today = new Date().toISOString().slice(0, 10);
      const gigs = await sql`
        SELECT g.*, v.name AS venue_name, v.city AS venue_city
        FROM gigs g
        LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
        WHERE g.artist_id = ${artist.id}
          AND g.deleted = false AND g.date >= ${today}
        ORDER BY g.date ASC, g.time_start ASC NULLS LAST
      `;
      const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
      function esc(s) {
        return (s || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
      }
      const events = gigs.map(g => {
        const d = String(g.date).slice(0, 10).replace(/-/g, '');
        let dtstart, dtend;
        if (g.time_start) {
          const ts = g.time_start.slice(0, 5).replace(':', '');
          dtstart = `DTSTART:${d}T${ts}00`;
          if (g.time_end) {
            dtend = `DTEND:${d}T${g.time_end.slice(0, 5).replace(':', '')}00`;
          } else {
            const h = (Number(ts.slice(0, 2)) + 2) % 24;
            dtend = `DTEND:${d}T${String(h).padStart(2,'0')}${ts.slice(2)}00`;
          }
        } else {
          const next = new Date(g.date); next.setDate(next.getDate() + 1);
          dtstart = `DTSTART;VALUE=DATE:${d}`;
          dtend   = `DTEND;VALUE=DATE:${next.toISOString().slice(0,10).replace(/-/g,'')}`;
        }
        const loc  = [g.venue_name, g.venue_city].filter(Boolean).join(', ');
        // No comments here: the feed URL is guessable (webcal can't auth),
        // so private gig notes must never appear in it.
        const desc = [
          g.type            ? `Type: ${g.type}`           : '',
          g.additional_link ? `Link: ${g.additional_link}` : '',
        ].filter(Boolean).join('\\n');
        return ['BEGIN:VEVENT', `UID:gig-${g.id}@smartist`, `DTSTAMP:${now}`,
          dtstart, dtend, `SUMMARY:${esc(g.title)}`,
          loc  ? `LOCATION:${esc(loc)}`    : '',
          desc ? `DESCRIPTION:${esc(desc)}` : '',
          'END:VEVENT'].filter(Boolean).join('\r\n');
      });
      const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Smartist//EN',
        'CALSCALE:GREGORIAN','METHOD:PUBLISH',
        `X-WR-CALNAME:${esc(artist.name)} — Upcoming Gigs`,
        ...events, 'END:VCALENDAR'].join('\r\n');
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}-gigs.ics"`);
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      return res.end(ics);
    }

    const { limit, offset } = parsePage(req);
    const rows = await sql`
      SELECT g.*,
             v.name AS venue_name,
             o.name AS organizer_name,
             COUNT(*) OVER() AS total
      FROM gigs g
      LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
      LEFT JOIN organizers o ON o.id = g.organizer_id AND o.artist_id = g.artist_id
      WHERE g.artist_id = ${artist.id}
      ORDER BY g.date DESC NULLS LAST, g.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const total = Number(rows[0]?.total ?? 0);
    // Public visitors never see gig comments (private notes: fees, contacts).
    // Only the public variant may be CDN-cached.
    if (!user) res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return res.json({
      rows: rows.map(({ total: _, comment, ...r }) => (user ? { comment, ...r } : r)),
      total, limit, offset,
    });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug, 'member');
    if (!artist) return;
    const body = req.body ?? {};
    const title = validateStr(body.title, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title is required' });
    const comment  = validateStr(body.comment, 2000);
    if (comment  === false) return res.status(400).json({ error: 'comment too long' });
    const location = validateStr(body.location, 200);
    if (location === false) return res.status(400).json({ error: 'location too long' });
    if (!await checkRefs(sql, artist.id, body, res)) return;
    const [gig] = await sql`
      INSERT INTO gigs (artist_id, title, date, venue_id, organizer_id, type, time_start, time_end, additional_link, additional_text, comment, location)
      VALUES (
        ${artist.id}, ${title}, ${body.date ?? null},
        ${body.venue_id ?? null}, ${body.organizer_id ?? null},
        ${body.type ?? null}, ${body.time_start ?? null}, ${body.time_end ?? null},
        ${body.additional_link ?? null}, ${body.additional_text ?? null}, ${comment ?? null}, ${location ?? null}
      )
      RETURNING *
    `;
    return res.status(201).json(gig);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
