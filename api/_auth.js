const bcrypt = require('bcryptjs');
const { getDb, getArtist } = require('./_db');
const { verifyMagicToken, verifyUserToken } = require('./_token');

const ROLE_ORDER = ['viewer', 'member', 'admin'];

async function checkCredentials(token, artist) {
  if (!artist.password_hash) return false;
  return verifyMagicToken(token, artist.password_hash) ||
         await bcrypt.compare(token, artist.password_hash);
}

// Resolve a bearer token to { id, role } for THIS artist, or null.
// User tokens carry only userId — membership in the artist is checked via the
// email-linked users rows, so a token issued for one workspace never grants
// access to a workspace the user does not belong to. Role comes from the DB
// row (per-workspace, revocable), not from the token.
async function resolveUser(token, artist) {
  const claim = verifyUserToken(token);
  if (claim) {
    const sql = getDb();
    const [member] = await sql`
      SELECT u2.id, u2.role
      FROM users u1
      JOIN users u2 ON u2.email = u1.email
      WHERE u1.id = ${claim.userId} AND u2.artist_id = ${artist.id}
      LIMIT 1
    `;
    return member ? { id: member.id, role: member.role } : null;
  }
  if (await checkCredentials(token, artist)) return { id: null, role: 'admin' };
  return null;
}

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function requireAuth(req, res, slug, minRole = null) {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }

  const artist = await getArtist(slug);
  if (!artist) { res.status(404).json({ error: 'Artist not found' }); return null; }

  const user = await resolveUser(token, artist);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  req.user = user;

  if (minRole && !requireRole(req, res, minRole)) return null;
  return artist;
}

function requireRole(req, res, minRole) {
  const userRole = req.user?.role || 'viewer';
  if (ROLE_ORDER.indexOf(userRole) < ROLE_ORDER.indexOf(minRole)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// Resolve auth state once: { artist, user }. artist is null for unknown
// slugs; user is null when the request carries no token valid for this
// artist. Never writes to the response — for GET handlers that downgrade
// to public view mode instead of rejecting.
async function getAccess(req, slug) {
  const artist = await getArtist(slug);
  if (!artist) return { artist: null, user: null };
  const token = bearerToken(req);
  const user = token ? await resolveUser(token, artist) : null;
  return { artist, user };
}

// A workspace with config.private only serves data to authenticated members.
function isPrivate(artist) {
  return !!(artist.config && artist.config.private);
}

module.exports = { requireAuth, requireRole, checkCredentials, getAccess, isPrivate };
