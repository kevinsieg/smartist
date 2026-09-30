// Every <label> in a page names a field: it points at one with for="id", wraps
// the control, or is referenced by aria-labelledby (a caption for a group of
// controls or a read-only value). A label that names nothing leaves the field
// without an accessible name and makes tapping the label do nothing.
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '../../app');

function labelProblems(html) {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const labelledBy = new Set([...html.matchAll(/aria-labelledby="([^"]+)"/g)]
    .flatMap(m => m[1].split(/\s+/)));
  const problems = [];
  for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
    const [, attrs, inner] = m;
    const forId = (attrs.match(/\bfor="([^"]+)"/) || [])[1];
    const ownId = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (forId) {
      if (!ids.has(forId)) problems.push(`for="${forId}" points at no element`);
      continue;
    }
    if (/<(input|select|textarea)\b/.test(inner)) continue;
    if (ownId && labelledBy.has(ownId)) continue;
    problems.push(m[0].replace(/\s+/g, ' ').slice(0, 80));
  }
  return problems;
}

function run(r) {
  const { test, assert, B } = r;
  console.log(B('\nform labels'));
  test('the check catches a label that names nothing', () =>
    assert(labelProblems('<label>Name</label><input id="n">').length === 1, 'not caught'));
  for (const f of fs.readdirSync(APP_DIR).filter(f => f.endsWith('.html'))) {
    test(`${f}: every <label> names a field`, () => {
      const p = labelProblems(fs.readFileSync(path.join(APP_DIR, f), 'utf8'));
      assert(!p.length, p.join('\n        '));
    });
  }
}

module.exports = run;
