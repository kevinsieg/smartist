const bcrypt = require('bcryptjs');
const { getArtist } = require('./_db');
const { verifyMagicToken } = require('./_token');

async function checkCredentials(token, artist) {
  return verifyMagicToken(token, artist.password_hash) ||
         await bcrypt.compare(token, artist.password_hash);
}

async function requireAuth(req, res, slug) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const artist = await getArtist(slug);
  if (!artist) {
    res.status(404).json({ error: 'Artist not found' });
    return null;
  }
  if (!await checkCredentials(token, artist)) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return artist;
}

module.exports = { requireAuth, checkCredentials };
