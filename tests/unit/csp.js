'use strict';

// The Content-Security-Policy in vercel.json names each third-party script and
// stylesheet by its exact URL. A whole CDN host would let an injected tag load
// any package published there. So: every external script or stylesheet the app
// uses must be listed exactly, and no script source may be a bare host.

const fs = require('fs');
const path = require('path');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');

const VERCEL = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const DOCS = '/api/docs';

// A header rule's source as Vercel matches it against the request path
// (path-to-regexp: the whole path, a parenthesised group is a regex). Only
// the forms vercel.json uses.
function sourceMatches(source, p) {
  return new RegExp('^' + source + '$').test(p);
}

// The CSP rules that apply to a path. Vercel does not promise that a later
// rule replaces an earlier one's header: when two match, both headers may be
// sent, and a browser enforces every policy it gets.
function cspRulesFor(p) {
  return VERCEL().headers.filter(h => h.headers.some(kv => kv.key === 'Content-Security-Policy') && sourceMatches(h.source, p));
}

// The policy for every path but the API reference page, and that page's own:
// only it may load its bundle.
function csp(which = 'app') {
  for (const h of VERCEL().headers) for (const kv of h.headers)
    if (kv.key === 'Content-Security-Policy' && (h.source === DOCS) === (which === DOCS)) {
      const out = {};
      for (const part of kv.value.split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/);
        if (name) out[name] = sources;
      }
      return out;
    }
  return null;
}

const DOCS_PAGE = 'api-docs.html';

function externalAssets(only) {
  const scripts = new Set(), styles = new Set(), tags = [];
  const app = path.join(ROOT, 'app');
  const files = [
    ...fs.readdirSync(app).filter(f => f.endsWith('.html')).map(f => path.join(app, f)),
    ...fs.readdirSync(path.join(app, 'js')).filter(f => f.endsWith('.js')).map(f => path.join(app, 'js', f)),
  ].filter(f => (path.basename(f) === DOCS_PAGE) === (only === 'docs'));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<script[^>]+src="(https:[^"]+)"/g)) scripts.add(m[1]);
    for (const m of src.matchAll(/<script[^>]+src="https:[^>]*>/g)) tags.push(m[0]);
    for (const m of src.matchAll(/\.src\s*=\s*'(https:[^']+\.js)'/g)) scripts.add(m[1]);
    for (const m of src.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(https:[^"]+)"/g)) styles.add(m[1]);
  }
  return { scripts, styles, tags };
}

function run(r) {
  const { test, assert, B } = r;
  console.log(B('\ncontent security policy'));
  const policy = csp();
  const docs = csp(DOCS);
  const { scripts, styles, tags } = externalAssets();
  const docsAssets = externalAssets('docs');

  test('vercel.json sets a Content-Security-Policy', () => assert(policy, 'no CSP header'));
  test('every path gets exactly one CSP rule, /api/docs its own', () => {
    for (const p of ['/', '/login', '/api/docs', '/api/docs/', '/api/docs-x', '/api/docsx', '/api/config', '/band/songs', '/app/api-docs.html']) {
      const rules = cspRulesFor(p);
      assert(rules.length === 1, `${p}: ${rules.length} CSP rules (${rules.map(h => h.source).join(', ')})`);
      assert((rules[0].source === DOCS) === (p === DOCS), `${p} gets the ${rules[0].source} policy`);
    }
  });
  test("script-src allows no inline script and no eval", () => {
    const bad = policy['script-src'].filter(s => /^'unsafe-/.test(s));
    assert(bad.length === 0, `script-src has ${bad.join(', ')}`);
  });
  test('no script source is a whole host', () => {
    const bare = policy['script-src'].filter(s => /^https:\/\/[^/]+\/?$/.test(s));
    assert(bare.length === 0, `bare hosts in script-src: ${bare.join(', ')}`);
  });
  test('every external script the app loads is listed exactly', () => {
    const missing = [...scripts].filter(u => !policy['script-src'].includes(u));
    assert(missing.length === 0, `not in script-src: ${missing.join(', ')}`);
  });
  // Pages share their origin with the session token: a script that changes
  // under an unversioned URL runs with the power to read it.
  test('the docs page has its own policy: the app\'s plus its own bundle', () => {
    assert(docs, 'no CSP for /api/docs');
    const missing = [...docsAssets.scripts].filter(u => !docs['script-src'].includes(u));
    assert(missing.length === 0, `not in the /api/docs script-src: ${missing.join(', ')}`);
    const extra = docs['script-src'].filter(s => !policy['script-src'].includes(s) && !docsAssets.scripts.has(s));
    assert(extra.length === 0, `/api/docs allows more than its bundle: ${extra.join(', ')}`);
    for (const [k, v] of Object.entries(policy))
      if (k !== 'script-src') assert(JSON.stringify(docs[k]) === JSON.stringify(v), `/api/docs differs in ${k}`);
  });
  test('every external script names an exact version and carries a hash', () => {
    const loose = [...tags, ...docsAssets.tags].filter(t => !/@\d+\.\d+\.\d+\//.test(t) || !/integrity="sha(384|512)-/.test(t));
    assert(loose.length === 0, `unpinned or without integrity: ${loose.join(' | ')}`);
  });
  test('every external stylesheet the app loads is listed exactly', () => {
    const missing = [...styles].filter(u => !policy['style-src'].includes(u));
    assert(missing.length === 0, `not in style-src: ${missing.join(', ')}`);
  });
  test('object-src none, frame-ancestors none, base-uri self', () => {
    assert(policy['object-src']?.includes("'none'") && policy['frame-ancestors']?.includes("'none'")
      && policy['base-uri']?.includes("'self'"), 'a baseline directive is missing');
  });
}

if (require.main === module) {
  const r = makeRunner();
  Promise.resolve(run(r)).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
