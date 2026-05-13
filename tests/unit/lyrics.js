const path = require('path');
const { LYRICS_SOURCES, plainFromSynced } =
  require(path.join(__dirname, '../../api/_lyrics'));

function run(r) {
  const { test, assertEq, B } = r;

  console.log(B('\nlyrics helpers'));

  test('LYRICS_SOURCES preserves provider fallback order', () => {
    assertEq(LYRICS_SOURCES, ['lyrics.ovh', 'lrclib', 'ai']);
  });
  test('plainFromSynced strips LRCLIB timestamp markers and trims text', () => {
    assertEq(
      plainFromSynced('  [00:12.34]First line\n[01:02.03]Second line  '),
      'First line\nSecond line'
    );
  });
  test('plainFromSynced keeps non-timestamp bracketed lyrics text', () => {
    assertEq(
      plainFromSynced('[Intro]\n[00:01.00]Sing it'),
      '[Intro]\nSing it'
    );
  });
  test('plainFromSynced nullish input → empty string', () => {
    assertEq(plainFromSynced(null), '');
    assertEq(plainFromSynced(undefined), '');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
