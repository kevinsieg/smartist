const bcrypt = require('bcryptjs');
const { getArtist, getDb } = require('./_db');
const { verifyMagicToken, verifyUserToken } = require('./_token');

const ROLE_ORDER = ['viewer', 'member', 'admin'];

async function checkCredentials(token, artist) {
  return verifyMagicToken(token, artist.password_hash) ||
         await bcrypt.compare(token, artist.password_hash);
}

async function isBootstrapAuthEnabled(sql, artistId) {
  const [row] = await sql`
    SELECT COUNT(*)::int AS count
    FROM users
    WHERE artist_id = ${artistId}
      AND password_hash IS NOT NULL
  `;
  return Number(row?.count || 0) === 0;
}

async function getTokenUser(sql, artistId, claim) {
  const userId = Number(claim?.userId);
  if (!Number.isInteger(userId) || userId <= 0) return null;

  const [user] = await sql`
    SELECT id, role
    FROM users
    WHERE id = ${userId}
      AND artist_id = ${artistId}
      AND password_hash IS NOT NULL
  `;
  return user || null;
}

async function requireAuth(req, res, slug, minRole = null) {
  const header = req.headers.authorization ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }

  const artist = await getArtist(slug);
  if (!artist) { res.status(404).json({ error: 'Artist not found' }); return null; }
  const sql = getDb();

  const claim = verifyUserToken(token);
  if (claim) {
    const user = await getTokenUser(sql, artist.id, claim);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    req.user = { id: user.id, role: user.role };
  } else if (await isBootstrapAuthEnabled(sql, artist.id) && await checkCredentials(token, artist)) {
    req.user = { id: null, role: 'admin' };
  } else {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

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

module.exports = { requireAuth, requireRole, checkCredentials, isBootstrapAuthEnabled };
