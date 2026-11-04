// Two-set setlists: the break between the sets stays where the user put it,
// so a move, removal or addition never pushes a song into the other set.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const src = fs.readFileSync(path.join(__dirname, '../../app/js/setlist-generator.js'), 'utf8');
  const fn = name => {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`${name} not found`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
  };
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(['_moveInSets', '_removeFromSets', '_addToSets'].map(fn).join('\n') +
    ';this.move = _moveInSets; this.remove = _removeFromSets; this.add = _addToSets;', ctx);
  return ctx;
}

function run(r) {
  const { test, assertEq } = r;
  const { move, remove, add } = load();
  const ids = list => list.songs.map(s => s.id).join('');
  const L = (...n) => n.map(id => ({ id }));
  console.log('\nsetlist sets');

  test('a drag inside the first set keeps the break', () => {
    const out = move(L('a', 'b', 'c', 'd', 'e'), 3, 0, 2);
    assertEq(ids(out), 'bcade');
    assertEq(out.splitAt, 3);
  });
  test('a drag from the first set into the second moves the break up', () => {
    const out = move(L('a', 'b', 'c', 'd', 'e'), 3, 0, 4);
    assertEq(ids(out), 'bcdea');
    assertEq(out.splitAt, 2);
  });
  test('a drag from the second set into the first moves the break down', () => {
    const out = move(L('a', 'b', 'c', 'd', 'e'), 3, 4, 1);
    assertEq(ids(out), 'aebcd');
    assertEq(out.splitAt, 4);
  });
  test('without a break nothing is tracked', () => {
    const out = move(L('a', 'b', 'c'), null, 0, 2);
    assertEq(ids(out), 'bca');
    assertEq(out.splitAt, null);
  });
  test('removing from the first set moves the break up, from the second leaves it', () => {
    assertEq(remove(L('a', 'b', 'c', 'd'), 2, 0).splitAt, 1);
    assertEq(remove(L('a', 'b', 'c', 'd'), 2, 3).splitAt, 2);
  });
  test('adding to a set puts the song at the end of that set', () => {
    const first = add(L('a', 'b', 'c', 'd'), 2, { id: 'x' }, 1);
    assertEq(ids(first), 'abxcd');
    assertEq(first.splitAt, 3);
    const second = add(L('a', 'b', 'c', 'd'), 2, { id: 'x' }, 2);
    assertEq(ids(second), 'abcdx');
    assertEq(second.splitAt, 2);
  });
  test('adding without a break appends', () => {
    const out = add(L('a', 'b'), null, { id: 'x' }, 2);
    assertEq(ids(out), 'abx');
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
