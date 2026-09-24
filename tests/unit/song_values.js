const { energyToScale, genreKey, titleCaseGenre, matchGenre, proposeGenreMap } = require('../../api/_song_values');

function run(r) {
  const { test, assertEq, B } = r;
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

  test('genreKey ignores case, spaces and punctuation', () => {
    assertEq(genreKey("Rock'n'Roll"), genreKey('rock n roll'));
    assertEq(genreKey('SINGER-SONGWRITER'), genreKey('Singer Songwriter'));
  });
  test('genreKey keeps & so R&B and RB differ', () => assertEq(genreKey('R&B') === genreKey('RB'), false));

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

  test('proposeGenreMap: most used spelling wins, shouting and lower case are Title-Cased', () => {
    const map = proposeGenreMap([
      { value: 'Folk Rock', n: 5 }, { value: 'FOLK ROCK', n: 2 }, { value: 'folk-rock', n: 1 },
      { value: 'POP', n: 3 }, { value: 'Jazz', n: 1 },
    ]);
    assertEq(JSON.stringify(map), JSON.stringify({ 'FOLK ROCK': 'Folk Rock', 'folk-rock': 'Folk Rock', POP: 'Pop' }));
  });

  test('titleCaseGenre', () => {
    assertEq(titleCaseGenre('ROCK'), 'Rock');
    assertEq(titleCaseGenre('singer-songwriter'), 'Singer-Songwriter');
    assertEq(titleCaseGenre('  folk   rock '), 'Folk Rock');
    assertEq(titleCaseGenre('country/western'), 'Country/Western');
  });
}

module.exports = run;
