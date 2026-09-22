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
// Anonymous access is opt in, one surface at a time. A single private flag was
// too coarse: turning it off to publish a song list also published the gig
// schedule and the venue CRM, contact names and phone numbers included.
//
// Anything not covered here — venues, organizers, the setlists list, song logs,
// GEMA — needs a session, no setting involved.

// Songs and gig history, for fans browsing a band's repertoire. Off unless asked for.
function canBrowseCatalogue(artist) {
  return !!(artist && artist.config && artist.config.publicCatalogue === true);
}

// A shared /stage link, for someone learning the songs. On by default, since a
// stage link is meant to be handed out; switch it off to require a session.
// The link carries no token, so this is the only thing standing in front of it.
function canOpenStage(artist) {
  return !(artist && artist.config && artist.config.publicStage === false);
}

module.exports = { requireAuth, requireRole, checkCredentials, getAccess, canBrowseCatalogue, canOpenStage };
