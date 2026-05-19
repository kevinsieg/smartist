#!/usr/bin/env node
// Client-side unit tests for the GEMA import login flow.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  OK ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`      ${e.message}`);
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
  if (aStr !== bStr)
    throw new Error(msg || `expected ${bStr}, got ${aStr}`);
}

function makeElement(id) {
  return {
    id,
    value: '',
    textContent: '',
    style: {},
    disabled: false,
  };
}

async function flushAsyncInit() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

async function loadGemaImportContext(fetchImpl) {
  const elements = new Map();
  const storage = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const context = {
    console,
    FileReader: function FileReader() {},
    setImmediate,
    window: {},
    document: {
      addEventListener() {},
      getElementById: getElement,
    },
    sessionStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    loadConfig: async () => ({ slug: 'test-band', name: 'Test Band', config: {} }),
    applyNav() {},
    updateAuthIndicator() {},
    fetch: fetchImpl,
  };
  context.window.window = context.window;
  context.window.document = context.document;
  context.window.sessionStorage = context.sessionStorage;

  vm.createContext(context);
  const source = fs.readFileSync(path.join(REPO_ROOT, 'app/js/gema-import.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'app/js/gema-import.js' });
  await flushAsyncInit();
  return { context, elements, storage };
}

(async () => {
  console.log('\nGEMA import client login');

  await test('successful password login stores the submitted credential', async () => {
    let request;
    const { context, elements, storage } = await loadGemaImportContext(async (url, opts) => {
      request = { url, opts };
      return { ok: true, json: async () => ({ ok: true }) };
    });

    context.document.getElementById('login-pw').value = 'correct horse battery staple';
    await context.doLogin();

    assertEq(request.url, '/api/test-band/auth');
    assertEq(JSON.parse(request.opts.body), { password: 'correct horse battery staple' });
    assertEq(storage.get('setlist_token'), 'correct horse battery staple');
    assertEq(elements.get('login-area').style.display, 'none');
    assertEq(elements.get('import-area').style.display, '');
  });

  await test('failed login keeps the credential out of session storage', async () => {
    const { context, elements, storage } = await loadGemaImportContext(async () => ({
      ok: false,
      json: async () => ({ error: 'Invalid password' }),
    }));

    context.document.getElementById('login-pw').value = 'wrong';
    await context.doLogin();

    assert(!storage.has('setlist_token'), 'token should not be stored');
    assertEq(elements.get('login-error').textContent, 'Wrong password.');
    assertEq(elements.get('login-error').style.display, '');
  });

  console.log(`\n${passed} passed  ${failed} failed`);
  if (failures.length) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  - ${f.name}\n    ${f.error}`));
  }
  process.exit(failed > 0 ? 1 : 0);
})();
