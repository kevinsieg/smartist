const { getDb } = require('./_db');
const { wrap } = require('./_handler');
const { validateStr } = require('./_validate');
const { checkRateLimit, clientIp } = require('./_ratelimit');
const { requireAuth, getAccess, canBrowseCatalogue, checkCredentials } = require('./_auth');
const { createPresignedUrl, keyFromUrl } = require('./_r2');
const { verifyUserToken, passwordMatches } = require('./_token');
const { resolveArtist, isSlugAvailable, getArtistsForUser } = require('./_domain/artist');
const { planSummary } = require('./_plans');
const admin = require('./_domain/admin');
const signup = require('./_domain/signup');
const oauth = require('./_domain/oauth');
const subscribe = require('./_domain/subscribe');
const login = require('./_domain/login');
const reset = require('./_domain/reset');
const deletion = require('./_domain/deletion_handlers');

// ── Router ────────────────────────────────────────────────────────────────────
// Feature groups live in ./_domain/*; the core config read/write stays here.

module.exports = wrap(async function handler(req, res) {
  if (req.method === 'POST') {
    // Actions arrive in the body from the app, and in the query from the
    // rewrites (/api/login → /api/config?action=login). Reading only the body
    // let a rewritten POST fall through to the subscribe handler, which
    // answered a login attempt with "Already subscribed".
    const action = req.body?.action || req.query?.action;
    if (action === 'admin-set-plan')      return admin.setPlan(req, res);
    if (action === 'upgrade')             return upgrade(req, res);
    if (action === 'downgrade')           return downgrade(req, res);
    if (action === 'login')               return login.passwordLogin(req, res);
    if (action === 'request-reset')       return reset.requestReset(req, res);
    if (action === 'set-password')        return reset.setPassword(req, res);
    if (action === 'signup-link')         return signup.signupLink(req, res);
    if (action === 'verify-signup-token') return signup.verifySignup(req, res);
    if (action === 'signup')              return signup.signup(req, res);
    if (action === 'request-deletion')    return deletion.requestDeletion(req, res);
    if (action === 'confirm-deletion')    return deletion.confirmDeletion(req, res);
    if (req.body?.source === 'contact')   return subscribe.contact(req, res);
    return subscribe.subscribe(req, res);
  }

  if (req.method === 'PATCH') return patchConfig(req, res);

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Slug-independent GET endpoints — must be dispatched before the slug guard.
  // OAuth resolves the user by email, not by workspace, so it has no slug (the
  // client and the /auth/callback rewrite never send one).
  if (req.query.action === 'check-slug')     return checkSlug(req, res);
  if (req.query.action === 'my-artists')     return myArtists(req, res);
  if (req.query.action === 'deletion-preflight') return deletion.preflight(req, res);
  if (req.query.action === 'admin-overview') return admin.overview(req, res);
  if (req.query.action === 'google-url')     return oauth.googleUrl(req, res);
  if (req.query.action === 'facebook-url')   return oauth.facebookUrl(req, res);
  if (req.query.action === 'oauth-callback') return oauth.oauthCallback(req, res);

  const slugParam = req.query.slug || process.env.ARTIST_SLUG || '';
  if (!slugParam) {
    // Asking for an action still needs a band; a plain read does not. Without
    // this the root of a multi-tenant deployment 404s on every page load.
    if (req.query.action) return res.status(404).json({ error: 'Artist not found' });
    return res.json({
      singleTenant:  false,
      googleLogin:   !!(process.env.GOOGLE_CLIENT_ID   && process.env.GOOGLE_CLIENT_SECRET),
      facebookLogin: !!(process.env.FACEBOOK_APP_ID    && process.env.FACEBOOK_APP_SECRET),
    });
  }

  if (req.query.action === 'photo-url')      return presignedUpload(req, res, slugParam, 'photo', 'image/jpeg', PHOTO_TYPES);
  if (req.query.action === 'favicon-url')    return presignedUpload(req, res, slugParam, 'favicon', 'image/png', FAVICON_TYPES);

  return publicConfig(req, res, slugParam);
});

