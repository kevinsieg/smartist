#!/usr/bin/env node
// Client-side unit tests for home.js auth token handling.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const HOME_SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/home.js'), 'utf8')
  .replace(/\ninit\(\);\s*$/, '');

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr) throw new Error(msg || `expected ${bStr}, got ${aStr}`);
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
    atob,
    Date,
    fetch: fetchImpl,
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
  };
  vm.createContext(context);
  vm.runInContext(HOME_SRC, context, { filename: 'app/js/home.js' });
  context.artistSlug = 'testband';
  return context;
}

function userToken(exp) {
  return Buffer.from(JSON.stringify({
    payload: JSON.stringify({ userId: 1, role: 'admin', exp }),
  })).toString('base64url');
}

(async () => {
  console.log(B('\nhome auth token handling'));

  await test('valid stored user JWT is accepted without legacy password POST', async () => {
    const context = makeContext(async () => {
      throw new Error('fetch should not be called for a valid user token');
    });
    const ok = await context.verifyToken(userToken(Date.now() + 60_000));
    assertEq(ok, true);
  });

  await test('legacy bootstrap token still verifies through auth endpoint', async () => {
    let request = null;
    const context = makeContext(async (url, opts) => {
      request = { url, opts };
      return { ok: true, json: async () => ({ ok: true, adminEmail: 'admin@example.com' }) };
    });
    const ok = await context.verifyToken('legacy-password');
    assertEq(ok, true);
    assertEq(request.url, '/api/testband/auth');
    assertEq(JSON.parse(request.opts.body), { password: 'legacy-password' });
    assertEq(context.sessionStorage.getItem('smartist_admin_email'), 'admin@example.com');
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
