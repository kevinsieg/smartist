'use strict';
// Stage view: the font-size search behind Fit and the columns mode, taken from
// stage.js as the browser runs it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFn(name) {
  const src = fs.readFileSync(path.join(__dirname, '../../app/js/stage.js'), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found in app/js/stage.js');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.fn = ' + name + ';', ctx);
  return ctx.fn;
}

function run(r) {
  const { test, assertEq } = r;
  console.log('\nstage fit');
  const search = loadFn('_stageFitSearch');

  test('finds the largest whole size that still fits', () => {
    assertEq(search(px => px <= 31.4, 8, 96), 31);
    assertEq(search(px => px <= 50, 8, 96), 50);
  });

  test('stays at the minimum when nothing fits, reaches the maximum when everything does', () => {
    assertEq(search(() => false, 8, 96), 8);
    assertEq(search(() => true, 8, 96), 96);
  });

  test('a drag on the waveform maps to a position between 0 and 1', () => {
    const frac = loadFn('_stageWaveFrac');
    assertEq(frac(150, 100, 200), 0.25);
    assertEq(frac(50, 100, 200), 0);
    assertEq(frac(400, 100, 200), 1);
  });

  test('the speed button steps through the speeds and wraps', () => {
    const next = loadFn('_stageNextRate');
    assertEq(next(1), 0.9);
    assertEq(next(0.7), 1);
    assertEq(next(1.5), 1);
  });

  test('the setlist link opens the saved set on the setlist page', () => {
    const url = loadFn('_stageEditUrl');
    assertEq(url('band', 12), '/band/setlist?view=history&set=12');
    assertEq(url('', 12), '/setlist?view=history&set=12');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
