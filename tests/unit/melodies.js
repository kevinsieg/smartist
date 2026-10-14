'use strict';

const path = require('path');
const { MELODY_LIMITS, IMAGE_EXTS, IMAGE_TYPES, instrumentKnown } =
  require(path.join(__dirname, '../../api/_domain/melodies'));

function run(r) {
  const { test, assert, assertEq, B } = r;
  console.log(B('\nmelodies domain'));
  const band = { config: { arrangementConfig: { instruments: [{ key: 'TEN', label: 'Tenor' }, { key: 'BAR2', label: 'Bariton 2' }] } } };

  test('limits are the agreed caps', () => {
    assertEq(MELODY_LIMITS, { perSong: 20, images: 8, imageBytes: 5 * 1024 * 1024, audioBytes: 50 * 1024 * 1024 });
  });
  test('image types are jpeg and png only', () => {
    assertEq([...IMAGE_EXTS].sort(), ['jpeg', 'jpg', 'png']);
    assertEq([...IMAGE_TYPES].sort(), ['image/jpeg', 'image/png']);
  });
  test('instrumentKnown accepts a configured key', () => assert(instrumentKnown(band, 'BAR2')));
  test('instrumentKnown refuses an unknown key', () => assert(!instrumentKnown(band, 'XYZ')));
  test('instrumentKnown refuses non-strings', () => {
    assert(!instrumentKnown(band, null));
    assert(!instrumentKnown(band, { key: 'TEN' }));
  });
  test('instrumentKnown is false when the band has no instruments', () => {
    assert(!instrumentKnown({ config: {} }, 'TEN'));
    assert(!instrumentKnown({}, 'TEN'));
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
