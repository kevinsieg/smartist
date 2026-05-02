const bcrypt = require('bcryptjs');
const { getBand } = require('./_db');
const { verifyMagicToken } = require('./_token');

async function checkCredentials(token, band) {
  return verifyMagicToken(token, band.password_hash) ||
         await bcrypt.compare(token, band.password_hash);
}

async function requireAuth(req, res, slug) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const band = await getBand(slug);
  if (!band) {
    res.status(404).json({ error: 'Band not found' });
    return null;
  }
  if (!await checkCredentials(token, band)) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return band;
}

module.exports = { requireAuth, checkCredentials };
