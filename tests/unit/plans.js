const path = require('path');
const {
  getPlan, hasFeature, storageLimitBytes, songLimit, planSummary, wouldExceedStorage,
} = require(path.join(__dirname, '../../api/_plans'));

function run(r) {
  const { test, assert, assertEq, B } = r;
  console.log(B('\n_plans registry'));

  const free = { config: {} };                 // no plan -> free
  const pro  = { config: { plan: 'pro' } };
  const bogus = { config: { plan: 'nope' } };   // unknown -> free fallback

  test('missing plan falls back to free', () => assertEq(getPlan(free).label, 'Free'));
  test('unknown plan falls back to free', () => assertEq(getPlan(bogus).label, 'Free'));
  test('pro resolves to Pro', () => assertEq(getPlan(pro).label, 'Pro'));

  test('free lacks venues', () => assertEq(hasFeature(free, 'venues'), false));
  test('free has songs', () => assertEq(hasFeature(free, 'songs'), true));
  test('pro has venues', () => assertEq(hasFeature(pro, 'venues'), true));

  test('free storage limit is 30MB in bytes', () => assertEq(storageLimitBytes(free), 30 * 1024 * 1024));
  test('pro storage unlimited', () => assertEq(storageLimitBytes(pro), null));
  test('free song limit 100', () => assertEq(songLimit(free), 100));
  test('pro song limit null', () => assertEq(songLimit(pro), null));

  test('wouldExceedStorage true when over free cap', () =>
    assertEq(wouldExceedStorage(free, 30 * 1024 * 1024, 1), true));
  test('wouldExceedStorage false under cap', () =>
    assertEq(wouldExceedStorage(free, 0, 1024), false));
  test('wouldExceedStorage always false for unlimited', () =>
    assertEq(wouldExceedStorage(pro, 9e15, 9e15), false));

  test('planSummary shape', () => {
    const s = planSummary(free);
    assertEq(s.key, 'free');
    assert(Array.isArray(s.features), 'features not array');
  });
}
module.exports = run;
