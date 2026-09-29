const { getDb, getArtist } = require('./_db');
const { verifyMagicToken, verifyUserToken, passwordMatches, demoSeed } = require('./_token');

const ROLE_ORDER = ['viewer', 'member', 'admin'];

// A session is a signed user token, or the demo gate's token for the demo band.
// The shared band password (a bcrypt check on every request, and the password
// itself kept in the browser as the bearer) is retired: every login is a named
// user. The demo token is a member session, never an admin one — admins can
// invite (send email), upload files and rewrite settings.
function demoRole(token, artist) {
  return verifyMagicToken(token, demoSeed(artist.id), 'demo') ? 'member' : null;
}

// Resolve a bearer token to { id, role } for THIS artist, or null.
// User tokens carry only userId — membership in the artist is checked via the
// email-linked users rows, so a token issued for one workspace never grants
// access to a workspace the user does not belong to. Role comes from the DB
// row (per-workspace, revocable), not from the token.
//
// The band and the caller's membership in it come back from one statement:
// every authenticated request starts here, and two queries cost twice the
// round-trips (they do not overlap on the function's single connection).
async function loadArtistAndMember(token, slug) {
  const claim = token ? verifyUserToken(token) : null;
  if (!claim) return { artist: await getArtist(slug), claim, member: null };
  const sql = getDb();
  const [row] = await sql`
    SELECT a.*, m.id AS member_id, m.role AS member_role, m.password_hash AS member_password_hash
    FROM artists a
    LEFT JOIN LATERAL (
      SELECT u2.id, u2.role, u1.password_hash
      FROM users u1
      JOIN users u2 ON u2.email = u1.email AND u2.artist_id = a.id
      WHERE u1.id = ${claim.userId}
      LIMIT 1
    ) m ON true
    WHERE a.slug = ${slug}
    LIMIT 1
  `;
  if (!row) return { artist: null, claim, member: null };
  const { member_id, member_role, member_password_hash, ...artist } = row;
  const member = member_id == null ? null
    : { id: member_id, role: member_role, password_hash: member_password_hash };
  return { artist, claim, member };
}

async function resolveUser(token, artist, claim, member) {
  if (claim) {
    if (!member || !passwordMatches(claim, member)) return null;
    return { id: member.id, role: member.role };
  }
  const role = demoRole(String(token), artist);
  return role ? { id: null, role } : null;
}

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function requireAuth(req, res, slug, minRole = null) {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return null; }

  const { artist, claim, member } = await loadArtistAndMember(token, slug);
  if (!artist) { res.status(404).json({ error: 'Artist not found' }); return null; }

  const user = await resolveUser(token, artist, claim, member);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  req.user = user;

  if (minRole && !requireRole(req, res, minRole)) return null;
  return artist;
}

// The public demo gate hands anybody a member session (id null). It may edit
// the demo band, but nothing that reaches outside it: no email to arbitrary
// addresses, no files in the bucket. Writes the 403 and returns true when refused.
function refuseDemo(req, res) {
  if (req.user && req.user.id === null) {
    res.status(403).json({ error: 'Not available in the demo', code: 'demo_readonly' });
    return true;
  }
  return false;
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
  const token = bearerToken(req);
  const { artist, claim, member } = await loadArtistAndMember(token, slug);
  if (!artist) return { artist: null, user: null };
  const user = token ? await resolveUser(token, artist, claim, member) : null;
  return { artist, user };
}

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

// A shared /stage link, for someone learning the songs. Off unless asked for:
// the link carries no token and row ids are one sequence across every band, so
// with this on anyone can walk /songs/1, /songs/2, … of the workspace. Turn it
// on in Settings to hand stage links to people without an account.
function canOpenStage(artist) {
  return !!(artist && artist.config && artist.config.publicStage === true);
}

module.exports = { requireAuth, requireRole, refuseDemo, getAccess, canBrowseCatalogue, canOpenStage };
