// Escaping helpers the pages use: escHtml (core.js) and the CSV export cell
// (ui.js), loaded as the browser loads them.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = { document: { addEventListener() {} }, window: {}, console };
  vm.createContext(ctx);
  for (const f of ['core.js', 'ui.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/js', f), 'utf8'), ctx, { filename: f });
  return ctx;
}

function run(r) {
  const { test, assertEq } = r;
  const { escHtml, csvCell, onArg, _onParse } = load();

  console.log('\nclient escaping');

  test('escHtml escapes both quote kinds', () => {
    assertEq(escHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  // The attribute as the browser hands it to core.js: entities decoded.
  const decoded = a => a.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  test('onArg keeps any string one literal argument for the handler parser', () => {
    for (const v of ["a'b", "x'); f('y", 'back\\slash\\\'', '"<b>&amp;</b>"', '12', '']) {
      const steps = _onParse(decoded(`f(${onArg(v)}, 2)`));
      assertEq(steps.length, 1, `"${v}" broke out into ${steps.length} calls`);
      assertEq(steps[0].args.length, 2, `"${v}" changed the argument count`);
      assertEq(steps[0].args[0].lit, v);
    }
  });

  test('onArg output is safe inside a double-quoted attribute', () => {
    const a = onArg(`"><img src=x>'`);
    assertEq(/["<>]/.test(a), false, a);
  });

  test('csvCell neutralises spreadsheet formulas', () => {
    assertEq(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
    assertEq(csvCell('+1+1'), "'+1+1");
    assertEq(csvCell('-2+3'), "'-2+3");
    assertEq(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assertEq(csvCell('\tx'), "'\tx");
  });

  test('csvCell leaves numbers and plain text alone', () => {
    assertEq(csvCell('-3'), '-3');
    assertEq(csvCell('+4.5'), '+4.5');
    assertEq(csvCell('12'), '12');
    assertEq(csvCell('Song, live'), '"Song, live"');
    assertEq(csvCell(null), '');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
