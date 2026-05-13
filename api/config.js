const { getBand, getDb } = require('./_db');
const { wrap } = require('./_handler');
const { validateEmail } = require('./_validate');
const { checkRateLimit, clientIp } = require('./_ratelimit');

module.exports = wrap(async function handler(req, res) {
  if (req.method === 'POST') {
    const email = validateEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Valid email required' });

    if (await checkRateLimit(`subscribe:${clientIp(req)}`, 5, 3600))
      return res.status(429).json({ error: 'Too many requests — try again later' });

    const sql = getDb();
    try {
      await sql`INSERT INTO subscribers (email, source) VALUES (${email}, 'landing')`;
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Already subscribed' });
      throw err;
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const slug = process.env.BAND_SLUG;
  if (!slug) return res.status(500).json({ error: 'BAND_SLUG not configured' });
  const band = await getBand(slug);
  if (!band) return res.status(404).json({ error: 'Band not found in database' });

  const sql = getDb();
  const songs = await sql`
    SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language
    FROM songs s
    LEFT JOIN LATERAL (
      SELECT iswc, gema_work_number, language
      FROM gema_works
      WHERE song_id = s.id
      ORDER BY gema_work_number
      LIMIT 1
    ) g ON true
    WHERE s.band_id = ${band.id} AND s.deleted = false
    ORDER BY s.title
  `;

  res.json({ slug: band.slug, name: band.name, config: band.config, songs });
});
