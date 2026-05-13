const path = require('path');
const { keyFromUrl, filenameFromUrl } =
  require(path.join(__dirname, '../../api/_r2'));

function run(r) {
  const { test, assertEq, B } = r;

  console.log(B('\nR2 URL helpers'));

  const ORIGINAL = process.env.R2_PUBLIC_URL;
  process.env.R2_PUBLIC_URL = 'https://cdn.example.test/media';

  test('keyFromUrl extracts object key under configured public URL', () => {
    assertEq(
      keyFromUrl('https://cdn.example.test/media/audio/abc-Track.mp3'),
      'audio/abc-Track.mp3'
    );
  });
  test('keyFromUrl returns null for unrelated URL', () => {
    assertEq(keyFromUrl('https://other.example.test/media/audio/abc-Track.mp3'), null);
  });
  test('filenameFromUrl strips query string and decodes filename', () => {
    assertEq(
      filenameFromUrl('https://cdn.example.test/media/audio/abc-My%20Song.mp3?token=123'),
      'abc-My Song.mp3'
    );
  });

  if (ORIGINAL === undefined) {
    delete process.env.R2_PUBLIC_URL;
  } else {
    process.env.R2_PUBLIC_URL = ORIGINAL;
  }
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
