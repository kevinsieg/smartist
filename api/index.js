'use strict';

// The one serverless function. vercel.json rewrites every /api/* request (and
// /auth/callback) to it with the original path in `__path`, and the table
// below sends it to its handler. A new route is a line in ROUTES, not a
// file under api/ (Vercel Hobby allows twelve functions). Handlers live in
// files and directories prefixed `_`, which Vercel does not turn into
// functions of their own.
//
// Not a catch-all file (`api/[...route].js`): outside Next.js, Vercel matched
// that for one-segment paths only, so /api/config worked and /api/:artist/…
// was Vercel's own 404.
//
// A handler gets `req.query`: the URL's own query string, plus `artist` and the
// route's parameters, plus `path` (the segments after the resource) for the
// item handlers. Handlers read these and never parse `req.url` themselves.

const HANDLERS = {
  config:     () => require('./_config'),
  members:    () => require('./_band/members'),
  songs:      () => require('./_band/songs'),
  song:       () => require('./_band/songs/item'),
  setlists:   () => require('./_band/setlists'),
  setlist:    () => require('./_band/setlists/item'),
  export:     () => require('./_band/export'),
  gema:       () => require('./_band/gema'),
  gigs:       () => require('./_band/gigs'),
  venues:     () => require('./_band/venues'),
  venue:      () => require('./_band/venues/item'),
  organizers: () => require('./_band/organizers'),
  organizer:  () => require('./_band/organizers/item'),
  // vercel.json rewrites /api/docs to the static page; should the function be
  // matched first, it sends the browser there itself.
  docs:       () => (req, res) => { res.writeHead(307, { Location: '/app/api-docs.html' }); res.end(); },
};

// [pattern, handler, fixed query]. First match wins. `:name` matches one
// segment; a trailing `*` collects the rest into `path`.
/** @type {[string, string, object?][]} */
const TABLE = [
  ['/api/config',                                          'config'],
  ['/api/login',                                           'config', { action: 'login' }],
  ['/api/docs',                                            'docs'],
  // The OAuth provider returns to /auth/callback, rewritten here by vercel.json.
  ['/auth/callback',                                       'config', { action: 'oauth-callback' }],

  ['/api/:artist/members',                                 'members'],
  ['/api/:artist/members/*',                               'members'],
  ['/api/:artist/songs',                                   'songs'],
  ['/api/:artist/song-logs',                               'songs', { action: 'logs' }],
  ['/api/:artist/songs/import',                            'songs', { action: 'import' }],
  ['/api/:artist/songs/*',                                 'song'],
  ['/api/:artist/gema/import',                             'gema'],
  ['/api/:artist/setlists',                                'setlists'],
  ['/api/:artist/setlists/*',                              'setlist'],
  ['/api/:artist/export',                                  'export'],
  ['/api/:artist/gigs',                                    'gigs'],
  ['/api/:artist/gigs/:id',                                'gigs'],
  ['/api/:artist/gigs/:id/:sub',                           'gigs'],
  ['/api/:artist/venues',                                  'venues'],
  ['/api/:artist/venues/*',                                'venue'],
  ['/api/:artist/organizers',                              'organizers'],
  ['/api/:artist/organizers/*',                            'organizer'],
];

const ROUTES = TABLE.map(([pattern, handler, fixed = {}]) => {
  const names = [];
  const rest  = pattern.endsWith('/*');
  const body  = (rest ? pattern.slice(0, -2) : pattern)
    .replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; });
  return { re: new RegExp('^' + body + (rest ? '/(.+)' : '') + '/?$'), names, rest, handler, fixed };
});

function match(pathname) {
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    if (r.rest) params.path = m[r.names.length + 1].split('/').filter(Boolean).map(decodeURIComponent);
    return { handler: r.handler, params: { ...params, ...r.fixed } };
  }
  return null;
}

module.exports = async function route(req, res) {
  const url   = new URL(req.url, 'http://x');
  // Vercel keeps the original URL on req.url after a rewrite; `__path` from the
  // rewrite's destination covers a runtime that passes the destination instead.
  const rewritten = req.query?.__path;
  let found;
  try {
    found = match(typeof rewritten === 'string' && url.pathname === '/api' ? rewritten : url.pathname);
  } catch (err) {
    // A malformed escape (`%E0%A4%A`) is the client's mistake, not a crash.
    if (err instanceof URIError) return res.status(400).json({ error: 'Bad request' });
    throw err;
  }
  if (!found) return res.status(404).json({ error: 'Not found' });
  const query = Object.fromEntries(url.searchParams);
  delete query.__path;
  req.query = { ...query, ...found.params };
  return HANDLERS[found.handler]()(req, res);
};

module.exports.match = match;
