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
  // The page loads the shared chord helpers before the songs files.
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'app/js/chords.js'), 'utf8'), ctx, { filename: 'app/js/chords.js' });

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

  // Edit opened before the stored text arrived (or its fetch failed) leaves the
  // editor empty; saving then would replace the lyrics with nothing.
  async function saveWith(song) {
    const calls = [];
    ctx.apiFetch = async (...a) => { calls.push(a); return { ok: true, json: async () => ({}) }; };
    ctx.songs = [song];
    ctx.currentLyricsSid = song.id;
    let error = null;
    try { await ctx.saveLyrics(); } catch (e) { error = e; }
    return { calls, error };
  }

  const notLoaded = await saveWith({ id: 5, title: 'x', has_lyrics: true });
  test('saveLyrics sends nothing while the stored lyrics have not loaded', () => {
    assert(!notLoaded.error, notLoaded.error && notLoaded.error.message);
    assert(notLoaded.calls.length === 0, `PUT sent before the lyrics loaded: ${JSON.stringify(notLoaded.calls[0])}`);
  });

  const none = await saveWith({ id: 6, title: 'y', has_lyrics: false });
  test('saveLyrics still saves a song known to have no lyrics', () => {
    assert(none.calls.length === 1, `expected one PUT, got ${none.calls.length}`);
  });

  const loaded = await saveWith({ id: 7, title: 'z', has_lyrics: true, lyrics: 'la' });
  test('saveLyrics still saves once the lyrics have loaded', () => {
    assert(loaded.calls.length === 1, `expected one PUT, got ${loaded.calls.length}`);
  });

  // A normal sign-in keeps the token in sessionStorage, which a new tab only
  // inherits from its opener — target="_blank" alone implies noopener.
  test('links that open the stage view in a new tab keep their opener', () => {
    const bad = [];
    for (const f of fs.readdirSync(path.join(REPO_ROOT, 'app/js'))) {
      if (!f.endsWith('.js')) continue;
      fs.readFileSync(path.join(REPO_ROOT, 'app/js', f), 'utf8').split('\n').forEach((line, i) => {
        if (/\/stage\?/.test(line) && /target="_blank"/.test(line) && !/rel="opener"/.test(line)) bad.push(`${f}:${i + 1}`);
      });
    }
    assert(bad.length === 0, `stage links without rel="opener": ${bad.join(', ')}`);
  });

  // Opening the editor for another song starts that song untransposed.
  ctx.songs = [{ id: 8, title: 'w', lyrics: 'la' }];
  ctx._lyricsSteps = 3;
  let openError = null;
  try { await ctx.openLyricsEdit(8); } catch (e) { openError = e; }
  test('openLyricsEdit resets transpose for the song it opens', () => {
    assert(!openError, openError && openError.message);
    assert(ctx._lyricsSteps === 0, `transpose still ${ctx._lyricsSteps}`);
  });

  // Tab in the lyrics editor moves text (a chord) to the next 4-column stop;
  // Shift+Tab takes up to 4 spaces back.
  function tabIn(value, at, shiftKey) {
    const ta = { value, selectionStart: at, selectionEnd: at,
      setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; } };
    let prevented = false;
    ctx.lyricsEditKey({ key: 'Tab', shiftKey: !!shiftKey, target: ta, preventDefault() { prevented = true; } });
    return { value: ta.value, at: ta.selectionStart, prevented };
  }
  test('Tab in the lyrics editor inserts spaces to the next 4-column stop', () => {
    const r = tabIn('G     C\nla', 6);
    assert(r.prevented, 'Tab should not leave the editor');
    assert(r.value === 'G       C\nla' && r.at === 8, JSON.stringify(r));
    const r2 = tabIn('ab\nC', 3);
    assert(r2.value === 'ab\n    C', JSON.stringify(r2));
  });
  test('Shift+Tab takes back up to 4 spaces before the cursor', () => {
    const r = tabIn('G      C', 7, true);
    assert(r.value === 'G   C' && r.at === 4, JSON.stringify(r));
    const r2 = tabIn('G C', 2, true);
    assert(r2.value === 'GC', JSON.stringify(r2));
  });
  test('other keys are left alone', () => {
    let prevented = false;
    ctx.lyricsEditKey({ key: 'a', target: {}, preventDefault() { prevented = true; } });
    assert(!prevented, 'only Tab is handled');
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
