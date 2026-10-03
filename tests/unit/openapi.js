'use strict';

// openapi.json is written by hand; these checks keep it in step with the code:
// every route, method and /api/config action the API answers is documented,
// and nothing documented is gone from the API.

const fs = require('fs');
const path = require('path');
const { makeRunner } = require('./_runner');

const ROOT = path.join(__dirname, '../..');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'openapi.json'), 'utf8'));
const { match, TABLE } = require(path.join(ROOT, 'api', 'index.js'));

// Routes that are not part of the API: the docs page and the OAuth return URL
// (documented under GET /api/config, action=oauth-callback).
const NOT_API = new Set(['/api/docs', '/auth/callback']);
// Super-admin actions stay out of the public reference.
const UNDOCUMENTED_ACTIONS = new Set(['admin-overview', 'admin-set-plan']);
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

async function run(r) {
  const { test, assert, assertEq, B } = r;
  console.log(B('\nOpenAPI spec'));

  test('every route in the route table is documented', () => {
    const missing = [];
    for (const [pattern] of TABLE) {
      if (NOT_API.has(pattern)) continue;
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

  test('every method a handler answers is documented for its paths', () => {
    const documented = {};
    for (const p of specPaths) {
      const h = match(sample(p)).handler;
      for (const m of specMethods(p)) (documented[h] ??= new Set()).add(m);
    }
    const missing = [];
    for (const h of new Set(TABLE.map(([, handler]) => handler))) {
      const file = handlerFile(h);
      if (!file) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const [, m] of src.matchAll(/method\s*[!=]==\s*'([A-Z]+)'/g))
        if (!documented[h]?.has(m)) missing.push(`${m} ${h}`);
    }
    assertEq([...new Set(missing)], []);
  });

  const configSrc = fs.readFileSync(path.join(ROOT, 'api', '_config.js'), 'utf8');
  const config = spec.paths['/api/config'];

  test('every POST /api/config action is documented', () => {
    const code = [...configSrc.matchAll(/^\s+if \(action === '([\w-]+)'\)/gm)].map(m => m[1]);
    assert(code.length > 5, 'no POST actions found in api/_config.js');
    const documented = config.post.requestBody.content['application/json'].schema.anyOf
      .flatMap(s => s.properties.action?.enum ?? []);
    assertEq(code.filter(a => !UNDOCUMENTED_ACTIONS.has(a) && !documented.includes(a)), []);
    assertEq(documented.filter(a => !code.includes(a)), []);
  });

  test('every GET /api/config action is documented', () => {
    const code = [...configSrc.matchAll(/req\.query\.action === '([\w-]+)'/g)].map(m => m[1]);
    assert(code.length > 5, 'no GET actions found in api/_config.js');
    const documented = config.get.parameters.find(p => p.name === 'action').schema.enum;
    assertEq([...new Set(code)].filter(a => !UNDOCUMENTED_ACTIONS.has(a) && !documented.includes(a)), []);
    assertEq(documented.filter(a => !code.includes(a)), []);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
