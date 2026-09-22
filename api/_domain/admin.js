const { getDb } = require('../_db');
const { verifyUserToken } = require('../_token');
const { validateStr } = require('../_validate');

// Gate a request to the super-admin allowlist (SUPER_ADMIN_EMAILS). Writes the
// 401/403 response and returns false on failure; returns true when allowed.
async function requireSuperAdmin(req, res, sql) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claim = verifyUserToken(tok);
  if (!claim) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  const [u] = await sql`SELECT email FROM users WHERE id = ${claim.userId} LIMIT 1`;
  const allow = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!u || !allow.includes(String(u.email).toLowerCase())) { res.status(403).json({ error: 'Forbidden' }); return false; }
  return true;
}

// POST ?action=admin-set-plan — super-admin flips any band's plan.
async function setPlan(req, res) {
  const sql = getDb();
  if (!await requireSuperAdmin(req, res, sql)) return;
  const { plan } = req.body;
  const target = validateStr(req.body.slug, 100);
  if (!target) return res.status(400).json({ error: 'slug required' });
  if (!['free', 'pro'].includes(plan)) return res.status(400).json({ error: 'invalid plan' });
  const r = await sql`UPDATE artists SET config = config || ${{ plan }} WHERE slug = ${target} RETURNING id`;
  if (!r.length) return res.status(404).json({ error: 'Artist not found' });
  return res.json({ ok: true });
}

// GET ?action=admin-overview — global band list + usage totals (super-admin).
async function overview(req, res) {
  const sql = getDb();
  if (!await requireSuperAdmin(req, res, sql)) return;
  const bands = await sql`
    SELECT a.slug, a.name, COALESCE(a.config->>'plan','free') AS plan,
           a.config->>'upgradedAt' AS upgraded_at,
           a.storage_used_bytes,
           (SELECT count(*)::int FROM songs s WHERE s.artist_id = a.id AND NOT s.deleted) AS songs,
           (SELECT count(*)::int FROM users u WHERE u.artist_id = a.id) AS users
    FROM artists a ORDER BY a.name`;
  const totals = {
    bands: bands.length,
    storageUsedBytes: bands.reduce((n, b) => n + Number(b.storage_used_bytes || 0), 0),
    pro: bands.filter(b => b.plan === 'pro').length,
    free: bands.filter(b => b.plan !== 'pro').length,
    upgraded: bands.filter(b => b.upgraded_at).length,
  };
  return res.json({ totals, bands });
}

module.exports = { requireSuperAdmin, setPlan, overview };
