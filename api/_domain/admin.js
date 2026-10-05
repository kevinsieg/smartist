const { getDb } = require('../_db');
const { validateStr } = require('../_validate');
const { sessionAccount } = require('../_session');
const { ok, fail, MSG } = require('./http');

// Gate to the super-admin allowlist (SUPER_ADMIN_EMAILS): the failure result
// (401/403), or null when allowed.
async function superAdminDenied(sql, headers) {
  const me = await sessionAccount(sql, headers);
  if (!me) return fail(401, MSG.unauthorized);
  const allow = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.includes(String(me.email).toLowerCase())) return fail(403, MSG.forbidden);
  return null;
}

// POST /api/admin/set-plan — super-admin flips any band's plan.
async function setPlan({ headers, body }) {
  const sql = getDb();
  const denied = await superAdminDenied(sql, headers);
  if (denied) return denied;
  const { plan } = body;
  const target = validateStr(body.slug, 100);
  if (!target) return fail(400, 'slug required');
  if (!['free', 'pro'].includes(plan)) return fail(400, 'invalid plan');
  const r = await sql`UPDATE artists SET config = config || ${{ plan }} WHERE slug = ${target} RETURNING id`;
  if (!r.length) return fail(404, MSG.artistNotFound);
  return ok({ ok: true });
}

// GET /api/admin/overview — global band list + usage totals (super-admin).
async function overview({ headers }) {
  const sql = getDb();
  const denied = await superAdminDenied(sql, headers);
  if (denied) return denied;
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
  return ok({ totals, bands });
}

module.exports = { setPlan, overview };
