const path = require('path');
const { keyFromUrl, filenameFromUrl } =
  require(path.join(__dirname, '../../api/_r2'));

// Loads a fresh _r2 against a stubbed S3 SDK whose send() either succeeds or
// throws, so deleteFromR2's reported result can be checked.
function loadR2WithStubbedSdk(sendFails) {
  const sdkPath = require.resolve('@aws-sdk/client-s3');
  const r2Path  = require.resolve(path.join(__dirname, '../../api/_r2'));
  const realSdk = require.cache[sdkPath];
  delete require.cache[r2Path];
  require.cache[sdkPath] = {
    id: sdkPath, filename: sdkPath, loaded: true,
    exports: {
      S3Client: class { async send() { if (sendFails) throw new Error('storage unavailable'); return {}; } },
      PutObjectCommand: class {}, DeleteObjectCommand: class {}, HeadObjectCommand: class {},
    },
  };
  const mod = require(path.join(__dirname, '../../api/_r2'));
  return {
    mod,
    restore() {
      if (realSdk) require.cache[sdkPath] = realSdk; else delete require.cache[sdkPath];
      delete require.cache[r2Path];
    },
  };
}

async function run(r) {
  const { test, testAsync, assertEq, B } = r;

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
  test('keyFromUrl does not take a host that merely starts like the bucket\'s', () => {
    assertEq(keyFromUrl('https://cdn.example.test/media.evil.example/audio/x.mp3'), null);
    assertEq(keyFromUrl('https://cdn.example.test/mediaX/audio/x.mp3'), null);
  });
  test('filenameFromUrl strips query string and decodes filename', () => {
    assertEq(
      filenameFromUrl('https://cdn.example.test/media/audio/abc-My%20Song.mp3?token=123'),
      'abc-My Song.mp3'
    );
  });

  // Callers decrement artists.storage_used_bytes only when the object really
  // went away, so the swallowed storage error has to surface as a return value.
  console.log(B('\ndeleteFromR2 result'));

  await testAsync('reports success when the object is removed', async () => {
    const { mod, restore } = loadR2WithStubbedSdk(false);
    try {
      assertEq(await mod.deleteFromR2('https://cdn.example.test/media/audio/abc.mp3'), true);
    } finally { restore(); }
  });

  await testAsync('reports failure when storage rejects the delete', async () => {
    const { mod, restore } = loadR2WithStubbedSdk(true);
    try {
      assertEq(await mod.deleteFromR2('https://cdn.example.test/media/audio/abc.mp3'), false);
    } finally { restore(); }
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
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
