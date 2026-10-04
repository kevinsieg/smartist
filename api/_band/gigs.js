const crypto = require('crypto');
const { getDb, getSlug, parsePage } = require('../_db');
const { requireAuth, getAccess, canBrowseCatalogue, refuseDemo } = require('../_auth');
const { wrap } = require('../_handler');
const { parseFields, unsafeKey } = require('../_validate');
const { GIG_FIELDS } = require('../_domain/records');
const { createPresignedUrl, deleteFromR2, verifyUpload, keyFromUrl } = require('../_r2');
const { ownsRefs } = require('../_ownership');
const { presignLimited } = require('../_ratelimit');

// venue_id / organizer_id come from the body; both must be this artist's rows.
function refsOwned(sql, artistId, body) {
  return ownsRefs(sql, artistId, { venueId: body.venue_id ?? null, organizerId: body.organizer_id ?? null });
}

async function checkRefs(sql, artistId, body, res) {
  const owned = await refsOwned(sql, artistId, body);
  if (!owned.venue) {
    res.status(400).json({ error: 'Invalid venue_id' }); return false;
  }
  if (!owned.organizer) {
    res.status(400).json({ error: 'Invalid organizer_id' }); return false;
  }
  return true;
}

// Poster files of this band's gigs, removed from the bucket. Only keys under
// the band's own gigs/<slug>/ prefix: a stored URL is just a string. Account
// deletion finds files through the rows (api/_domain/deletion.js), so a gig row
// deleted without its files left them in the bucket for good. Failures are
// not fatal; the row is already gone or cleared. The public demo session keeps
// the files: demo_reset restores the rows, not the bucket.
async function removeGigFiles(req, artist, urls) {
  if (!req.user || req.user.id === null) return;
  const prefix = `gigs/${artist.slug}/`;
  const own = urls.filter(u => typeof u === 'string' && keyFromUrl(u)?.startsWith(prefix));
  await Promise.all(own.map(u => deleteFromR2(u).catch(() => false)));
}