// ── POST ?action=upgrade — self-serve upgrade seam ──────────────────────────────
// Today: free flip to Pro + sticky upgradedAt for demand tracking, returns mode
// 'self-serve' (client then offers a donation). Swapping to a paid provider
// later = return { mode:'checkout', url } here and let the provider webhook set
// the plan instead.
async function upgrade(req, res) {
  const slugParam = req.query.slug || process.env.ARTIST_SLUG || '';
  const band = await requireAuth(req, res, slugParam, 'admin');
  if (!band) return;
  const sql = getDb();
  await sql`UPDATE artists SET config = config || ${{ plan: 'pro', upgradedAt: new Date().toISOString() }} WHERE id = ${band.id}`;
  return res.json({ ok: true, mode: 'self-serve' });
}

// ── POST ?action=downgrade — back to Free ───────────────────────────────────────
// upgradedAt is deliberately kept: it is the sticky demand metric.
async function downgrade(req, res) {
  const slugParam = req.query.slug || process.env.ARTIST_SLUG || '';
  const band = await requireAuth(req, res, slugParam, 'admin');
  if (!band) return;
  const sql = getDb();
  await sql`UPDATE artists SET config = config || ${{ plan: 'free' }} WHERE id = ${band.id}`;
  return res.json({ ok: true });
}

