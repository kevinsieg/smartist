'use strict';
// Stage view: the font-size search behind Fit and the columns mode, taken from
// stage.js as the browser runs it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSearch() {
  const src = fs.readFileSync(path.join(__dirname, '../../app/js/stage.js'), 'utf8');
  const start = src.indexOf('function _stageFitSearch(');
  if (start === -1) throw new Error('_stageFitSearch not found in app/js/stage.js');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.fn = _stageFitSearch;', ctx);
  return ctx.fn;
}

function run(r) {
  const { test, assertEq } = r;
  console.log('\nstage fit');
  const search = loadSearch();

  test('finds the largest whole size that still fits', () => {
    assertEq(search(px => px <= 31.4, 8, 96), 31);
    assertEq(search(px => px <= 50, 8, 96), 50);
  });

  test('stays at the minimum when nothing fits, reaches the maximum when everything does', () => {
    assertEq(search(() => false, 8, 96), 8);
    assertEq(search(() => true, 8, 96), 96);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
