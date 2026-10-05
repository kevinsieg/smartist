const RESERVED_SLUGS = new Set([
  'login', 'signup', 'onboarding', 'home', 'demo', 'impressum', 'api', 'app',
  'auth', 'callback', 'static', 'favicon_io', 'stage', 'contact', 'privacy',
  // Global pages: vercel.json serves these paths before /:slug.
  'workspaces', 'profile', 'admin', 'confirm-email',
]);

// What a workspace URL may be: lower case letters, digits and hyphens, 3 to 50
// characters, not starting with a hyphen.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,49}$/;

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

module.exports = { SLUG_RE, isSlugAvailable, getArtistsForUser };
