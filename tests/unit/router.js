'use strict';

// api/index.js is the one serverless function: each path must reach its
// handler with the req.query that handler reads.

const fs = require('fs');
const path = require('path');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');
const { match } = require(path.join(ROOT, 'api', 'index.js'));

async function run(r) {
  const { test, assert, assertEq, B } = r;
  console.log(B('\nAPI router'));

  const cases = [
    ['/api/config',                         'config', {}],
    ['/api/login',                          'config', { action: 'login' }],
    ['/api/auth/magic-login',               'config', { action: 'magic-login' }],
    ['/api/auth/artists',                   'config', { action: 'artists' }],
    ['/api/signup',                         'config', { action: 'signup' }],
    ['/api/signup/verify',                  'config', { action: 'verify-signup-token' }],
    ['/api/config/upgrade',                 'config', { action: 'upgrade' }],
    ['/api/admin/overview',                 'config', { action: 'admin-overview' }],
    ['/api/contact',                        'config', { action: 'contact' }],
    ['/api/subscribe',                      'config', { action: 'subscribe' }],
    ['/auth/callback',                      'config', { action: 'oauth-callback' }],
    ['/api/band/members',                   'members', { artist: 'band' }],
    ['/api/band/members/invite',            'members', { artist: 'band', path: ['invite'] }],
    ['/api/band/songs',                     'songs',  { artist: 'band' }],
    ['/api/band/song-logs',                 'songs',  { artist: 'band', action: 'logs' }],
    ['/api/band/songs/import',              'songs',  { artist: 'band', action: 'import' }],
    ['/api/band/songs/12',                  'song',   { artist: 'band', path: ['12'] }],
    ['/api/band/songs/12/lyrics',           'song',   { artist: 'band', path: ['12', 'lyrics'] }],
    ['/api/band/songs/12/lyrics/suggest',   'song',   { artist: 'band', path: ['12', 'lyrics', 'suggest'] }],
    ['/api/band/gema/import',               'gema',   { artist: 'band' }],
    ['/api/band/songs/12/gema',             'song',   { artist: 'band', path: ['12', 'gema'] }],
    ['/api/band/songs/12/arrangements',     'song',   { artist: 'band', path: ['12', 'arrangements'] }],
    ['/api/band/songs/12/arrangements/3',   'song',   { artist: 'band', path: ['12', 'arrangements', '3'] }],
    ['/api/band/songs/12/arrangements/3/activate', 'song', { artist: 'band', path: ['12', 'arrangements', '3', 'activate'] }],
    ['/api/band/songs/12/audio',            'song',   { artist: 'band', path: ['12', 'audio'] }],
    ['/api/band/songs/12/sheet',            'song',   { artist: 'band', path: ['12', 'sheet'] }],
    ['/api/band/songs/12/playback',         'song',   { artist: 'band', path: ['12', 'playback'] }],
    ['/api/band/songs/12/setlists',         'song',   { artist: 'band', path: ['12', 'setlists'] }],
    ['/api/band/songs/12/restore',          'song',   { artist: 'band', path: ['12', 'restore'] }],
    ['/api/band/setlists',                  'setlists', { artist: 'band' }],
    ['/api/band/setlists/7/duplicate',      'setlist',  { artist: 'band', path: ['7', 'duplicate'] }],
    ['/api/band/setlists/7/share',          'setlist',  { artist: 'band', path: ['7', 'share'] }],
    ['/api/band/export',                    'export',   { artist: 'band' }],
    ['/api/band/gigs',                      'gigs',     { artist: 'band' }],
    ['/api/band/gigs/5',                    'gigs',     { artist: 'band', id: '5' }],
    ['/api/band/gigs/5/poster',             'gigs',     { artist: 'band', id: '5', sub: 'poster' }],
    ['/api/band/gigs/5/poster-url',         'gigs',     { artist: 'band', id: '5', sub: 'poster-url' }],
    ['/api/band/venues',                    'venues',   { artist: 'band' }],
    ['/api/band/venues/4',                  'venue',    { artist: 'band', path: ['4'] }],
    ['/api/band/organizers',                'organizers', { artist: 'band' }],
    ['/api/band/organizers/4',              'organizer',  { artist: 'band', path: ['4'] }],
  ];
  for (const [url, handler, params] of cases) {
    test(`${url} → ${handler}`, () => {
      const m = match(url);
      assert(m, `no route for ${url}`);
      assertEq(m.handler, handler);
      assertEq(m.params, params);
    });
  }

  test('an unknown path matches nothing', () => {
    assertEq(match('/api/band/nothing-here'), null);
    assertEq(match('/api/band'), null);
  });

  // Vercel serves api/index.js at /api only; every other /api/* path reaches it
  // through this rewrite. Last, so /api/docs (a static page) still wins.
  test('vercel.json rewrites every /api path to the function, last', () => {
    const { rewrites } = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    assertEq(rewrites[rewrites.length - 1], { source: '/api/:path*', destination: '/api?__path=/api/:path*' });
    const cb = rewrites.find(r => r.source === '/auth/callback');
    assertEq(cb.destination, '/api?__path=/auth/callback');
  });

  // Vercel applies the first matching rewrite: a page rule such as
  // /:slug/contact would serve HTML for /api/contact.
  test('no page rewrite catches an /api route before the function', () => {
    const { rewrites } = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const { TABLE } = require(path.join(ROOT, 'api', 'index.js'));
    const toRegex = src => new RegExp('^' + src.replace(/:\w+\*/g, '.*').replace(/:\w+/g, '[^/]+') + '$');
    const sample = p => p.replace(/:\w+/g, 'x1');
    const shadowed = [];
    for (const [pattern] of TABLE) {
      if (!pattern.startsWith('/api/')) continue;
      const url = sample(pattern);
      const first = rewrites.find(r => toRegex(r.source).test(url));
      if (first && !first.destination.startsWith('/api?__path=')) shadowed.push(`${url} → ${first.destination}`);
    }
    assertEq(shadowed, []);
  });

  await (async () => {
    const route = require(path.join(ROOT, 'api', 'index.js'));
    for (const [label, req] of [
      ['the original URL on req.url', { url: '/api/nowhere/x?a=1', query: {} }],
      ['the destination on req.url, the path in __path', { url: '/api?__path=/api/nowhere/x&a=1', query: { __path: '/api/nowhere/x', a: '1' } }],
    ]) {
      test(`the router finds the path from ${label}`, () => {
        // An unknown path answers 404 without loading a handler.
        let status = null;
        route(req, { status: s => { status = s; return { json: () => {} }; } });
        assertEq(status, 404);
      });
    }
  })();

  test('route parameters come from the path only, never from the query string', () => {
    const gigsPath = require.resolve(path.join(ROOT, 'api', '_band', 'gigs.js'));
    const saved = require.cache[gigsPath];
    let seen = null;
    require.cache[gigsPath] = { id: gigsPath, filename: gigsPath, loaded: true, exports: req => { seen = req.query; } };
    try {
      const route = require(path.join(ROOT, 'api', 'index.js'));
      route({ url: '/api/band/gigs?id=5&sub=poster&path=x&artist=other&refs=1', query: {} }, {});
      assertEq(seen, { refs: '1', artist: 'band' });
      route({ url: '/api/band/gigs/7?id=5&sub=poster', query: {} }, {});
      assertEq(seen, { artist: 'band', id: '7' });
    } finally {
      if (saved) require.cache[gigsPath] = saved; else delete require.cache[gigsPath];
    }
  });

  test('a malformed escape answers 400, not a crash', () => {
    const route = require(path.join(ROOT, 'api', 'index.js'));
    let status = null;
    route({ url: '/api/%E0%A4%A/songs', query: {} }, { status: s => { status = s; return { json: () => {} }; } });
    assertEq(status, 400);
  });

  test('every route names a handler that loads', () => {
    const src = fs.readFileSync(path.join(ROOT, 'api', 'index.js'), 'utf8');
    for (const [, file] of src.matchAll(/require\('(\.\/[^']+)'\)/g))
      assert(fs.existsSync(path.join(ROOT, 'api', file + '.js')), `missing ${file}`);
  });

  // Vercel turns every file under api/ into a function unless its name or a
  // parent directory starts with `_`. There is to be only the router.
  test('api/ holds exactly one function', () => {
    const fns = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('_')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) fns.push(path.relative(ROOT, p));
      }
    })(path.join(ROOT, 'api'));
    assertEq(fns, ['api/index.js']);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
