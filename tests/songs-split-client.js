#!/usr/bin/env node
// songs.js was split into five files that share one global scope and are loaded in the
// order songs.html lists them. This suite executes them in that order against a stub DOM:
// it fails if a file is missing from the page, if the order is wrong, or if a function was
// lost or duplicated in a future move.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(REPO_ROOT, 'app/songs.html'), 'utf8');

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

// The order the page loads them in — songs.js last, because it calls init().
function pageScripts() {
  return [...PAGE.matchAll(/<script src="\/app\/js\/(songs[\w-]*)\.js\?v=\d+"><\/script>/g)].map(m => m[1] + '.js');
}

// Enough of a DOM for top-level listener registration; the page boot itself is skipped.
function makeContext() {
  const el = () => ({
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; },
    querySelector() { return null; }, classList: { add() {}, remove() {}, toggle() {} },
    style: {}, dataset: {}, focus() {}, click() {},
  });
  const ctx = {
    console,
    init() {},                     // songs.js calls init() at the end
    initPage() {},
    isViewMode: () => false,
    isMobile: () => false,
    getToken: () => 'tok',
    t: k => k,
    escHtml: s => String(s == null ? '' : s),
    formatDate: () => '', energyLabel: () => '', MUSICAL_KEYS: [], apiFetch: async () => ({ ok: true, json: async () => ({}) }),
    loadConfig: async () => ({}), invalidateConfigCache() {}, createListView: () => ({}),
    setStatus() {}, openModal() {}, closeModal() {}, registerModal() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [], body: el() },
    setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  ctx.window = ctx;
  return ctx;
}

(async () => {
  console.log(B('\nsongs page: split files load as one program'));

  const scripts = pageScripts();

  test('the page loads every songs*.js file in app/js', () => {
    const onDisk = fs.readdirSync(path.join(REPO_ROOT, 'app/js'))
      .filter(f => /^songs[\w-]*\.js$/.test(f)).sort();
    assert(onDisk.length === scripts.length,
      `page loads ${scripts.join(', ')} but app/js has ${onDisk.join(', ')}`);
  });

  test('songs.js loads last — it calls init()', () => {
    assert(scripts[scripts.length - 1] === 'songs.js', `last script is ${scripts[scripts.length - 1]}`);
  });

  const ctx = makeContext();
  vm.createContext(ctx);

  test('all files execute in page order without throwing', () => {
    for (const file of scripts) {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'app/js', file), 'utf8');
      vm.runInContext(src, ctx, { filename: 'app/js/' + file });
    }
  });

  // One entry point per split file: if a move drops or renames one, this fails.
  const REQUIRED = {
    'renderRow':              'bulk-edit table',
    'collectRow':             'bulk-edit table',
    'saveAll':                'bulk-edit table',
    'openPlayer':             'media',
    'handleAudioFile':        'media',
    'openSheet':              'media',
    'openPlayback':           'media',
    'openLyrics':             'lyrics',
    'saveLyrics':             'lyrics',
    'openUrlPreview':         'lyrics/preview',
    '_openSongPanelContent':  'side panel',
    '_savePanelSong':         'side panel',
    'toggleFavourite':        'list view',
    'renderListRowHtml':      'list view',
    'fetchSongsList':         'data',
  };
  Object.entries(REQUIRED).forEach(([fn, where]) => {
    test(`${fn}() is defined (${where})`, () => {
      assert(typeof ctx[fn] === 'function', `${fn} missing after the split`);
    });
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
