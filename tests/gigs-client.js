#!/usr/bin/env node
// Client-side unit tests for gigs.js helpers.
// gigs.js needs a DOM at load time, so the helper under test is extracted by name
// and evaluated on its own.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const GIGS_SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/gigs.js'), 'utf8');

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

// Pulls one top-level `function name(...) { ... }` out of the source by brace matching.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in app/js/gigs.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function loadIsUpcoming() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(`${extractFunction(GIGS_SRC, '_gigIsUpcoming')}; this.fn = _gigIsUpcoming;`, context);
  return context.fn;
}

(async () => {
  console.log(B('\ngigs: add-to-calendar only for upcoming gigs'));

  const isUpcoming = loadIsUpcoming();
  const day = 86400000;
  const iso = ts => new Date(ts).toISOString().slice(0, 10);

  test('a gig in the future is upcoming', () => {
    assert(isUpcoming(iso(Date.now() + 30 * day)) === true, 'expected true');
  });

  test("today's gig is still upcoming", () => {
    assert(isUpcoming(iso(Date.now())) === true, 'expected true for today');
  });

  test('yesterday is past', () => {
    assert(isUpcoming(iso(Date.now() - day)) === false, 'expected false');
  });

  test('an old gig is past', () => {
    assert(isUpcoming('2014-09-13') === false, 'expected false');
  });

  test('a full timestamp is accepted', () => {
    assert(isUpcoming(new Date(Date.now() + 2 * day).toISOString()) === true, 'expected true');
  });

  test('a missing date is not upcoming', () => {
    assert(isUpcoming(null) === false, 'expected false for null');
    assert(isUpcoming('') === false, 'expected false for empty string');
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
