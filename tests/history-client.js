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

function setHistoryState(ctx, state = {}) {
  const {
    allSongs = [],
    allSetlists = [],
    allGigs = [],
    currentView = 'setlists',
    filterName = '',
    filterSong = '',
    filterDateFrom = '',
    filterDateTo = '',
    songFilterIds = null,
  } = state;
  const songFilterExpr = songFilterIds === null
    ? 'null'
    : `new Set(${JSON.stringify(songFilterIds)})`;

  vm.runInContext(`
    allSongs = ${JSON.stringify(allSongs)};
    allSetlists = ${JSON.stringify(allSetlists)};
    allGigs = ${JSON.stringify(allGigs)};
    currentView = ${JSON.stringify(currentView)};
    filterName = ${JSON.stringify(filterName)};
    filterSong = ${JSON.stringify(filterSong)};
    filterDateFrom = ${JSON.stringify(filterDateFrom)};
    filterDateTo = ${JSON.stringify(filterDateTo)};
    songFilterIds = ${songFilterExpr};
    songTimer = null;
  `, ctx);
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

  console.log(B('\nhistory page filters'));

  await test('filteredSetlists uses gig date before saved date and combines filters', async () => {
    setHistoryState(ctx, {
      allSetlists: [
        { id: 1, title: 'Acoustic Night', gig_name: 'Festival', gig_date: '2026-03-10', created_at: '2026-05-01T10:00:00Z' },
        { id: 2, title: 'Acoustic Rehearsal', gig_name: 'Studio', gig_date: null, created_at: '2026-03-12T10:00:00Z' },
        { id: 3, title: 'Acoustic Brunch', gig_name: 'Cafe', gig_date: '2026-04-01', created_at: '2026-04-01T10:00:00Z' },
        { id: 4, title: 'Acoustic Afterparty', gig_name: 'Club', gig_date: '2026-02-28', created_at: '2026-03-15T10:00:00Z' },
      ],
      filterName: 'acoustic',
      filterDateFrom: '2026-03-01',
      filterDateTo: '2026-03-31',
      songFilterIds: [1, 2, 4],
    });

    assertEq(vm.runInContext('filteredSetlists().map(s => s.id)', ctx), [1, 2]);
  });

  await test('filteredGigs applies inclusive date bounds and excludes unscheduled gigs when bounded', async () => {
    setHistoryState(ctx, {
      allGigs: [
        { id: 10, name: 'Town Hall', date: '2026-03-01' },
        { id: 11, name: 'River Hall', date: '2026-03-31T20:00:00Z' },
        { id: 12, name: 'Future Hall', date: null },
        { id: 13, name: 'Garden Hall', date: '2026-04-01' },
      ],
      filterName: 'hall',
      filterDateFrom: '2026-03-01',
      filterDateTo: '2026-03-31',
    });

    assertEq(vm.runInContext('filteredGigs().map(g => g.id)', ctx), [10, 11]);
  });

  await test('setView clears song filters when switching to gigs', async () => {
    setHistoryState(ctx, {
      allGigs: [{ id: 20, name: 'Release Hall', date: '2026-05-10' }],
      currentView: 'setlists',
      filterSong: 'banjo',
      songFilterIds: [],
    });
    const songInput = ctx.document.getElementById('filter-song');
    songInput.value = 'banjo';
    songInput.hidden = false;

    ctx.setView('gigs');

    assertEq(vm.runInContext('filterSong', ctx), '');
    assertEq(vm.runInContext('songFilterIds === null', ctx), true);
    assertEq(songInput.value, '');
    assertEq(songInput.hidden, true);
    assert(
      ctx.document.getElementById('history-content').innerHTML.includes('Release Hall'),
      'expected gigs view to render after clearing setlist-only song filter'
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
