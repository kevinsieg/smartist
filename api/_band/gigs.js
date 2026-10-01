const crypto = require('crypto');
const { getDb, getSlug, parsePage } = require('../_db');
const { requireAuth, getAccess, canBrowseCatalogue, refuseDemo } = require('../_auth');
const { wrap } = require('../_handler');
const { parseFields } = require('../_validate');
const { GIG_FIELDS } = require('../_domain/records');
const { createPresignedUrl, deleteFromR2, verifyUpload, keyFromUrl } = require('../_r2');
const { ownsVenue, ownsOrganizer } = require('../_ownership');

// venue_id / organizer_id come from the body; both must be this artist's rows.
async function refsOwned(sql, artistId, body) {
  const [venueOk, organizerOk] = await Promise.all([
    ownsVenue(sql, artistId, body.venue_id ?? null),
    ownsOrganizer(sql, artistId, body.organizer_id ?? null),
  ]);
  return { venueOk, organizerOk };
}

async function checkRefs(sql, artistId, body, res) {
  const { venueOk, organizerOk } = await refsOwned(sql, artistId, body);
  if (!venueOk) {
    res.status(400).json({ error: 'Invalid venue_id' }); return false;
  }
  if (!organizerOk) {
    res.status(400).json({ error: 'Invalid organizer_id' }); return false;
  }
  return true;
}

// One gig: /api/:artist/gigs/:id is rewritten to /api/:artist/gigs?id=:id so both live in
// a single serverless function (Hobby plan allows 12, and all 12 are in use).
const POSTER_MAX_BYTES = 5 * 1024 * 1024;

// Sub-resources of one gig: the poster, and the upload URLs for it.
const GIG_SUBS = { 'poster-url': ['POST'], poster: ['PUT', 'DELETE'] };

