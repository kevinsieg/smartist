const path = require('path');

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  const { resolveArtist, isSlugAvailable, getArtistsForUser } =
    require(path.join(__dirname, '../../api/_domain/artist'));

  console.log(B('\nresolveArtist'));

  await testAsync('returns artist when slug matches', async () => {
    const ARTIST = { id: 1, slug: 'myband', name: 'My Band', config: {} };
    const sql = async (strings, ...vals) => [ARTIST];
    const result = await resolveArtist('myband', sql);
    assertEq(result.slug, 'myband');
  });

  await testAsync('returns null when no row', async () => {
    const sql = async () => [];
    const result = await resolveArtist('ghost', sql);
    assertEq(result, null);
  });

  await testAsync('falls back to ARTIST_SLUG env when slug is empty', async () => {
    process.env.ARTIST_SLUG = 'envband';
    const ARTIST = { id: 2, slug: 'envband', name: 'Env Band', config: {} };
    const sql = async (strings, ...vals) => [ARTIST];
    const result = await resolveArtist('', sql);
    assertEq(result.slug, 'envband');
    delete process.env.ARTIST_SLUG;
  });

  await testAsync('returns null when both slug and env are empty', async () => {
    delete process.env.ARTIST_SLUG;
    const sql = async () => [];
    const result = await resolveArtist('', sql);
    assertEq(result, null);
  });

  console.log(B('\nisSlugAvailable'));

  await testAsync('returns true when no artist with that slug', async () => {
    const sql = async () => [{ count: '0' }];
    const result = await isSlugAvailable('newband', sql);
    assertEq(result, true);
  });

  await testAsync('returns false when slug already taken', async () => {
    const sql = async () => [{ count: '1' }];
    const result = await isSlugAvailable('takenband', sql);
    assertEq(result, false);
  });

  await testAsync('returns false for reserved slug "login"', async () => {
    const sql = async () => [{ count: '0' }];
    const result = await isSlugAvailable('login', sql);
    assertEq(result, false);
  });

  await testAsync('returns false for reserved slug "signup"', async () => {
    const sql = async () => [{ count: '0' }];
    const result = await isSlugAvailable('signup', sql);
    assertEq(result, false);
  });

  console.log(B('\ngetArtistsForUser'));

  await testAsync('returns workspace list for a user', async () => {
    const ROWS = [
      { slug: 'band-a', name: 'Band A', role: 'admin' },
      { slug: 'band-b', name: 'Band B', role: 'member' },
    ];
    const sql = async () => ROWS;
    const result = await getArtistsForUser(42, sql);
    assertEq(result.length, 2);
    assertEq(result[0].slug, 'band-a');
    assertEq(result[1].role, 'member');
  });

  await testAsync('returns empty array when user has no artists', async () => {
    const sql = async () => [];
    const result = await getArtistsForUser(99, sql);
    assertEq(result.length, 0);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
