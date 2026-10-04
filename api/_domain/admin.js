const { getDb } = require('../_db');
const { verifyUserToken, sessionValid } = require('../_token');
const { validateStr } = require('../_validate');
const { sessionRowId } = require('../_auth');
const { ok, fail } = require('./http');

// Gate to the super-admin allowlist (SUPER_ADMIN_EMAILS): the failure result
// (401/403), or null when allowed.
async function superAdminDenied(headers, sql) {
  const tok = (headers.authorization || '').replace(/^Bearer /, '');
  const claim = verifyUserToken(tok);
  if (!claim) return fail(401, 'Unauthorized');
  const [u] = await sql`SELECT email, password_hash, sessions_valid_after FROM users WHERE id = ${sessionRowId(sql, claim)} LIMIT 1`;
  if (u && !sessionValid(claim, u)) return fail(401, 'Unauthorized');
  const allow = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!u || !allow.includes(String(u.email).toLowerCase())) return fail(403, 'Forbidden');
  return null;
}

// POST ?action=admin-set-plan — super-admin flips any band's plan.
async function setPlan({ headers, body }) {
  const sql = getDb();
  const denied = await superAdminDenied(headers, sql);
  if (denied) return denied;
  const { plan } = body;
  const target = validateStr(body.slug, 100);
  if (!target) return fail(400, 'slug required');
  if (!['free', 'pro'].includes(plan)) return fail(400, 'invalid plan');
  const r = await sql`UPDATE artists SET config = config || ${{ plan }} WHERE slug = ${target} RETURNING id`;
  if (!r.length) return fail(404, 'Artist not found');
  return ok({ ok: true });
}

// GET ?action=admin-overview — global band list + usage totals (super-admin).
async function overview({ headers }) {
  const sql = getDb();
  const denied = await superAdminDenied(headers, sql);
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

module.exports = { superAdminDenied, setPlan, overview };
