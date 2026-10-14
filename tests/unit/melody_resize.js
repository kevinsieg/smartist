'use strict';

// app/js/songs-melodies.js is a page script (no exports): the pure size helper
// is cut out of the source and run on its own.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name}() not found`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`could not brace-match ${name}()`);
}

function run(r) {
  const { test, assertEq, B } = r;
  console.log(B('\nmelody image size'));
  const src = fs.readFileSync(path.join(__dirname, '../../app/js/songs-melodies.js'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(extractFunction(src, 'melodyFitSize'), ctx);
  const fit = (w, h, max) => ctx.melodyFitSize(w, h, max);

  test('a wide photo is scaled so the long edge is the maximum', () => assertEq(fit(4000, 3000, 2000), { w: 2000, h: 1500 }));
  test('a tall photo is scaled the same way', () => assertEq(fit(3000, 4000, 2000), { w: 1500, h: 2000 }));
  test('a small image is never enlarged', () => assertEq(fit(1000, 800, 2000), { w: 1000, h: 800 }));
  test('a very thin image keeps at least one pixel', () => {
    const s = fit(1, 5000, 2000);
    assertEq(s.h, 2000);
    assertEq(s.w >= 1, true);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
