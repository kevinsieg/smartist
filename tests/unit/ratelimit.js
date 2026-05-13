const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

const { clientIp, isMissingRateLimitTable } =
  require(path.join(__dirname, '../../api/_ratelimit'));

function run(r) {
  const { test, assertEq, B } = r;

  console.log(B('\nrate-limit helpers'));

  test('clientIp uses first forwarded IP before proxies', () => {
    assertEq(
      clientIp({ headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' } }),
      '203.0.113.10'
    );
  });
  test('clientIp trims forwarded IP whitespace', () => {
    assertEq(clientIp({ headers: { 'x-forwarded-for': ' 2001:db8::1 ' } }), '2001:db8::1');
  });
  test('clientIp missing forwarded header → unknown', () => {
    assertEq(clientIp({ headers: {} }), 'unknown');
  });
  test('isMissingRateLimitTable detects PostgreSQL undefined_table errors', () => {
    assertEq(isMissingRateLimitTable({ code: '42P01', message: 'relation "rate_limits" does not exist' }), true);
  });
  test('isMissingRateLimitTable detects Neon missing relation messages', () => {
    assertEq(isMissingRateLimitTable({ message: 'relation "rate_limits" does not exist' }), true);
  });
  test('isMissingRateLimitTable ignores unrelated database errors', () => {
    assertEq(isMissingRateLimitTable({ code: '08006', message: 'connection failure' }), false);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
