const { getDb, getArtist, getSlug, parsePage } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr } = require('../_validate');

module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  const sql = getDb();

  if (req.method === 'GET') {
    if (req.query.format === 'ics') {
      const artist = await getArtist(slug);
      if (!artist) return res.status(404).json({ error: 'Artist not found' });
      const today = new Date().toISOString().slice(0, 10);
      const gigs = await sql`
        SELECT g.*, v.name AS venue_name, v.city AS venue_city
        FROM gigs g
        LEFT JOIN venues v ON v.id = g.venue_id
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
        const desc = [
          g.type            ? `Type: ${g.type}`           : '',
          g.additional_link ? `Link: ${g.additional_link}` : '',
          g.comment         ? g.comment                    : '',
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
      LEFT JOIN venues v ON v.id = g.venue_id
      LEFT JOIN organizers o ON o.id = g.organizer_id
      WHERE g.artist_id = (SELECT id FROM artists WHERE slug = ${slug})
      ORDER BY g.date DESC NULLS LAST, g.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    if (!rows.length) {
      const [exists] = await sql`SELECT 1 FROM artists WHERE slug = ${slug} LIMIT 1`;
      if (!exists) return res.status(404).json({ error: 'Artist not found' });
    }
    const total = Number(rows[0]?.total ?? 0);
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    return res.json({ rows: rows.map(({ total: _, ...r }) => r), total, limit, offset });
  }

  if (req.method === 'POST') {
    const artist = await requireAuth(req, res, slug);
    if (!artist) return;
    const body = req.body ?? {};
    const title = validateStr(body.title, 200);
    if (title === false) return res.status(400).json({ error: 'title too long' });
    if (!title) return res.status(400).json({ error: 'title is required' });
    const comment  = validateStr(body.comment, 2000);
    if (comment  === false) return res.status(400).json({ error: 'comment too long' });
    const location = validateStr(body.location, 200);
    if (location === false) return res.status(400).json({ error: 'location too long' });
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
