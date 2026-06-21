#!/usr/bin/env node
// Client-side unit tests for home.js stored-session validation.
// home.js is evaluated in a vm sandbox with stubbed browser globals so we can
// call its functions directly without a DOM.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const HOME_SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/home.js'), 'utf8')
  .replace(/\ninit\(\);\s*$/, ''); // drop the auto-run so eval has no side effects

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ${G('✓')} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${R('✗')} ${name}`);
    console.log(`      ${R(e.message)}`);
    failures.push({ name, error: e.message });
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function makeStorage() {
  const data = new Map();
  return {
    setItem(k, v) { data.set(k, String(v)); },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    removeItem(k) { data.delete(k); },
  };
}

function makeContext(fetchImpl) {
  const context = {
    atob, Date, URLSearchParams, console,
    fetch: fetchImpl,
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
  };
  vm.createContext(context);
  vm.runInContext(HOME_SRC, context, { filename: 'app/js/home.js' });
  context.artistSlug = 'testband';
  return context;
}

(async () => {
  console.log(B('\nhome session validation'));

  await test('valid stored token is validated via my-artists (Bearer), not the password endpoint', async () => {
    let request = null;
    const ctx = makeContext(async (url, opts) => {
      request = { url, opts: opts || {} };
      return { ok: true, status: 200, json: async () => ({ artists: [{ slug: 'band', name: 'Band', role: 'admin' }] }) };
    });
    const res = await ctx.verifySession('tok-123');
    assertEq(res.ok, true);
    assertEq(res.artists.length, 1);
    assert(request.url.indexOf('action=my-artists') !== -1, 'must call the my-artists endpoint, got ' + request.url);
    assert(request.url.indexOf('/auth') === -1, 'must NOT post the token to the password/auth endpoint');
    assertEq(request.opts.headers.Authorization, 'Bearer tok-123');
  });

  await test('invalid or expired stored token (401) reports not logged in', async () => {
    const ctx = makeContext(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorised' }) }));
    const res = await ctx.verifySession('stale-token');
    assertEq(res.ok, false);
    assertEq(res.artists.length, 0);
  });

  await test('network error during session check reports not logged in', async () => {
    const ctx = makeContext(async () => { throw new Error('offline'); });
    const res = await ctx.verifySession('tok');
    assertEq(res.ok, false);
    assertEq(res.artists.length, 0);
  });

  console.log(`\n${B('─'.repeat(40))}`);
  console.log(`${G(`${passed} passed`)}  ${failed ? R(`${failed} failed`) : D('0 failed')}`);
  if (failures.length) {
    console.log(R('\nFailed:'));
    failures.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.error}`));
  }
  assert(passed + failed > 0, 'no tests ran');
  process.exit(failed > 0 ? 1 : 0);
})();
