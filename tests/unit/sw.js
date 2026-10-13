'use strict';

// app/sw.js: which requests the service worker handles and how. The routing is
// a pure function so it is tested here without a browser.

const path = require('path');
const { makeRunner } = require('./_runner');
const SW = require(path.join(__dirname, '../../app/sw.js'));

function run(r) {
  const { test, assertEq, B } = r;
  const O = 'https://app.example.test';
  const req = (p, method, mode) => ({ url: O + p, method: method || 'GET', mode: mode || 'no-cors' });

  console.log(B('\nservice worker routing'));

  test('versioned js, css, vendor and i18n files are cached "static"', () => {
    for (const p of ['/app/js/core.js?v=14', '/app/css/app.css?v=3', '/app/vendor/leaflet.js?v=1', '/app/i18n/en.json?v=64'])
      assertEq(SW.strategyFor(req(p), O), 'static', p);
  });

  test('a static file without ?v= is never cached (it could go stale)', () => {
    assertEq(SW.strategyFor(req('/app/js/core.js'), O), null);
  });

  test('navigations are "page"', () => {
    assertEq(SW.strategyFor(req('/myband/stage?id=5', 'GET', 'navigate'), O), 'page');
    assertEq(SW.strategyFor(req('/login', 'GET', 'navigate'), O), 'page');
  });

  test('the API is never handled, navigation or not', () => {
    assertEq(SW.strategyFor(req('/api/myband/songs/1'), O), null);
    assertEq(SW.strategyFor(req('/api/docs', 'GET', 'navigate'), O), null);
  });

  test('the OAuth return and the worker itself are never handled', () => {
    assertEq(SW.strategyFor(req('/auth/callback?code=x', 'GET', 'navigate'), O), null);
    assertEq(SW.strategyFor(req('/sw.js', 'GET', 'navigate'), O), null);
  });

  test('writes and other origins are never handled', () => {
    assertEq(SW.strategyFor(req('/app/js/core.js?v=1', 'POST'), O), null);
    assertEq(SW.strategyFor({ url: 'https://tile.example.test/1.png', method: 'GET', mode: 'no-cors' }, O), null);
  });

  test('a page is keyed by path, so stage?song= is served from stage?id=', () => {
    assertEq(SW.pageKey(O + '/myband/stage?id=5'), O + '/myband/stage');
    assertEq(SW.pageKey(O + '/myband/stage?song=9&from=5'), O + '/myband/stage');
  });

  test('assetsIn lists the versioned app files a page loads, once each', () => {
    const html = '<link href="/app/css/app.css?v=3"><script src="/app/js/core.js?v=14"></script>' +
      '<script src="/app/js/core.js?v=14"></script><script src="/app/js/x.js"></script>' +
      '<link rel="icon" href="/favicon_io/favicon-32x32.png">';
    assertEq(SW.assetsIn(html), ['/app/css/app.css?v=3', '/app/js/core.js?v=14']);
  });
}

module.exports = run;

if (require.main === module) {
  const r = makeRunner();
  Promise.resolve(run(r)).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
