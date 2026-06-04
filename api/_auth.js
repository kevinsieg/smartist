const bcrypt = require('bcryptjs');
const { getArtist, getDb } = require('./_db');
const { verifyMagicToken, verifyUserToken } = require('./_token');

const ROLE_ORDER = ['viewer', 'member', 'admin'];

async function checkCredentials(token, artist) {
  return verifyMagicToken(token, artist.password_hash) ||
         await bcrypt.compare(token, artist.password_hash);
}

async function requireAuth(req, res, slug) {
  const header = req.headers.authorization ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }

  const artist = await getArtist(slug);
  if (!artist) { res.status(404).json({ error: 'Artist not found' }); return null; }

  // New user token
  const claim = verifyUserToken(token);
  if (claim) {
    req.user = { id: claim.userId, role: claim.role };
    return artist;
  }

  // Bootstrap fallback: accept old credentials only when no users exist yet
  const sql = getDb();
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE artist_id = ${artist.id}`;
  if (count === 0 && await checkCredentials(token, artist)) {
    req.user = { id: null, role: 'admin' };
    return artist;
  }

  res.status(401).json({ error: 'Unauthorized' });
  return null;
}

function requireRole(req, res, minRole) {
  const userRole = req.user?.role || 'admin';
  if (ROLE_ORDER.indexOf(userRole) < ROLE_ORDER.indexOf(minRole)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

module.exports = { requireAuth, requireRole, checkCredentials };
