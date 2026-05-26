#!/usr/bin/env node
// Client-side unit tests for setlist-history.js redirect stub.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const HISTORY_SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/setlist-history.js'), 'utf8');

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
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
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr) throw new Error(msg || `expected ${bStr}, got ${aStr}`);
}

function runHistoryScript(context) {
  vm.createContext(context);
  vm.runInContext(HISTORY_SRC, context, { filename: 'app/js/setlist-history.js' });
}

(async () => {
  console.log(B('\nsetlist-history redirect'));

  test('uses SPA navigate when available', () => {
    let navigated = null;
    const context = {
      console,
      navigate: href => { navigated = href; },
      window: { location: { replace() { throw new Error('should not replace'); } } },
    };
    runHistoryScript(context);
    assertEq(navigated, '/setlist?view=history');
  });

  test('falls back to location.replace without navigate', () => {
    let replaced = null;
    const context = {
      console,
      window: { location: { replace: url => { replaced = url; } } },
    };
    runHistoryScript(context);
    assertEq(replaced, '/setlist?view=history');
  });

  const total = passed + failed;
  console.log(`\n${B('─'.repeat(40))}`);
  console.log(`${G(`${passed} passed`)}  ${failed ? R(`${failed} failed`) : D('0 failed')}`);
  if (failures.length) {
    console.log(R('\nFailed:'));
    failures.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.error}`));
  }
  assert(total > 0, 'no tests ran');
  process.exit(failed > 0 ? 1 : 0);
})();
