'use strict';
// SPA navigation (navigate() in common.js) re-inserts a page's <body> scripts and
// runs them again in the SAME document. Top-level const/let live in the shared
// global lexical scope, so a second execution throws "Identifier ... has already
// been declared" and the whole file aborts before init() runs — the page silently
// fails to load until a hard refresh. Re-declaring var is harmless.
const fs   = require('fs');
const path = require('path');

const APP = path.join(__dirname, '../../app');

function bodyScriptNames(html) {
  const bodyStart = html.indexOf('<body');
  const body = bodyStart === -1 ? html : html.slice(bodyStart);
  const names = [];
  const re = /<script[^>]+src="\/app\/js\/([A-Za-z0-9_-]+)\.js/g;
  let m;
  while ((m = re.exec(body)) !== null) names.push(m[1]);
  return names;
}

function run(r) {
  const { test, assert, B } = r;

  console.log(B('\nSPA page scripts'));

  // Only pages that load common.js are SPA-navigated; standalone pages
  // (stage, admin) always arrive in a fresh document.
  const spaScripts = new Set();
  fs.readdirSync(APP).filter(f => f.endsWith('.html')).forEach(function(page) {
    const names = bodyScriptNames(fs.readFileSync(path.join(APP, page), 'utf8'));
    if (!names.includes('common')) return;
    names.filter(n => n !== 'common').forEach(n => spaScripts.add(n));
  });

  test('finds the SPA page scripts', () => {
    assert(spaScripts.size > 0, 'no SPA page scripts found — selector is wrong');
  });

  spaScripts.forEach(function(name) {
    test(name + '.js declares no top-level const/let', () => {
      const file = path.join(APP, 'js', name + '.js');
      // Only column-0 declarations are global; indented ones are function-scoped.
      const offenders = fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /^(const|let)\s/.test(line))
        .map(({ line, n }) => `${name}.js:${n}  ${line.trim().slice(0, 70)}`);
      assert(offenders.length === 0,
        'top-level const/let breaks SPA re-execution:\n      ' + offenders.join('\n      '));
    });
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
