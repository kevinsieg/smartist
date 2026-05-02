const { getDb, getBand } = require('../../_db');
const { requireAuth } = require('../../_auth');
const { wrap } = require('../../_handler');
const { validateStr } = require('../../_validate');

module.exports = wrap(async function handler(req, res) {
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  const { band: slug, id } = req.query;
  const gigId = Number(id);
  if (!Number.isInteger(gigId) || gigId <= 0)
    return res.status(400).json({ error: 'Invalid gig id' });

  let band;
  if (req.method === 'PUT') {
    band = await requireAuth(req, res, slug);
    if (!band) return;
  } else {
    band = await getBand(slug);
    if (!band) return res.status(404).json({ error: 'Band not found' });
  }

  const sql = getDb();

  const [gig] = await sql`SELECT * FROM gigs WHERE id = ${gigId} AND band_id = ${band.id}`;
  if (!gig) return res.status(404).json({ error: 'Gig not found' });

  if (req.method === 'GET') return res.json(gig);

  // PUT — update gig details
  const { name: rawName, date, venue: rawVenue, notes: rawNotes } = req.body ?? {};
  const name = validateStr(rawName, 200);
  if (name === false) return res.status(400).json({ error: 'name too long' });
  if (!name) return res.status(400).json({ error: 'name required' });
  const venue = validateStr(rawVenue, 200);
  if (venue === false) return res.status(400).json({ error: 'venue too long' });
  const notes = validateStr(rawNotes, 2000);
  if (notes === false) return res.status(400).json({ error: 'notes too long' });

  const [updated] = await sql`
    UPDATE gigs
    SET name  = ${name},
        date  = ${date  || null},
        venue = ${venue},
        notes = ${notes}
    WHERE id = ${gigId} AND band_id = ${band.id}
    RETURNING *
  `;
  res.json(updated);
});