// ── PATCH — update artist name / config ─────────────────────────────────────────
async function patchConfig(req, res) {
  const slugParam = req.query.slug || process.env.ARTIST_SLUG || '';
  if (!slugParam) return res.status(400).json({ error: 'slug required' });
  const band = await requireAuth(req, res, slugParam, 'admin');
  if (!band) return;
  const sql = getDb();
  if (req.body?.name !== undefined) {
    const name = validateStr(req.body.name, 200);
    if (!name) return res.status(400).json({ error: 'Name required' });
    await sql`UPDATE artists SET name = ${name} WHERE id = ${band.id}`;
  }
  if (req.body?.config !== undefined) {
    // Plan state changes only through ?action=upgrade|downgrade|admin-set-plan
    // (later: the billing webhook), never through a generic config patch.
    const update = { ...req.body.config };
    delete update.plan;
    delete update.upgradedAt;
    // Image URLs pointing into our bucket must be this band's own uploads —
    // account deletion removes whatever these name (api/_domain/deletion.js).
    for (const k of ['logoUrl', 'faviconUrl']) {
      if (update[k] == null || update[k] === '') continue;
      if (typeof update[k] !== 'string' || !/^https?:\/\//i.test(update[k]))
        return res.status(400).json({ error: `${k} must be an http(s) URL` });
      const key = keyFromUrl(update[k]);
      if (key !== null && !key.startsWith(`bands/${band.slug}/`))
        return res.status(400).json({ error: `Invalid ${k}` });
    }
    await sql`UPDATE artists SET config = config || ${update} WHERE id = ${band.id}`;
  }
  return res.json({ ok: true });
}

// ── GET ?action=check-slug — is a slug available? ───────────────────────────────
async function checkSlug(req, res) {
  const slugToCheck = String(req.query.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(slugToCheck))
    return res.json({ available: false });
  if (await checkRateLimit(`check-slug:${clientIp(req)}`, 30, 60))
    return res.status(429).json({ error: 'Too many requests' });
  const sql = getDb();
  const available = await isSlugAvailable(slugToCheck, sql);
  return res.json({ available });
}

// ── GET ?action=my-artists — artists for current user ───────────────────────────
async function myArtists(req, res) {
  const authHeader = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claim = verifyUserToken(authHeader);
  const sql = getDb();
  if (claim) {
    const [row] = await sql`SELECT password_hash FROM users WHERE id = ${claim.userId} LIMIT 1`;
    if (row && !passwordMatches(claim, row)) return res.status(401).json({ error: 'Unauthorised' });
    const artists = await getArtistsForUser(claim.userId, sql);
    // Every users row belongs to a workspace, so none means the user is gone
    // (account deleted) while its signed token is still in date.
    if (!artists.length) return res.status(401).json({ error: 'Unauthorised' });
    return res.json({ artists });
  }
  // Legacy bootstrap sessions (artist password as bearer) have no users row —
  // on single-tenant installs their only workspace is the deployment's.
  if (authHeader && process.env.ARTIST_SLUG) {
    const band = await resolveArtist('', sql);
    if (band && await checkCredentials(authHeader, band)) {
      return res.json({ artists: [{ slug: band.slug, name: band.name, role: 'admin' }] });
    }
  }
  return res.status(401).json({ error: 'Unauthorised' });
}

// ── GET ?action=photo-url|favicon-url — presigned upload URL (auth required) ─────
// Raster types only: an SVG in the public bucket is a script-capable document.
const PHOTO_TYPES   = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const FAVICON_TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/webp', 'image/gif']);

async function presignedUpload(req, res, slugParam, kind, defaultType, allowed) {
  const band = await requireAuth(req, res, slugParam, 'admin');
  if (!band) return;
  const contentType = String(req.query.type || defaultType);
  if (!allowed.has(contentType)) return res.status(400).json({ error: 'Unsupported image type' });
  const key = `bands/${band.slug}/${kind}`;
  const { uploadUrl, publicUrl } = await createPresignedUrl(key, contentType);
  return res.json({ uploadUrl, publicUrl });
}

const PRIVATE_CONFIG_KEYS = ['gemaIpNameNumber', 'upgradedAt'];

// ── GET — public config (songs, counts, feature flags) ──────────────────────────
// ?light=1 skips the songs payload (full song rows incl. lyrics + GEMA join)
// for pages that only need name/config/counts — most of the app.
// Private workspaces serve only name/config/flags (login-page branding) to
// unauthenticated visitors — no songs, no counts.
async function publicConfig(req, res, slugParam) {
  const sql = getDb();
  const { artist: band, user } = await getAccess(req, slugParam);
  if (!band) return res.status(404).json({ error: 'Band not found in database' });
  // Without a session the songs payload only ships for a public catalogue.
  const priv  = !user && !canBrowseCatalogue(band);
  const light = priv || req.query.light === '1';

  const [songs, [counts]] = await Promise.all([
    light ? Promise.resolve([]) : sql`
      SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language
      FROM songs s
      LEFT JOIN LATERAL (
        SELECT iswc, gema_work_number, language
        FROM gema_works
        WHERE song_id = s.id
        ORDER BY gema_work_number
        LIMIT 1
      ) g ON true
      WHERE s.artist_id = ${band.id} AND s.deleted = false
      ORDER BY s.title
    `,
    priv ? Promise.resolve([undefined]) : sql`
      SELECT
        (SELECT COUNT(*)::int FROM songs      WHERE artist_id = ${band.id} AND NOT deleted) AS songs,
        (SELECT COUNT(*)::int FROM gigs       WHERE artist_id = ${band.id} AND NOT deleted) AS gigs,
        (SELECT COUNT(*)::int FROM venues     WHERE artist_id = ${band.id} AND NOT deleted) AS venues,
        (SELECT COUNT(*)::int FROM organizers WHERE artist_id = ${band.id} AND NOT deleted) AS organizers,
        (SELECT COUNT(*)::int FROM setlists   WHERE artist_id = ${band.id})                 AS setlists
    `,
  ]);

  // Responses vary by auth for private workspaces — only the public variant
  // may sit in a shared CDN cache.
  if (!user) res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  // Anonymous visitors get the band's branding and display settings, not its
  // rights-administration details or plan history.
  let config = band.config;
  if (!user && config) {
    config = { ...config };
    for (const k of PRIVATE_CONFIG_KEYS) delete config[k];
  }
  res.json({
    slug:          band.slug,
    name:          band.name,
    config,
    // Per-workspace role of the authenticated caller (the session token's own
    // role claim is only valid for the workspace it was issued for, so the
    // client must read this instead of decoding the token). Bootstrap
    // password sessions (user.id === null) report null — the client treats
    // null as "legacy admin" and uses it to detect bootstrap logins.
    // Band-password sessions have no users row; a full one reports null
    // ("legacy admin"), a demo-gate session reports its real, lesser role.
    role:          user ? ((user.id != null || user.role !== 'admin') ? user.role : null) : null,
    songs:         light ? undefined : songs,
    counts,
    plan:          planSummary(band),
    usage:         {
      storageUsedBytes: Number(band.storage_used_bytes || 0),
      songs: (counts && counts.songs != null) ? counts.songs : null,
    },
    googleLogin:   !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    facebookLogin: !!(process.env.FACEBOOK_APP_ID  && process.env.FACEBOOK_APP_SECRET),
    singleTenant:  !!process.env.ARTIST_SLUG,
  });
}
