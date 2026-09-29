'use strict';

// The Content-Security-Policy in vercel.json names each third-party script and
// stylesheet by its exact URL. A whole CDN host would let an injected tag load
// any package published there. So: every external script or stylesheet the app
// uses must be listed exactly, and no script source may be a bare host.

const fs = require('fs');
const path = require('path');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');

function csp() {
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  for (const h of vercel.headers) for (const kv of h.headers)
    if (kv.key === 'Content-Security-Policy') {
      const out = {};
      for (const part of kv.value.split(';')) {
        const [name, ...sources] = part.trim().split(/\s+/);
        if (name) out[name] = sources;
      }
      return out;
    }
  return null;
}

function externalAssets() {
  const scripts = new Set(), styles = new Set();
  const app = path.join(ROOT, 'app');
  const files = [
    ...fs.readdirSync(app).filter(f => f.endsWith('.html')).map(f => path.join(app, f)),
    ...fs.readdirSync(path.join(app, 'js')).filter(f => f.endsWith('.js')).map(f => path.join(app, 'js', f)),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<script[^>]+src="(https:[^"]+)"/g)) scripts.add(m[1]);
    for (const m of src.matchAll(/\.src\s*=\s*'(https:[^']+\.js)'/g)) scripts.add(m[1]);
    for (const m of src.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(https:[^"]+)"/g)) styles.add(m[1]);
  }
  return { scripts, styles };
}

function run(r) {
  const { test, assert, B } = r;
  console.log(B('\ncontent security policy'));
  const policy = csp();
  const { scripts, styles } = externalAssets();

  test('vercel.json sets a Content-Security-Policy', () => assert(policy, 'no CSP header'));
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
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
