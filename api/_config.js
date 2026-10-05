const { getDb } = require('./_db');
const { wrap } = require('./_handler');
const { validateStr, unsafeKey } = require('./_validate');
const { checkRateLimit, clientIp, presignLimited } = require('./_ratelimit');
const { requireAuth, getAccess, canBrowseCatalogue } = require('./_auth');
const { sessionAccount } = require('./_session');
const { createPresignedUrl, keyFromUrl, publicBaseUrl } = require('./_r2');
const { isSlugAvailable, SLUG_RE } = require('./_domain/artist');
const { configSongs, publicSong } = require('./_domain/songs');
const { planSummary } = require('./_plans');
const { envReport, SCHEMA_VERSION } = require('./_env');
const admin = require('./_domain/admin');
const signup = require('./_domain/signup');
const oauth = require('./_domain/oauth');
const subscribe = require('./_domain/subscribe');
const login = require('./_domain/login');
const reset = require('./_domain/reset');
const deletion = require('./_domain/deletion_handlers');
const { handle, MSG } = require('./_domain/http');

// ── Router ────────────────────────────────────────────────────────────────────
// Feature groups live in ./_domain/*; the core config read/write stays here.
// The account modules take plain input and return { status, body }; `handle`
// (api/_domain/http.js) turns a request into that input and the result into a
// reply. The action comes from the route table (POST /api/auth/magic-login
// sets action 'magic-login'), never from the body.
const POST_ACTIONS = {
  'admin-set-plan':      handle(admin.setPlan),
  'upgrade':             (req, res) => upgrade(req, res),
  'downgrade':           (req, res) => downgrade(req, res),
  'login':               handle(login.passwordLogin),
  'oauth-session':       handle(oauth.oauthSession),
  'magic-login':         handle(login.magicLogin),
  'logout-everywhere':   handle(login.logoutEverywhere),
  'request-reset':       handle(reset.requestReset),
  'set-password':        handle(reset.setPassword),
  'signup-link':         handle(signup.signupLink),
  'verify-signup-token': handle(signup.verifySignup),
  'signup':              handle(signup.signup),
  'request-deletion':    handle(deletion.requestDeletion),
  'confirm-deletion':    handle(deletion.confirmDeletion),
  'contact':             handle(subscribe.contact),
  'subscribe':           handle(subscribe.subscribe),
};

// GET actions that need no band, dispatched before the slug guard. OAuth
// resolves the user by email, not by workspace, so it has no slug (the client
// and the /auth/callback rewrite never send one).
const GET_ACTIONS = {
  'health':             (req, res) => health(req, res),
  'check-slug':         (req, res) => checkSlug(req, res),
  'artists':            (req, res) => listArtists(req, res),
  'deletion-preflight': handle(deletion.preflight),
  'admin-overview':     handle(admin.overview),
  'google-url':         handle(oauth.googleUrl),
  'facebook-url':       handle(oauth.facebookUrl),
  'oauth-callback':     handle(oauth.oauthCallback),
};

// The band a config route is about: ?slug=, or the one band of a single-tenant
// deployment. '' when neither.
function bandSlug(req) {
  return req.query.slug || process.env.ARTIST_SLUG || '';
}

// Which sign-in buttons the login page shows.
function loginProviders() {
  return {
    googleLogin:   !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    facebookLogin: !!(process.env.FACEBOOK_APP_ID  && process.env.FACEBOOK_APP_SECRET),
  };
}

module.exports = wrap(async function handler(req, res) {
  const action = req.query.action;
  if (req.method === 'POST') {
    const run = action && Object.hasOwn(POST_ACTIONS, action) ? POST_ACTIONS[action] : null;
    return run ? run(req, res) : res.status(404).json({ error: MSG.notFound });
  }

  if (req.method === 'PATCH') return patchConfig(req, res);

  if (req.method !== 'GET') return res.status(405).json({ error: MSG.methodNotAllowed });

  if (action && Object.hasOwn(GET_ACTIONS, action)) return GET_ACTIONS[action](req, res);

  const slugParam = bandSlug(req);
  if (!slugParam) {
    // Asking for an action still needs a band; a plain read does not. Without
    // this the root of a multi-tenant deployment 404s on every page load.
    if (action) return res.status(404).json({ error: MSG.artistNotFound });
    return res.json({ singleTenant: false, ...loginProviders() });
  }

  if (action === 'photo-url')          return presignedUpload(req, res, slugParam, 'photo', 'image/jpeg', PHOTO_TYPES);
  if (action === 'favicon-url')        return presignedUpload(req, res, slugParam, 'favicon', 'image/png', FAVICON_TYPES);

  return publicConfig(req, res, slugParam);
});

