const path = require('path');
const {
  getPlan, hasFeature, storageLimitBytes, songLimit, planSummary,
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
  test('pro storage capped at 2 GB while Pro is a free switch', () => assertEq(storageLimitBytes(pro), 2048 * 1024 * 1024));
  test('free song limit 100', () => assertEq(songLimit(free), 100));
  test('pro song limit is finite while Pro is a free switch', () => assertEq(songLimit(pro), 5000));

  test('planSummary shape', () => {
    const s = planSummary(free);
    assertEq(s.key, 'free');
    assert(Array.isArray(s.features), 'features not array');
  });
}
module.exports = run;