// The DTEND value (floating local time) of a gig that has a start time. An end
// at or before the start is after midnight, on the next day; without an end
// the gig lasts two hours, which may also cross midnight.
function icsEnd(date, timeStart, timeEnd) {
  const [y, mo, d] = new Date(date).toISOString().slice(0, 10).split('-').map(Number);
  const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const start = mins(timeStart);
  let end = timeEnd ? mins(timeEnd) : start + 120;
  if (end <= start && timeEnd) end += 24 * 60;
  const at = new Date(Date.UTC(y, mo - 1, d, 0, end));
  const p2 = n => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}${p2(at.getUTCMonth() + 1)}${p2(at.getUTCDate())}T${p2(at.getUTCHours())}${p2(at.getUTCMinutes())}00`;
}

// RFC 5545 content lines are at most 75 octets; longer ones continue on the
// next line after CRLF and a space. Splits between characters, never inside one.
function icsFold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts = [];
  let cur = '', size = 0, max = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (size + n > max) { parts.push(cur); cur = ''; size = 0; max = 74; }
    cur += ch; size += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

// The router sends /api/:artist/gigs/:id here with the id in req.query.id.
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
      // The gig, and with ?refs its setlists and their songs, in one statement.
      const [row] = await sql`
        SELECT g.*, v.name AS venue_name, v.city AS venue_city,
               o.name AS organizer_name, o.city AS organizer_city
               ${req.query.refs ? sql`,
               COALESCE((
                 SELECT json_agg(json_build_object('id', sl.id, 'title', sl.title) ORDER BY sl.id DESC)
                 FROM setlists sl
                 WHERE sl.gig_id = g.id AND sl.artist_id = g.artist_id
               ), '[]') AS ref_setlists,
               COALESCE((
                 SELECT json_agg(json_build_object('setlist_id', ss.setlist_id, 'position', ss.position, 'title', s.title)
                                 ORDER BY ss.setlist_id, ss.position)
                 FROM setlists sl
                 JOIN setlist_songs ss ON ss.setlist_id = sl.id
                 JOIN songs s ON s.id = ss.song_id AND s.artist_id = sl.artist_id
                 WHERE sl.gig_id = g.id AND sl.artist_id = g.artist_id
               ), '[]') AS ref_setlist_songs` : sql``}
        FROM gigs g
        LEFT JOIN venues v ON v.id = g.venue_id AND v.artist_id = g.artist_id
        LEFT JOIN organizers o ON o.id = g.organizer_id AND o.artist_id = g.artist_id
        WHERE g.id = ${gigId} AND g.artist_id = ${artist.id}
          ${user ? sql`` : sql`AND g.deleted = false`}
      `;
      if (!row) return res.status(404).json({ error: 'Gig not found' });
      const { venue_city, organizer_city, ref_setlists: setlists, ref_setlist_songs: setlistSongs, ...fields } = row;
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

    // ── PUT /gigs/:id — only the fields sent are written; an empty value clears one.
    // The venue/organizer check, then the update itself, which refuses a
    // deleted gig: no read of the row first. Only a refused update looks the
    // gig up, to tell "not found" from "deleted".
    if (req.method === 'PUT' && req.query.sub !== 'poster') {
      const parsed = parseFields(req.body, GIG_FIELDS, { partial: true });
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const value = parsed.value;
      const refs = await refsOwned(sql, artist.id, value);
      if (!refs.venue)     return res.status(400).json({ error: 'Invalid venue_id' });
      if (!refs.organizer) return res.status(400).json({ error: 'Invalid organizer_id' });
      const [updated] = Object.keys(value).length
        ? await sql`
            UPDATE gigs SET ${sql(value)}, last_updated = NOW()
            WHERE id = ${gigId} AND artist_id = ${artist.id} AND deleted = false
            RETURNING *`
        : await sql`SELECT * FROM gigs WHERE id = ${gigId} AND artist_id = ${artist.id} AND deleted = false`;
      if (updated) return res.json(updated);
      const [gone] = await sql`SELECT deleted FROM gigs WHERE id = ${gigId} AND artist_id = ${artist.id}`;
      if (!gone) return res.status(404).json({ error: 'Gig not found' });
      return res.status(409).json({ error: 'Gig is deleted and cannot be modified' });
    }

    const [gig] = await sql`SELECT * FROM gigs WHERE id = ${gigId} AND artist_id = ${artist.id}`;
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
      if (await presignLimited(artist.id))
        return res.status(429).json({ error: 'Too many uploads — try again later' });
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
      // This gig's own keys first: asking storage about any other key would
      // tell the caller whether that file exists.
      const expectedPrefix = `gigs/${artist.slug}/${gigId}-`;
      if (!keyFromUrl(posterUrl)?.startsWith(expectedPrefix) || unsafeKey(keyFromUrl(posterUrl)))
        return res.status(400).json({ error: 'Invalid poster URL' });
      if (!keyFromUrl(thumbUrl)?.startsWith(expectedPrefix) || unsafeKey(keyFromUrl(thumbUrl)))
        return res.status(400).json({ error: 'Invalid thumb URL' });
      const [posterOk, thumbOk] = await Promise.all([
        verifyUpload(keyFromUrl(posterUrl)),
        verifyUpload(keyFromUrl(thumbUrl)),
      ]);
      if (!posterOk) return res.status(400).json({ error: 'Poster file not found in storage' });
      if (!thumbOk)  return res.status(400).json({ error: 'Thumbnail file not found in storage' });
      if (posterOk.contentType !== 'image/jpeg')
        return res.status(400).json({ error: 'Poster must be a JPEG image' });
      if (thumbOk.contentType !== 'image/jpeg')
        return res.status(400).json({ error: 'Thumbnail must be a JPEG image' });
      await sql`
        UPDATE gigs
        SET poster_url = ${posterUrl}, thumb_url = ${thumbUrl}, last_updated = NOW()
        WHERE id = ${gigId} AND artist_id = ${artist.id}
      `;
      // The files this one replaces go once the new ones are saved. A retried
      // confirm sends the URLs already stored: those are the live files, not
      // old ones, and deleting them left the gig pointing at nothing.
      await removeGigFiles(req, artist, [
        gig.poster_url !== posterUrl ? gig.poster_url : null,
        gig.thumb_url  !== thumbUrl  ? gig.thumb_url  : null,
      ]);
      return res.json({ ok: true, posterUrl, thumbUrl });
    }

    // ── DELETE /gigs/:id/poster — remove poster files and clear DB ─────────────
    if (req.method === 'DELETE' && req.query.sub === 'poster') {
      await sql`
        UPDATE gigs
        SET poster_url = NULL, thumb_url = NULL, last_updated = NOW()
        WHERE id = ${gigId} AND artist_id = ${artist.id}
      `;
      await removeGigFiles(req, artist, [gig.poster_url, gig.thumb_url]);
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
      await removeGigFiles(req, artist, [gig.poster_url, gig.thumb_url]);
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
        return (s || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n|\r/g,'\\n');
      }
      // postgres.js hands a DATE back as a Date at UTC midnight, not as text.
      const ymd = t => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
      const events = gigs.map(g => {
        const d = ymd(g.date);
        let dtstart, dtend;
        if (g.time_start) {
          dtstart = `DTSTART:${d}T${g.time_start.slice(0, 5).replace(':', '')}00`;
          dtend   = `DTEND:${icsEnd(g.date, g.time_start, g.time_end)}`;
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
        ].filter(Boolean).join('\n');
        return ['BEGIN:VEVENT', `UID:gig-${g.id}@smartist`, `DTSTAMP:${now}`,
          dtstart, dtend, `SUMMARY:${esc(g.title)}`,
          loc  ? `LOCATION:${esc(loc)}`    : '',
          desc ? `DESCRIPTION:${esc(desc)}` : '',
          'END:VEVENT'].filter(Boolean).map(icsFold).join('\r\n');
      });
      const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Smartist//EN',
        'CALSCALE:GREGORIAN','METHOD:PUBLISH',
        icsFold(`X-WR-CALNAME:${esc(artist.name)} — Upcoming Gigs`),
        ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}-gigs.ics"`);
      // A signed-in request may cover a private band: never let a shared cache keep it.
      res.setHeader('Cache-Control', user ? 'private, no-store' : 'public, s-maxage=300, stale-while-revalidate=600');
      return res.end(ics);
    }

    const { limit, offset } = parsePage(req);
    // Members also get each gig's setlist titles: the "has setlist" button and
    // the setlist filter, without loading every setlist of the band.
    const rows = await sql`
      SELECT g.*,
             v.name AS venue_name,
             o.name AS organizer_name,
             ${user ? sql`ARRAY(
               SELECT COALESCE(sl.title, '') FROM setlists sl
               WHERE sl.gig_id = g.id AND sl.artist_id = g.artist_id
               ORDER BY sl.id) AS setlist_titles,` : sql``}
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
      rows: rows.map(({ total: _, comment, organizer_id, organizer_name, setlist_titles, ...r }) =>
        (user ? { comment, organizer_id, organizer_name, setlist_titles, ...r } : r)),
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

module.exports.icsEnd = icsEnd;
module.exports.icsFold = icsFold;
module.exports.removeGigFiles = removeGigFiles;
