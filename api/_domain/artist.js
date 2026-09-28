const RESERVED_SLUGS = new Set([
  'login', 'signup', 'onboarding', 'home', 'demo', 'impressum', 'api', 'app',
  'auth', 'callback', 'static', 'favicon_io', 'stage', 'contact',
]);

async function resolveArtist(slug, sql) {
  const s = slug || process.env.ARTIST_SLUG || '';
  if (!s) return null;
  const [row] = await sql`SELECT id, slug, name, config FROM artists WHERE slug = ${s} LIMIT 1`;
  return row || null;
}

async function isSlugAvailable(slug, sql) {
  if (RESERVED_SLUGS.has(slug)) return false;
  const [row] = await sql`SELECT EXISTS(SELECT 1 FROM artists WHERE slug = ${slug}) AS exists`;
  return !row.exists;
}

async function getArtistsForUser(userId, sql) {
  return await sql`
    SELECT a.slug, a.name, u.role
    FROM users u
    JOIN artists a ON a.id = u.artist_id
    WHERE u.email = (SELECT email FROM users WHERE id = ${userId})
    ORDER BY a.name
  `;
}

module.exports = { resolveArtist, isSlugAvailable, getArtistsForUser };
