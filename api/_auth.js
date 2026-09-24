const bcrypt = require('bcryptjs');
const { getDb, getArtist } = require('./_db');
const { verifyMagicToken, verifyUserToken, passwordMatches } = require('./_token');
const { checkRateLimit, isRateLimited, clientIp } = require('./_ratelimit');

const ROLE_ORDER = ['viewer', 'member', 'admin'];

// Failed band-password bearers per IP before bcrypt is no longer even tried.
// Only failures count: legacy sessions send the password on every request.
const BEARER_FAIL_MAX    = 20;
const BEARER_FAIL_WINDOW = 15 * 60;

// Band-level credentials (the legacy shared password, or a magic token signed
// with its hash). Returns the role they grant, or null. A 'demo' token — the
// one the public demo gate hands to anybody — is a member session, never an
// admin one: admins can invite (send email), upload files and rewrite settings.
function magicRole(token, artist) {
  if (verifyMagicToken(token, artist.password_hash, 'login')) return 'admin';
  if (verifyMagicToken(token, artist.password_hash, 'demo'))  return 'member';
  return null;
}

// A signed token of ours (magic or user), valid or not — never a password, so
// it must neither cost a bcrypt round nor count as a failed password guess.
function looksLikeToken(t) {
  if (t.length > 200) return true;
  try {
    const o = JSON.parse(Buffer.from(t, 'base64url').toString());
    return !!o && typeof o === 'object' && ('sig' in o);
  } catch { return false; }
}

async function checkCredentials(token, artist) {
  if (!artist || !artist.password_hash || !token) return null;
  const t = String(token);
  const role = magicRole(t, artist);
  if (role) return role;
  if (looksLikeToken(t)) return null;
  return (await bcrypt.compare(t, artist.password_hash)) ? 'admin' : null;
}

// Resolve a bearer token to { id, role } for THIS artist, or null.
// User tokens carry only userId — membership in the artist is checked via the
// email-linked users rows, so a token issued for one workspace never grants
// access to a workspace the user does not belong to. Role comes from the DB
// row (per-workspace, revocable), not from the token.
//
// The membership row is looked up by slug, not artist id, so it can run in
// parallel with getArtist (see loadArtistAndMember) — one round trip, not two.
async function findMember(userId, slug) {
  const sql = getDb();
  const [member] = await sql`
    SELECT u2.id, u2.role, u1.password_hash
    FROM users u1
    JOIN users u2 ON u2.email = u1.email
    JOIN artists a ON a.id = u2.artist_id
    WHERE u1.id = ${userId} AND a.slug = ${slug}
    LIMIT 1
  `;
  return member ?? null;
}

async function loadArtistAndMember(token, slug) {
  const claim = token ? verifyUserToken(token) : null;
  const [artist, member] = await Promise.all([
    getArtist(slug),
    claim ? findMember(claim.userId, slug) : null,
  ]);
  return { artist, claim, member };
}

async function resolveUser(token, artist, req, claim, member) {
  if (claim) {
    if (!member || !passwordMatches(claim, member)) return null;
    return { id: member.id, role: member.role };
  }
  if (!artist.password_hash) return null;
  const t = String(token);
  const role = magicRole(t, artist);
  if (role) return { id: null, role };
  if (looksLikeToken(t)) return null;
  // Only a password guess reaches bcrypt, and only failed guesses are counted:
  // legacy sessions send the band password with every request.
  const failKey = req ? `bearer-fail:${clientIp(req)}` : null;
  if (failKey && await isRateLimited(failKey, BEARER_FAIL_MAX, BEARER_FAIL_WINDOW)) return null;
  if (await bcrypt.compare(t, artist.password_hash)) return { id: null, role: 'admin' };
  if (failKey) await checkRateLimit(failKey, BEARER_FAIL_MAX, BEARER_FAIL_WINDOW);
  return null;
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

  const user = await resolveUser(token, artist, req, claim, member);
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
  const token = bearerToken(req);
  const { artist, claim, member } = await loadArtistAndMember(token, slug);
  if (!artist) return { artist: null, user: null };
  const user = token ? await resolveUser(token, artist, req, claim, member) : null;
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

module.exports = { requireAuth, requireRole, checkCredentials, getAccess, canBrowseCatalogue, canOpenStage };