async function handleOneGig(req, res, { slug, sql, gigId }) {
  const { sub } = req.query;
  if (sub !== undefined) {
    if (!GIG_SUBS[sub]) return res.status(404).json({ error: 'Not found' });
    if (!GIG_SUBS[sub].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.method === 'GET') {
      const { artist, user } = await getAccess(req, slug);
      if (!artist) return res.status(404).json({ error: 'Artist not found' });
      if (!user && !canBrowseCatalogue(artist))
        return res.status(401).json({ error: 'Sign in to view this' });
      // The gig, and with ?refs its setlists and their songs: every query is
      // scoped by gig id and band, so none needs another's result first.
      const [[row], setlists, setlistSongs] = await Promise.all([
        sql`
          SELECT g.*, v.name AS venue_name, v.city AS venue_city,
                 o.name AS organizer_name, o.city AS organizer_city
          FROM gigs g
          LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
          LEFT JOIN organizers o ON o.id = g.organizer_id AND o.artist_id = g.artist_id
          WHERE g.id = ${gigId} AND g.artist_id = ${artist.id}
            ${user ? sql`` : sql`AND g.deleted = false`}
        `,
        req.query.refs ? sql`
          SELECT id, title FROM setlists
          WHERE gig_id = ${gigId} AND artist_id = ${artist.id}
          ORDER BY id DESC
        ` : [],
        req.query.refs ? sql`
          SELECT ss.setlist_id, ss.position, s.title
          FROM setlists sl
          JOIN setlist_songs ss ON ss.setlist_id = sl.id
          JOIN songs s ON s.id = ss.song_id AND s.artist_id = sl.artist_id
          WHERE sl.gig_id = ${gigId} AND sl.artist_id = ${artist.id}
          ORDER BY ss.setlist_id, ss.position
        ` : [],
      ]);
      if (!row) return res.status(404).json({ error: 'Gig not found' });
      const { venue_city, organizer_city, ...fields } = row;
      let gig = fields;
      // Public visitors never see the private gig comment, nor who booked the
      // gig: organizers are private CRM data like venues' contacts.
      if (!user) {
        const { comment: _c, organizer_id: _o, organizer_name: _n, ...rest } = gig;
        gig = rest;
      }
      if (req.query.refs) {
        // Venue and organizer come from the gig's own joins (both scoped).
        const venue = row.venue_name != null
          ? { id: row.venue_id, name: row.venue_name, city: venue_city } : null;
        const organizer = user && row.organizer_name != null
          ? { id: row.organizer_id, name: row.organizer_name, city: organizer_city } : null;
        return res.json({ gig, refs: { setlists, setlistSongs, venue, organizer } });
      }
      return res.json(gig);
    }

    const artist = await requireAuth(req, res, slug, 'member');
    if (!artist) return;
    // A PUT's fields are validated first; its venue/organizer ownership checks
    // don't depend on the gig row, so they run alongside it.
    const isUpdate = req.method === 'PUT' && req.query.sub !== 'poster';
    const parsed = isUpdate ? parseFields(req.body, GIG_FIELDS, { partial: true }) : null;
    if (parsed?.error) return res.status(400).json({ error: parsed.error });
    const [[gig], refs] = await Promise.all([
      sql`SELECT * FROM gigs WHERE id = ${gigId} AND artist_id = ${artist.id}`,
      isUpdate ? refsOwned(sql, artist.id, parsed.value) : null,
    ]);
    if (!gig) return res.status(404).json({ error: 'Gig not found' });

    // ── POST /gigs/:id/poster-url — get presigned upload URLs ──────────────────
    if (req.method === 'POST' && req.query.sub === 'poster-url') {
      if (refuseDemo(req, res)) return;
      const { contentType, posterSize, thumbSize } = req.body ?? {};
      const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
      if (!allowed.has(contentType))
        return res.status(400).json({ error: 'Only JPEG, PNG, or WebP images are supported' });
      // The sizes are signed into the upload URLs, so nothing larger can be
      // parked in the bucket through them (posters do not count towards the cap).
      const okSize = n => Number.isInteger(n) && n > 0 && n <= POSTER_MAX_BYTES;
      if (!okSize(posterSize) || !okSize(thumbSize))
        return res.status(400).json({ error: `posterSize and thumbSize required, max ${POSTER_MAX_BYTES / 1024 / 1024} MB` });
      const uuid      = crypto.randomUUID();
      const posterKey = `gigs/${artist.slug}/${gigId}-${uuid}-poster.jpg`;
      const thumbKey  = `gigs/${artist.slug}/${gigId}-${uuid}-thumb.jpg`;
      const [poster, thumb] = await Promise.all([
        createPresignedUrl(posterKey, 'image/jpeg', posterSize),
        createPresignedUrl(thumbKey,  'image/jpeg', thumbSize),
      ]);
      return res.json({
        posterUploadUrl: poster.uploadUrl,
        posterPublicUrl: poster.publicUrl,
        thumbUploadUrl:  thumb.uploadUrl,
        thumbPublicUrl:  thumb.publicUrl,
      });
    }

    // ── PUT /gigs/:id/poster — confirm upload, save to DB ──────────────────────
    if (req.method === 'PUT' && req.query.sub === 'poster') {
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
      if (!refs.venueOk)     return res.status(400).json({ error: 'Invalid venue_id' });
      if (!refs.organizerOk) return res.status(400).json({ error: 'Invalid organizer_id' });
      // Only the fields sent are written; an empty value clears one.
      const value = parsed.value;
      if (!Object.keys(value).length) return res.json(gig);
      const [updated] = await sql`
        UPDATE gigs SET ${sql(value)}, last_updated = NOW()
        WHERE id = ${gigId} AND artist_id = ${artist.id}
        RETURNING *
      `;
      return res.json(updated);
    }

    // ── DELETE /gigs/:id/poster — remove poster files and clear DB ─────────────
    if (req.method === 'DELETE' && req.query.sub === 'poster') {
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

  const rawId = req.query.id;
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

    // ?slim=1: every gig of the band, unpaged, with only what a picker or a
    // filter shows. The paged list stops at 200 rows, and a picker built from
    // it dropped older gigs — saving a setlist then unlinked its gig. Deleted
    // gigs are included (flagged) so a setlist linked to one keeps its gig.
    if (req.query.slim) {
      if (!user) return res.status(401).json({ error: 'Sign in to view this' });
      const gigs = await sql`
        SELECT g.id, g.title, g.date, g.deleted,
               g.venue_id, v.name AS venue_name, v.city AS venue_city,
               g.organizer_id, o.name AS organizer_name
        FROM gigs g
        LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
        LEFT JOIN organizers o ON o.id = g.organizer_id AND o.artist_id = g.artist_id
        WHERE g.artist_id = ${artist.id}
        ORDER BY g.date DESC NULLS LAST, g.id DESC
      `;
      return res.json(gigs);
    }

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
      // postgres.js hands a DATE back as a Date at UTC midnight, not as text.
      const ymd = t => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
      const events = gigs.map(g => {
        const d = ymd(g.date);
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
          dtstart = `DTSTART;VALUE=DATE:${d}`;
          dtend   = `DTEND;VALUE=DATE:${ymd(new Date(g.date).getTime() + 86400000)}`;
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
      // A signed-in request may cover a private band: never let a shared cache keep it.
      res.setHeader('Cache-Control', user ? 'private, no-store' : 'public, s-maxage=300, stale-while-revalidate=600');
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
        ${user ? sql`` : sql`AND g.deleted = false`}
      ORDER BY g.date DESC NULLS LAST, g.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const total = Number(rows[0]?.total ?? 0);
    // Public visitors never see gig comments (private notes: fees, contacts)
    // or the organizer (private CRM data).
    // Only the public variant may be CDN-cached.
    if (!user) res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return res.json({
      rows: rows.map(({ total: _, comment, organizer_id, organizer_name, ...r }) =>
        (user ? { comment, organizer_id, organizer_name, ...r } : r)),
      total, limit, offset,
    });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug, 'member');
    if (!artist) return;
    const { value, error } = parseFields(req.body, GIG_FIELDS);
    if (error) return res.status(400).json({ error });
    if (!await checkRefs(sql, artist.id, value, res)) return;
    const [gig] = await sql`INSERT INTO gigs ${sql({ ...value, artist_id: artist.id })} RETURNING *`;
    return res.status(201).json(gig);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
