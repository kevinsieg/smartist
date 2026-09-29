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
  const { escHtml, csvCell } = load();

  console.log('\nclient escaping');

  test('escHtml escapes both quote kinds', () => {
    assertEq(escHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
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
