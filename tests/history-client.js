#!/usr/bin/env node
// Client-side unit tests for history page helpers. Runs in Node with browser
// globals stubbed; no network, DOM implementation, or server required.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');

// -- ANSI helpers -------------------------------------------------------------
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
  if (aStr !== bStr)
    throw new Error(msg || `expected ${bStr}, got ${aStr}`);
}

async function assertRejects(fn, expectedMessage) {
  try {
    await fn();
  } catch (e) {
    if (expectedMessage !== undefined)
      assertEq(e.message, expectedMessage);
    return;
  }
  throw new Error('expected rejection');
}

function makeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    style: {},
    className: '',
    previousElementSibling: null,
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    addEventListener() {},
    appendChild() {},
    focus() {},
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    closest() { return null; },
  };
}

function loadHistoryContext() {
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
    location: { reload() {} },
    sessionStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    window: {
      location: { hash: '' },
      open() {},
      print() {},
    },
    document: {
      documentElement: { style: { setProperty() {}, removeProperty() {} } },
      getElementById: getElement,
      querySelector: () => null,
      createElement: tag => makeElement(tag),
    },
    loadConfig: () => new Promise(() => {}),
    applyNav() {},
    updateAuthIndicator() {},
    escHtml: value => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    formatLength: value => `${value ?? 0}:00`,
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
  };
  context.window.window = context.window;
  context.window.document = context.document;
  context.window.sessionStorage = context.sessionStorage;
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;

  vm.createContext(context);
  const source = fs.readFileSync(path.join(REPO_ROOT, 'app/js/setlist-history.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'app/js/setlist-history.js' });
  return context;
}

(async () => {
  console.log(B('\nhistory page response helpers'));
  const ctx = loadHistoryContext();

  await test('readJsonResponse returns parsed body for successful JSON responses', async () => {
    const payload = { rows: [1, 2, 3] };
    const result = await ctx.readJsonResponse({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    assertEq(result, payload);
  });

  await test('readJsonResponse throws API error text for failed responses', async () => {
    await assertRejects(
      () => ctx.readJsonResponse({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Gig name is required' }),
      }),
      'Gig name is required'
    );
  });

  await test('readJsonResponse falls back to HTTP status when error body is unavailable', async () => {
    await assertRejects(
      () => ctx.readJsonResponse({
        ok: false,
        status: 502,
        json: async () => { throw new Error('invalid json'); },
      }),
      'Request failed (502)'
    );
  });

  await test('readJsonArray rejects non-array success payloads', async () => {
    await assertRejects(
      () => ctx.readJsonArray({
        ok: true,
        status: 200,
        json: async () => ({ error: 'not an array' }),
      }),
      'Invalid response: expected an array'
    );
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
  assert(total > 0, 'no tests ran');
  process.exit(failed > 0 ? 1 : 0);
})();
