const bcrypt = require('bcryptjs');
const { getDb } = require('../_db');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { generateUserToken, TTL_8H, TTL_30D } = require('../_token');
const { getArtistsForUser } = require('./artist');
const logger = require('../_logger');

// Log in without naming a band.
//
// `/api/:artist/auth` needs the slug in the URL, which a deployment pinned to
// one band gets from ARTIST_SLUG and a workspace URL gets from its path. At the
// root of a multi-tenant deployment there is neither, so there was no way in at
// all: the form posted to `/api//auth`.
//
// Email is the cross-workspace identity (the same address can be a user of
// several bands, see getArtistsForUser), so the address alone is enough to find
// the account. The OAuth callback already logs people in this way.
//
// The same person may hold different passwords on different bands, so every row
// for that address is checked and the first whose hash matches wins.
const MAX_CANDIDATES = 10;

async function passwordLogin(req, res) {
  const { email, password, rememberMe } = req.body ?? {};
  const clean = String(email ?? '').trim().toLowerCase();
  if (!clean || !password) return res.status(400).json({ error: 'Email and password required' });
  if (String(password).length > 1000) return res.status(400).json({ error: 'Invalid' });

  if (await checkRateLimit(`auth:${clientIp(req)}`, 10, 60))
    return res.status(429).json({ error: 'Too many attempts — try again later' });

  const sql = getDb();
  const candidates = await sql`
    SELECT id, role, password_hash
    FROM users
    WHERE email = ${clean} AND password_hash IS NOT NULL
    ORDER BY id
    LIMIT ${MAX_CANDIDATES}
  `;

  let user = null;
  for (const row of candidates) {
    if (await bcrypt.compare(password, row.password_hash)) { user = row; break; }
  }
  // One message for an unknown address and a wrong password alike — otherwise
  // this endpoint tells anyone which emails have accounts.
  if (!user) {
    await logger.info('login_failed', { email: clean });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token   = generateUserToken(user.id, user.role, rememberMe ? TTL_30D : TTL_8H);
  const artists = await getArtistsForUser(user.id, sql);
  await logger.info('login', { email: clean, artists: artists.length });
  return res.json({ ok: true, token, role: user.role, email: clean, artists });
}

module.exports = { passwordLogin };
