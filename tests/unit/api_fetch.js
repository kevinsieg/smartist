'use strict';

// Workspace endpoints (/api/<slug>/…, /api/config?…slug=…) go through
// apiFetch() (session.js): it sends the token and takes an ended session — log
// out everywhere, a password changed elsewhere, a removed membership — to the
// login page. Bare fetch() calls carried their own copies of that, each slightly
// different, and some only cleared the token and showed an error. A call that
// cannot use apiFetch says why on the line above with `apiFetch-exempt:`.

const fs = require('fs');
const path = require('path');
const { makeRunner } = require('./_runner');

const JS_DIR = path.join(__dirname, '../../app/js');

// Pages that load core.js only (stage.html and what it pulls in) have no
// apiFetch, and the public email links (accept invite, confirm address) carry
// no session.
const EXEMPT_FILES = new Set(['session.js', 'stage.js', 'share-utils.js', 'home.js', 'confirm-email.js']);

// fetch( whose URL names a band: a slug in the path, or a slug= parameter.
const WORKSPACE_FETCH = /(?<![\w.$])fetch\(\s*(?:['"`]\/api\/(?:\$\{|['"]\s*\+)|[^)\n]*[?&]slug=)/;

// A variable holding a workspace URL.
const URL_VAR = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:['"`]\/api\/(?:\$\{|['"]\s*\+)|[^;\n]*[?&]slug=)/g;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? jsFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

function run(r) {
  const { test, assert, B } = r;
  console.log(B('\nworkspace calls go through apiFetch'));

  test('no bare fetch() to a workspace endpoint in app/js', () => {
    const hits = [];
    for (const f of jsFiles(JS_DIR)) {
      if (EXEMPT_FILES.has(path.basename(f))) continue;
      const src = fs.readFileSync(f, 'utf8');
      const lines = src.split('\n');
      // A URL built first and fetched by name: `var url = '/api/' + slug …; fetch(url, …)`.
      const named = [...src.matchAll(URL_VAR)].map(m => m[1]);
      const byName = named.length ? new RegExp(`(?<![\\w.$])fetch\\(\\s*(?:${named.join('|')})\\b`) : null;
      lines.forEach((line, i) => {
        if (!WORKSPACE_FETCH.test(line) && !(byName && byName.test(line))) return;
        if (/apiFetch-exempt:/.test(lines[i - 1] || '')) return;
        hits.push(`${path.relative(JS_DIR, f)}:${i + 1}`);
      });
    }
    assert(hits.length === 0, `use apiFetch(): ${hits.join(', ')}`);
  });

  test('the check recognises the call shapes it is meant to catch', () => {
    for (const src of ["fetch('/api/' + artistSlug + '/songs', {",
                       'fetch(`/api/${artistSlug}/songs/${sid}`, {',
                       "fetch('/api/config?slug=' + encodeURIComponent(s), {"])
      assert(WORKSPACE_FETCH.test(src), src);
    const named = [..."var url = '/api/' + _slug + '/venues/' + v.id;".matchAll(URL_VAR)].map(m => m[1]);
    assert(named.join() === 'url', 'a URL built into a variable is tracked: ' + named.join());
    for (const src of ["apiFetch('/api/' + artistSlug + '/songs')", "fetch(json.uploadUrl, { method: 'PUT' })",
                       "fetch('/api/auth/artists', {"])
      assert(!WORKSPACE_FETCH.test(src), src);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
