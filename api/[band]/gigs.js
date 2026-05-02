const { getDb, getBand } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { validateStr } = require('../_validate');

module.exports = wrap(async function handler(req, res) {
  const { band: slug } = req.query;
  const sql = getDb();

  if (req.method === 'GET') {
    const band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
    const gigs = await sql`
      SELECT * FROM gigs
      WHERE band_id = ${band.id}
      ORDER BY date DESC NULLS LAST, id DESC
    `;
    return res.json(gigs);
  }

  if (req.method === 'POST') {
    const band = await requireAuth(req, res, slug);
    if (!band) return;
    const { name: rawName, date, venue: rawVenue, notes: rawNotes } = req.body ?? {};
    const name = validateStr(rawName, 200);
    if (name === false) return res.status(400).json({ error: 'name too long' });
    if (!name) return res.status(400).json({ error: 'name is required' });
    const venue = validateStr(rawVenue, 200);
    if (venue === false) return res.status(400).json({ error: 'venue too long' });
    const notes = validateStr(rawNotes, 2000);
    if (notes === false) return res.status(400).json({ error: 'notes too long' });
    const [gig] = await sql`
      INSERT INTO gigs (band_id, name, date, venue, notes)
      VALUES (${band.id}, ${name}, ${date ?? null}, ${venue}, ${notes})
      RETURNING *
    `;
    return res.status(201).json(gig);
  }

  res.status(405).json({ error: 'Method not allowed' });
});
