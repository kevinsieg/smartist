// Shared assets (app.css, the four shared scripts, i18n.js) are cache-busted by ?v= query.
// app.css is served immutable for a year (vercel.json), so a page referencing
// an older ?v= keeps serving stale CSS forever. Every page must use the same
// version, and i18n.js?v= must match I18N_VERSION (the localStorage dict key).
const fs = require('fs');
const path = require('path');
const { I18N_VERSION } = require(path.join(__dirname, '../../app/js/i18n'));

const APP_DIR = path.join(__dirname, '../../app');
const SHARED = ['app.css', 'core.js', 'session.js', 'ui.js', 'shell.js', 'i18n.js'];

function collectVersions() {
  const versions = {};
  SHARED.forEach(a => { versions[a] = {}; });
  for (const f of fs.readdirSync(APP_DIR).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
    for (const asset of SHARED) {
      const m = html.match(new RegExp('/' + asset.replace('.', '\\.') + '\\?v=(\\d+)'));
      if (m) versions[asset][f] = Number(m[1]);
    }
  }
  return versions;
}

function run(r) {
  const { test, assert, assertEq, B } = r;
  const versions = collectVersions();
  const distinct = asset => [...new Set(Object.values(versions[asset]))];

  console.log(B('\nshared asset cache versions'));
  for (const asset of SHARED) {
    test(`${asset} ?v= identical on every page`, () =>
      assert(distinct(asset).length === 1,
        `${asset} versions differ: ${JSON.stringify(versions[asset])}`));
  }
  test('i18n.js ?v= matches I18N_VERSION', () =>
    assertEq(distinct('i18n.js')[0], I18N_VERSION));

  // /app/js and /app/css are served immutable for a year (vercel.json): a
  // reference without ?v= would keep the first copy a browser saw. Page scripts
  // are bumped by hand when they change, like the shared ones.
  test('every /app/js and /app/css reference carries ?v=', () => {
    const missing = [];
    for (const f of fs.readdirSync(APP_DIR).filter(f => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
      const re = /(?:src|href)="(\/app\/(?:js|css)\/[^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) if (!/\?v=\d+/.test(m[1])) missing.push(`${f}: ${m[1]}`);
    }
    assert(missing.length === 0, `unversioned: ${missing.join(', ')}`);
  });
}

module.exports = run;