// ── GET /api/config?action=health — post-deploy check ──────────────────────────────────────
// Which required variables are missing (names only, never values), whether the
// database answers, and whether it has the newest schema migration. 503 when
// any of that is wrong, so a deploy script or uptime monitor can alert on it.
// An index an interrupted CREATE INDEX CONCURRENTLY left invalid is a warning:
// queries still work, only slower.
async function health(req, res) {
  const { missing, warnings } = envReport();
  let database = 'not configured';
  let schema = null;
  if (process.env.DATABASE_URL) {
    try {
      const [row] = await getDb()`
        SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id = ${SCHEMA_VERSION}) AS current,
               (SELECT array_agg(indexrelid::regclass::text) FROM pg_index WHERE NOT indisvalid) AS invalid`;
      database = 'ok';
      schema = row.current ? 'current' : 'behind';
      if (row.invalid) warnings.push(`invalid index: ${row.invalid.join(', ')}`);
    } catch (e) {
      // No ledger table yet: the database answers but predates it.
      if (e.code === '42P01') { database = 'ok'; schema = 'behind'; }
      else database = 'error';
    }
  }
  const ok = missing.length === 0 && database === 'ok' && schema === 'current';
  res.setHeader('Cache-Control', 'no-store');
  return res.status(ok ? 200 : 503).json({ ok, missing, warnings, database, schema, schemaVersion: SCHEMA_VERSION });
}

// ── POST /api/config/upgrade — self-serve upgrade seam ─────────────────────────
// Today: free flip to Pro + sticky upgradedAt for demand tracking, returns mode
// 'self-serve' (client then offers a donation). Swapping to a paid provider
// later = return { mode:'checkout', url } here and let the provider webhook set
// the plan instead.
async function upgrade(req, res) {
  const band = await requireAuth(req, res, bandSlug(req), 'admin');
  if (!band) return;
  const sql = getDb();
  await sql`UPDATE artists SET config = config || ${{ plan: 'pro', upgradedAt: new Date().toISOString() }} WHERE id = ${band.id}`;
  return res.json({ ok: true, mode: 'self-serve' });
}

// ── POST /api/config/downgrade — back to Free ──────────────────────────────────
// upgradedAt is deliberately kept: it is the sticky demand metric.
async function downgrade(req, res) {
  const band = await requireAuth(req, res, bandSlug(req), 'admin');
  if (!band) return;
  const sql = getDb();
  await sql`UPDATE artists SET config = config || ${{ plan: 'free' }} WHERE id = ${band.id}`;
  return res.json({ ok: true });
}

// ── PATCH — update artist name / config ─────────────────────────────────────────
const CONFIG_MAX_BYTES = 64 * 1024;

