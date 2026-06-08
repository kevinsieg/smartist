const RESERVED_SLUGS = new Set([
  'login', 'signup', 'onboarding', 'home', 'demo', 'impressum', 'api', 'app',
  'auth', 'callback', 'static', 'favicon_io',
]);

async function resolveArtist(slug, sql) {
  const s = slug || process.env.ARTIST_SLUG || '';
  if (!s) return null;
  const [row] = await sql`SELECT id, slug, name, config, password_hash FROM artists WHERE slug = ${s} LIMIT 1`;
  return row || null;
}

async function isSlugAvailable(slug, sql) {
  if (RESERVED_SLUGS.has(slug)) return false;
  const [row] = await sql`SELECT COUNT(*)::int AS count FROM artists WHERE slug = ${slug}`;
  return Number(row.count) === 0;
}

async function getArtistsForUser(userId, sql) {
  return sql`
    SELECT a.slug, a.name, u.role
    FROM users u
    JOIN artists a ON a.id = u.artist_id
    WHERE u.id = ${userId}
    ORDER BY a.name
  `;
}

module.exports = { resolveArtist, isSlugAvailable, getArtistsForUser };
