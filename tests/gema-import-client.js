#!/usr/bin/env node
// Client-side unit tests for GEMA import auth helpers. Runs in Node with browser
// globals stubbed; no network, DOM implementation, or server required.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');

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

function assertEq(a, b, msg) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr)
    throw new Error(msg || `expected ${bStr}, got ${aStr}`);
}

function makeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
  };
}

async function loadGemaImportContext(fetchImpl) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const storage = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    sessionStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    window: {},
    document: {
      getElementById: getElement,
      addEventListener() {},
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

  await new Promise(resolve => setImmediate(resolve));
  return { context, elements, storage };
}

(async () => {
  console.log(B('\nGEMA import auth'));

  await test('successful login stores submitted password as bearer token', async () => {
    const fetchCalls = [];
    const { context, elements, storage } = await loadGemaImportContext(async (url, opts) => {
      fetchCalls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    });

    elements.get('login-pw').value = 'correct horse battery staple';
    await context.doLogin();

    assertEq(fetchCalls.length, 1);
    assertEq(fetchCalls[0].url, '/api/test-band/auth');
    assertEq(
      JSON.parse(fetchCalls[0].opts.body),
      { password: 'correct horse battery staple' }
    );
    assertEq(storage.get('setlist_token'), 'correct horse battery staple');
  });

  const total = passed + failed;
  console.log(`\n${B('-'.repeat(40))}`);
  console.log(
    `${G(`${passed} passed`)}  ` +
    `${failed ? R(`${failed} failed`) : D('0 failed')}`
  );
  if (failures.length) {
    console.log(R('\nFailed:'));
    failures.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.error}`));
  }
  if (total === 0) throw new Error('no tests ran');
  process.exit(failed > 0 ? 1 : 0);
})();
