const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

function makeRunner() {
  let passed = 0, failed = 0;
  const failures = [];

  return {
    B,
    test(name, fn) {
      try {
        fn();
        console.log(`  ${G('✓')} ${name}`);
        passed++;
      } catch (e) {
        console.log(`  ${R('✗')} ${name}`);
        console.log(`      ${R(e.message)}`);
        failures.push({ name, error: e.message });
        failed++;
      }
    },
    assert(cond, msg) {
      if (!cond) throw new Error(msg || 'assertion failed');
    },
    assertEq(a, b, msg) {
      const aStr = JSON.stringify(a);
      const bStr = JSON.stringify(b);
      if (aStr !== bStr)
        throw new Error(msg || `expected ${bStr}, got ${aStr}`);
    },
    summary() {
      console.log(`\n${B('─'.repeat(40))}`);
      console.log(
        `${G(`${passed} passed`)}  ` +
        `${failed ? R(`${failed} failed`) : D('0 failed')}`
      );
      if (failures.length) {
        console.log(R('\nFailed:'));
        failures.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.error}`));
      }
      return failed;
    },
    get passed() { return passed; },
    get failed() { return failed; },
  };
}

module.exports = { makeRunner };
