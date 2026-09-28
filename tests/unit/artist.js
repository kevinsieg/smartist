const path = require('path');

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { stubLogger } = require('./_runner');
  stubLogger();

  const { isSlugAvailable, getArtistsForUser } =
    require(path.join(__dirname, '../../api/_domain/artist'));

  console.log(B('\nisSlugAvailable'));

  await testAsync('returns true when no artist with that slug', async () => {
    const sql = async () => [{ exists: false }];
    const result = await isSlugAvailable('newband', sql);
    assertEq(result, true);
  });

  await testAsync('returns false when slug already taken', async () => {
    const sql = async () => [{ exists: true }];
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

  await testAsync('returns all artist workspaces for a user', async () => {
    let queryCalled = false;
    const ROWS = [
      { slug: 'band-a', name: 'Band A', role: 'admin' },
      { slug: 'band-b', name: 'Band B', role: 'member' },
    ];
    const sql = async (strings, ...vals) => {
      queryCalled = true;
      return ROWS;
    };
    const result = await getArtistsForUser(42, sql);
    assert(queryCalled, 'expected sql to be called');
    assertEq(result.length, 2);
    assertEq(result[0].slug, 'band-a');
    assertEq(result[1].role, 'member');
  });

  await testAsync('returns empty array when user has no artists', async () => {
    const sql = async () => [];
    const result = await getArtistsForUser(99, sql);
    assertEq(result.length, 0);
  });

  await testAsync('returns empty array when userId is null (silent — WHERE id = NULL returns no rows)', async () => {
    const sql = async () => [];
    const result = await getArtistsForUser(null, sql);
    assertEq(result.length, 0);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
