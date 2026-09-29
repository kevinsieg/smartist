const { energyToScale, matchGenre, cleanTags } = require('../../api/_song_values');

function run(r) {
  const { test, assert, assertEq, B } = r;
  console.log(B('\nsong values — energy scale, genre keys'));

  test('energy: 0–10 integers kept', () => {
    assertEq(energyToScale(0), 0);
    assertEq(energyToScale('7'), 7);
    assertEq(energyToScale(10), 10);
  });
  test('energy: 11–100 read as percent', () => {
    assertEq(energyToScale('90'), 9);
    assertEq(energyToScale(45), 5);
    assertEq(energyToScale('100'), 10);
  });
  test('energy: decimals rounded', () => assertEq(energyToScale('6.4'), 6));
  test('energy: words map to the middle of their band', () => {
    assertEq(energyToScale('LOW'), 2);
    assertEq(energyToScale('Middle'), 5);
    assertEq(energyToScale('medium'), 5);
    assertEq(energyToScale('mid'), 5);
    assertEq(energyToScale(' high '), 8);
    assertEq(energyToScale('Slow'), 2);
    assertEq(energyToScale('FAST'), 8);
  });
  test('energy: empty → null', () => {
    assertEq(energyToScale(null), null);
    assertEq(energyToScale(''), null);
    assertEq(energyToScale('  '), null);
  });
  test('energy: unknown or out of range → undefined', () => {
    assertEq(energyToScale('Loud'), undefined);
    assertEq(energyToScale('-1'), undefined);
    assertEq(energyToScale('101'), undefined);
  });

  test('matchGenre reuses the stored spelling', () => {
    const known = ['Folk Rock', 'R&B'];
    assertEq(matchGenre('FOLK ROCK', known), 'Folk Rock');
    assertEq(matchGenre('folk-rock', known), 'Folk Rock');
    assertEq(matchGenre('r&b', known), 'R&B');
  });
  test('matchGenre keeps a new genre as typed', () => {
    assertEq(matchGenre('EDM', ['Folk']), 'EDM');
    assertEq(matchGenre(null, ['Folk']), null);
  });

  test('tags: not sent → null', () => assertEq(cleanTags(undefined, []), null));
  test('tags: null and [] clear', () => {
    assertEq(JSON.stringify(cleanTags(null, [])), '[]');
    assertEq(JSON.stringify(cleanTags([], [])), '[]');
  });
  test('tags: trimmed, empties dropped, deduped case-insensitively', () =>
    assertEq(JSON.stringify(cleanTags([' Liebe ', '', 'liebe', 'Arbeit'], [])), '["Liebe","Arbeit"]'));
  test('tags: known spelling wins', () =>
    assertEq(JSON.stringify(cleanTags(['la bretagne'], ['La Bretagne'])), '["La Bretagne"]'));
  test('tags: not an array → error', () => assert(cleanTags('Liebe', []).error));
  test('tags: non-string item → error', () => assert(cleanTags([3], []).error));
  test('tags: over 50 chars → error', () => assert(cleanTags(['x'.repeat(51)], []).error));
  test('tags: more than 10 → error', () =>
    assert(cleanTags(Array.from({ length: 11 }, (_, i) => 't' + i), []).error));
}

module.exports = run;
