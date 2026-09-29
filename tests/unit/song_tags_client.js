// Song tag helpers in core.js, loaded as the browser loads them.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const ctx = { document: { addEventListener() {} }, window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../app/js/core.js'), 'utf8'), ctx, { filename: 'core.js' });
  return ctx;
}

// _finalizeOrder from the generator, with capo ordering stubbed out.
function loadFinalize() {
  const ctx = load();
  const src = fs.readFileSync(path.join(__dirname, '../../app/js/setlist-generator.js'), 'utf8');
  const fn = name => {
    const start = src.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
  };
  vm.runInContext(`function applyCapoOpts(s) { return s; }\n${fn('computeSplitIndex')}\n${fn('_finalizeOrder')}`, ctx);
  return ctx;
}

function run(r) {
  const { test, assertEq } = r;
  const { songTags, bandTags, orderByFirstTag, tagGroupStarts } = load();
  console.log('\nsong tags (client)');
  const S = (id, tags) => ({ id, tags });

  test('songTags tolerates missing tags', () => assertEq(songTags({}).length, 0));
  test('bandTags distinct and sorted', () =>
    assertEq(bandTags([S(1, ['b', 'a']), S(2, ['a'])]).join(), 'a,b'));
  test('orderByFirstTag is stable, untagged last', () => {
    const out = orderByFirstTag([S(1, []), S(2, ['b']), S(3, ['a', 'b']), S(4, ['b']), S(5, ['a'])]);
    assertEq(out.map(s => s.id).join(), '3,5,2,4,1');
  });
  test('tagGroupStarts marks changes of first tag', () => {
    const starts = tagGroupStarts([S(1, ['a']), S(2, ['a']), S(3, ['b']), S(4, [])]);
    assertEq([...starts].join(), '0,2,3');
  });
  test('grouping keeps each song in the set it was split into', () => {
    const { _finalizeOrder } = loadFinalize();
    const L = (id, len, tags) => ({ id, length_min: len, tags });
    // Split after B (2+10 >= 9). Grouping puts B first in set 1, which alone would
    // reach half — the break must still come after A and B.
    const out = _finalizeOrder([L('A', 2, ['z']), L('B', 10, ['a']), L('C', 6, [])], true, true);
    assertEq(out.songs.map(s => s.id).join(), 'B,A,C');
    assertEq(out.splitAt, 2);
  });
  test('without split there is no break', () => {
    const { _finalizeOrder } = loadFinalize();
    const out = _finalizeOrder([{ id: 1, tags: ['b'] }, { id: 2, tags: ['a'] }], false, true);
    assertEq(out.songs.map(s => s.id).join(), '2,1');
    assertEq(out.splitAt, null);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
