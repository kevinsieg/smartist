'use strict';

// openapi.json is written by hand; these checks keep it in step with the code:
// every route and method the API answers is documented, and nothing documented
// is gone from the API.

const fs = require('fs');
const path = require('path');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'openapi.json'), 'utf8'));
const { match, TABLE } = require(path.join(ROOT, 'api', 'index.js'));

// The OAuth return URL is a browser redirect, not part of the API.
const NOT_API = new Set(['/auth/callback']);
// Super-admin routes stay out of the public reference.
const UNDOCUMENTED = new Set(['/api/admin/overview', '/api/admin/set-plan']);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const specPaths = Object.keys(spec.paths);
const specMethods = p => METHODS.filter(m => spec.paths[p][m]).map(m => m.toUpperCase());
// A spec path as a URL the router can match: {band} → band, other params → 1.
const sample = p => p.replace('{band}', 'band').replace(/\{\w+\}/g, '1');

function handlerFile(name) {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'index.js'), 'utf8');
  const m = new RegExp(`^\\s+${name}:\\s+\\(\\) => require\\('\\./(.+?)'\\)`, 'm').exec(src);
  return m && path.join(ROOT, 'api', m[1] + '.js');
}

// api/_config.js dispatches on the action the route table sets: the ones in
// its POST block answer POST, the rest GET.
function configActionMethods() {
  const src = fs.readFileSync(path.join(ROOT, 'api', '_config.js'), 'utf8');
  const start = src.indexOf("if (req.method === 'POST') {");
  const end = src.indexOf('\n  }\n', start);
  const methods = {};
  for (const m of src.matchAll(/if \(action === '([\w-]+)'\)/g))
    methods[m[1]] = m.index > start && m.index < end ? 'POST' : 'GET';
  return methods;
}

async function run(r) {
  const { test, assert, assertEq, B } = r;
  console.log(B('\nOpenAPI spec'));

  test('every route in the route table is documented', () => {
    const missing = [];
    for (const [pattern] of TABLE) {
      if (NOT_API.has(pattern) || UNDOCUMENTED.has(pattern)) continue;
      const re = new RegExp('^' + pattern
        .replace(':artist', '{band}')
        .replace(/\/\*$/, '/\\{\\w+\\}.*')
        .replace(/:id\b/g, '\\{\\w+\\}')
        .replace(/:\w+/g, '[^/]+') + '$');  // :sub and the like are literal segments
      if (!specPaths.some(p => re.test(p))) missing.push(pattern);
    }
    assertEq(missing, []);
  });

  test('every documented path reaches a handler', () => {
    assertEq(specPaths.filter(p => !match(sample(p))), []);
  });

  test('every method a band handler answers is documented for its paths', () => {
    const documented = {};
    for (const p of specPaths) {
      const h = match(sample(p))?.handler;  // unmatched paths fail the test above
      if (!h) continue;
      for (const m of specMethods(p)) (documented[h] ??= new Set()).add(m);
    }
    const missing = [];
    for (const h of new Set(TABLE.map(([, handler]) => handler))) {
      if (h === 'config') continue;  // per action, below
      const src = fs.readFileSync(handlerFile(h), 'utf8');
      for (const [, m] of src.matchAll(/method\s*[!=]==\s*'([A-Z]+)'/g))
        if (!documented[h]?.has(m)) missing.push(`${m} ${h}`);
    }
    assertEq([...new Set(missing)], []);
  });

  test('every account action is documented with the method it answers', () => {
    const methods = configActionMethods();
    assert(Object.keys(methods).length > 10, 'no actions found in api/_config.js');
    const wrong = [];
    for (const [pattern, handler, fixed] of TABLE) {
      if (handler !== 'config' || !fixed?.action || NOT_API.has(pattern) || UNDOCUMENTED.has(pattern)) continue;
      const method = methods[fixed.action];
      if (!method) wrong.push(`${pattern}: no handler for ${fixed.action}`);
      else if (!spec.paths[pattern]?.[method.toLowerCase()]) wrong.push(`${method} ${pattern}`);
      else if (specMethods(pattern).length > 1) wrong.push(`${pattern} documents ${specMethods(pattern)}`);
    }
    assertEq(wrong, []);
  });

  test('/api/config documents its query actions and PATCH', () => {
    const methods = configActionMethods();
    const routed = new Set(TABLE.filter(([, h]) => h === 'config').map(([, , fixed]) => fixed?.action).filter(Boolean));
    const queryOnly = Object.keys(methods).filter(a => !routed.has(a));
    assertEq(spec.paths['/api/config'].get.parameters.find(p => p.name === 'action').schema.enum, queryOnly);
    assert(spec.paths['/api/config'].patch, 'PATCH /api/config missing');
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
