const { getDb, getSlug } = require('../_db');
const { requireAuth } = require('../_auth');
const { wrap } = require('../_handler');
const { requireFeature } = require('../_plans');
const { checkRateLimit } = require('../_ratelimit');
const { importWorks, importRightholders } = require('../_domain/gema');

// POST /api/:artist/gema/import — one GEMA CSV export (works, ids or
// rightholders) into gema_works / gema_rightholders.
module.exports = wrap(async function handler(req, res) {
  const slug = getSlug(req);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const band = await requireAuth(req, res, slug, 'member');
  if (!band) return;
  if (!requireFeature(res, band, 'pro-import')) return;

  const { type, csv, dryRun = false, ownerIpNameNumber } = req.body || {};
  if (!type || !['info', 'ids', 'beteiligte'].includes(type))
    return res.status(400).json({ error: 'type must be "info", "ids", or "beteiligte"' });
  if (typeof csv !== 'string' || csv.length < 10)
    return res.status(400).json({ error: 'csv must be a non-empty string' });
  if (csv.length > 5_000_000)
    return res.status(400).json({ error: 'CSV too large (max 5 MB)' });

  // Each call parses up to 5 MB and writes a batch; a page run is a handful.
  if (await checkRateLimit(`gema-import:${band.id}`, 30, 600))
    return res.status(429).json({ error: 'Too many imports — try again in a few minutes' });

  const sql = getDb();
  const result = type === 'beteiligte'
    ? await importRightholders(sql, band, csv, { dryRun })
    : await importWorks(sql, band, type, csv, { dryRun, ownerIpNameNumber });
  return res.status(result.status).json(result.body);
});