async function patchConfig(req, res) {
  const slugParam = bandSlug(req);
  if (!slugParam) return res.status(400).json({ error: 'slug required' });
  const band = await requireAuth(req, res, slugParam, 'admin');
  if (!band) return;
  const body = req.body ?? {};
  let name = null;
  if (body.name !== undefined) {
    name = validateStr(body.name, 200);
    if (!name) return res.status(400).json({ error: 'Name required' });
  }
  let update = {};
  if (body.config !== undefined) {
    const c = body.config;
    if (!c || typeof c !== 'object' || Array.isArray(c))
      return res.status(400).json({ error: 'config must be an object' });
    // Plan state changes only through /api/config/upgrade, /downgrade and /api/admin/set-plan
    // (later: the billing webhook), never through a generic config patch.
    const { plan: _p, upgradedAt: _u, ...rest } = c;
    update = rest;
    // Image URLs pointing into our bucket must be this band's own uploads —
    // account deletion removes whatever these name (api/_domain/deletion.js).
    for (const k of ['logoUrl', 'faviconUrl']) {
      if (update[k] == null || update[k] === '') continue;
      if (typeof update[k] !== 'string' || !/^https?:\/\//i.test(update[k]))
        return res.status(400).json({ error: `${k} must be an http(s) URL` });
      const key = keyFromUrl(update[k]);
      if (key !== null && (!key.startsWith(`bands/${band.slug}/`) || unsafeKey(key)))
        return res.status(400).json({ error: `Invalid ${k}` });
    }
  }
  if (name === null && !Object.keys(update).length) return res.json({ ok: true });
  // Name and settings in one statement: both are saved, or neither. artists.*
  // is read on every authenticated request of the band, so its settings stay
  // small: a merge past CONFIG_MAX_BYTES is refused.
  const [saved] = await getDb()`
    UPDATE artists SET name = COALESCE(${name}::text, name), config = config || ${update}
    WHERE id = ${band.id} AND octet_length((config || ${update})::text) <= ${CONFIG_MAX_BYTES}
    RETURNING id`;
  if (!saved) return res.status(413).json({ error: 'Settings too large' });
  return res.json({ ok: true });
}

// ── GET /api/signup/check-slug — is a slug available? ──────────────────────────
async function checkSlug(req, res) {
  const slugToCheck = String(req.query.slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(slugToCheck))
    return res.json({ available: false });
  if (await checkRateLimit(`check-slug:${clientIp(req)}`, 30, 60))
    return res.status(429).json({ error: 'Too many requests' });
  const sql = getDb();
  const available = await isSlugAvailable(slugToCheck, sql);
  return res.json({ available });
}

// ── GET /api/auth/artists — the signed-in person's workspaces ────────────────
// The session and the address's bands in one statement (the bands as
// getArtistsForUser in api/_domain/artist.js lists them). No row means the
// user is gone (account deleted) while its signed token is still in date.
async function listArtists(req, res) {
  const sql = getDb();
  const me = await sessionAccount(sql, req.headers, sql`
    COALESCE((
      SELECT json_agg(json_build_object('slug', a.slug, 'name', a.name, 'role', u.role) ORDER BY a.name)
      FROM users u JOIN artists a ON a.id = u.artist_id
      WHERE u.email = me.email
    ), '[]') AS artists`);
  if (!me || !me.artists.length) return res.status(401).json({ error: MSG.unauthorized });
  return res.json({ artists: me.artists });
}

// ── GET /api/config/photo-url, /favicon-url — presigned upload URL (auth) ─────
// Raster types only: an SVG in the public bucket is a script-capable document.
const PHOTO_TYPES   = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const FAVICON_TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/webp', 'image/gif']);

// The size is signed into the upload URL: these images do not count towards the
// storage cap, so without it one URL could park any amount in the bucket.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

async function presignedUpload(req, res, slugParam, kind, defaultType, allowed) {
  const band = await requireAuth(req, res, slugParam, 'admin');
  if (!band) return;
  const contentType = String(req.query.type || defaultType);
  if (!allowed.has(contentType)) return res.status(400).json({ error: 'Unsupported image type' });
  const size = Number(req.query.size);
  if (!Number.isInteger(size) || size <= 0 || size > IMAGE_MAX_BYTES)
    return res.status(400).json({ error: `size required, max ${IMAGE_MAX_BYTES / 1024 / 1024} MB` });
  if (await presignLimited(band.id)) return res.status(429).json({ error: 'Too many uploads — try again later' });
  const key = `bands/${band.slug}/${kind}`;
  const { uploadUrl, publicUrl } = await createPresignedUrl(key, contentType, size);
  return res.json({ uploadUrl, publicUrl });
}

// What a visitor without a session sees of a band's config: branding, display
// settings and its public switches. An allowlist, so a key added later stays
// private until it is named here (gemaIpNameNumber and upgradedAt never are).
const PUBLIC_CONFIG_KEYS = [
  'logoUrl', 'faviconUrl', 'platforms', 'plan',
  'displayFields', 'hiddenSongFields', 'filterFields', 'arrangementConfig',
  'publicCatalogue', 'publicStage',
];

// ── GET — public config (songs, counts, feature flags) ──────────────────────────
// ?light=1 skips the songs payload (full song rows + GEMA join) for pages that
// only need name/config/counts — most of the app. Lyrics are never in it; they
// come with one song's details (see api/_domain/songs.js).
// Private workspaces serve only name/config/flags (login-page branding) to
// unauthenticated visitors — no songs, no counts.
async function publicConfig(req, res, slugParam) {
  const sql = getDb();
  const { artist: band, user } = await getAccess(req, slugParam);
  if (!band) return res.status(404).json({ error: MSG.artistNotFound });
  // Without a session the songs payload only ships for a public catalogue.
  const priv  = !user && !canBrowseCatalogue(band);
  const light = priv || req.query.light === '1';
  // The anonymous full variant is the whole repertoire, unpaged. The CDN keeps
  // it for a minute, but any extra query parameter skips that cache, so the
  // requests that do reach the function are limited per address.
  if (!user && !light && await checkRateLimit(`config-full:${clientIp(req)}`, 60, 600))
    return res.status(429).json({ error: 'Too many requests' });

  const [songs, [counts]] = await Promise.all([
    light ? Promise.resolve([]) : configSongs(sql, band.id),
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
    config = Object.fromEntries(PUBLIC_CONFIG_KEYS.filter(k => k in band.config).map(k => [k, band.config[k]]));
  }
  res.json({
    slug:          band.slug,
    name:          band.name,
    config,
    // Per-workspace role of the authenticated caller (the session token's own
    // role claim is only valid for the workspace it was issued for, so the
    // client must read this instead of decoding the token). The demo gate's
    // session reports 'member'; no session reports null.
    role:          user ? user.role : null,
    songs:         light ? undefined : (user ? songs : songs.map(publicSong)),
    counts,
    // Visitors get the feature list the nav needs, not the plan, limits or
    // storage use.
    plan:          user ? planSummary(band) : { features: planSummary(band).features },
    usage:         user ? {
      storageUsedBytes: Number(band.storage_used_bytes || 0),
      songs: (counts && counts.songs != null) ? counts.songs : null,
    } : undefined,
    ...loginProviders(),
    singleTenant:  !!process.env.ARTIST_SLUG,
    // Where uploaded media lives (it is in every media URL anyway): the songs
    // page frames only this bucket's PDFs without a sandbox.
    mediaBase:     publicBaseUrl(),
  });
}
