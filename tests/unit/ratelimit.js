const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

const { clientIp } =
  require(path.join(__dirname, '../../api/_ratelimit'));

function run(r) {
  const { test, assertEq, B } = r;

  console.log(B('\nrate-limit helpers'));

  test('clientIp uses x-real-ip when present', () => {
    assertEq(
      clientIp({ headers: { 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }),
      '5.5.5.5'
    );
  });
  test('clientIp trims x-real-ip whitespace', () => {
    assertEq(clientIp({ headers: { 'x-real-ip': ' 2001:db8::1 ' } }), '2001:db8::1');
  });
  test('clientIp falls back to leftmost x-forwarded-for when x-real-ip absent', () => {
    assertEq(
      clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }),
      '1.2.3.4'
    );
  });
  test('clientIp trims forwarded-for whitespace', () => {
    assertEq(clientIp({ headers: { 'x-forwarded-for': ' 203.0.113.10 , 10.0.0.2' } }), '203.0.113.10');
  });
  test('clientIp single forwarded-for value', () => {
    assertEq(clientIp({ headers: { 'x-forwarded-for': '203.0.113.10' } }), '203.0.113.10');
  });
  test('clientIp missing both headers → unknown', () => {
    assertEq(clientIp({ headers: {} }), 'unknown');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
