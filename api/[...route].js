'use strict';

// The one serverless function. Every /api/* request lands here and is sent to
// its handler by the table below, so a new route is a line in ROUTES, not a
// file under api/ (Vercel Hobby allows twelve functions) and not a rewrite in
// vercel.json. Handlers live in files and directories prefixed `_`, which
// Vercel does not turn into functions of their own.
//
// A handler gets `req.query` as it would from Vercel's file-system routing:
// the URL's own query string, plus `artist` and the route's parameters, plus
// `path` (the segments after the resource) for the item handlers. `req.url` is
// left as the client sent it.

const HANDLERS = {
  config:     () => require('./_config'),
  auth:       () => require('./_band/auth'),
  songs:      () => require('./_band/songs'),
  song:       () => require('./_band/songs/item'),
  setlists:   () => require('./_band/setlists'),
  setlist:    () => require('./_band/setlists/item'),
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
const ROUTES = [
  ['/api/config',                                          'config'],
  ['/api/login',                                           'config', { action: 'login' }],
  ['/api/docs',                                            'docs'],
  // The OAuth provider returns to /auth/callback, rewritten here by vercel.json.
  ['/auth/callback',                                       'config', { action: 'oauth-callback' }],

  ['/api/:artist/auth',                                    'auth'],
  ['/api/:artist/songs',                                   'songs'],
  ['/api/:artist/song-logs',                               'songs'],
  ['/api/:artist/gema/import',                             'song', { path: ['gema-import'] }],
  ['/api/:artist/songs/:songId/gema',                      'song', { path: ['gema'] }],
  ['/api/:artist/songs/:songId/arrangements/:arrId/activate', 'song', { path: ['arrangements'], sub: 'activate' }],
  ['/api/:artist/songs/:songId/arrangements/:arrId',       'song', { path: ['arrangements'] }],
  ['/api/:artist/songs/:songId/arrangements',              'song', { path: ['arrangements'] }],
  ['/api/:artist/songs/:songId/audio',                     'song', { path: ['audio'] }],
  ['/api/:artist/songs/:songId/sheet',                     'song', { path: ['sheet'] }],
  ['/api/:artist/songs/:songId/playback',                  'song', { path: ['playback'] }],
  ['/api/:artist/songs/:songId/setlists',                  'song', { path: ['setlists'] }],
  ['/api/:artist/songs/:songId/restore',                   'song', { path: ['restore'] }],
  ['/api/:artist/songs/*',                                 'song'],
  ['/api/:artist/setlists',                                'setlists'],
  ['/api/:artist/export',                                  'setlist', { path: ['export'] }],
  ['/api/:artist/setlists/*',                              'setlist'],
  ['/api/:artist/gigs',                                    'gigs'],
  ['/api/:artist/gigs/:id',                                'gigs'],
  ['/api/:artist/venues',                                  'venues'],
  ['/api/:artist/venues/*',                                'venue'],
  ['/api/:artist/organizers',                              'organizers'],
  ['/api/:artist/organizers/*',                            'organizer'],
].map(([pattern, handler, fixed = {}]) => {
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
  const found = match(url.pathname);
  if (!found) return res.status(404).json({ error: 'Not found' });
  req.query = { ...Object.fromEntries(url.searchParams), ...found.params };
  return HANDLERS[found.handler]()(req, res);
};

module.exports.match = match;
