#!/usr/bin/env node
// Client-side unit tests for songs.js helpers.
// songs.js needs a DOM at load time, so the helpers are extracted and run on their own.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/songs.js'), 'utf8');
const COMMON = fs.readFileSync(path.join(REPO_ROOT, 'app/js/core.js'), 'utf8');

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
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function extractFunction(src, name, where) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${where || 'app/js/songs.js'}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Both helpers read the page-level `songs` array, which the context provides.
function load(songs) {
  const context = { console, songs };
  vm.createContext(context);
  vm.runInContext(
    `${extractFunction(SRC, '_getSongsForFactory')}\n${extractFunction(SRC, '_availableGenres')}\n` +
    'this.getSongs = _getSongsForFactory; this.genres = _availableGenres;', context);
  return context;
}

// Tag filter helpers need songTags/bandTags from core.js.
function loadTags(songs) {
  const context = { console, songs };
  vm.createContext(context);
  vm.runInContext(
    `${extractFunction(COMMON, 'songTags', 'app/js/core.js')}\n${extractFunction(COMMON, 'bandTags', 'app/js/core.js')}\n` +
    `${extractFunction(SRC, '_getSongsForFactory')}\n${extractFunction(SRC, '_availableTags')}\n` +
    'this.getSongs = _getSongsForFactory; this.tags = _availableTags;', context);
  return context;
}

// energyLabel lives in core.js and is used by the songs list, panel and setlist page.
function loadEnergyLabel() {
  const context = { console, t: key => ({ 'songs.energyLow': 'low', 'songs.energyMiddle': 'middle',
                                          'songs.energyHigh': 'high' }[key] || key) };
  vm.createContext(context);
  vm.runInContext(`${extractFunction(COMMON, 'energyLabel', 'app/js/core.js')}; this.fn = energyLabel;`, context);
  return context.fn;
}

// formatDate lives in core.js; the locale comes from window.i18n.
function loadDateHelpers(locale) {
  const context = { console, window: { i18n: { getLocale: () => locale } } };
  vm.createContext(context);
  vm.runInContext(
    `${extractFunction(COMMON, 'localeTag', 'app/js/core.js')}
` +
    `${extractFunction(COMMON, 'formatDate', 'app/js/core.js')}
` +
    `${extractFunction(COMMON, 'formatTime', 'app/js/core.js')}
` +
    'this.formatDate = formatDate; this.formatTime = formatTime;', context);
  return context;
}
function loadFormatDate(locale) { return loadDateHelpers(locale).formatDate; }

const SONGS = [
  { id: 1, title: 'Ab in die Welt',  interpret: 'My Band', genre: 'World',  active: true },
  { id: 2, title: 'Wonderwall',      interpret: 'Oasis',       genre: 'Pop',    active: true },
  { id: 3, title: 'Skinny Love',     interpret: 'Bon Iver',    genre: 'Folk',   active: false },
  { id: 4, title: 'Toxicity',        interpret: 'SOAD',        genre: 'Rock',   active: false },
  { id: 5, title: 'Nutshell',        interpret: 'Alice in Chains', genre: 'Pop', active: true },
  { id: 6, title: 'Untagged',        interpret: 'Someone',     genre: '',       active: true },
];

(async () => {
  console.log(B('\nsongs: genre chips follow the other filters'));

  const { genres } = load(SONGS);

  test('lists every genre when nothing is filtered', () => {
    assertEq(genres({}), ['Folk', 'Pop', 'Rock', 'World']);
  });

  test('active-only hides genres that have no active song', () => {
    assertEq(genres({ active: true }), ['Pop', 'World']);
  });

  test('a title filter narrows the genres too', () => {
    assertEq(genres({ title: 'wonder' }), ['Pop']);
  });

  test('the genre filter itself does not narrow the list', () => {
    // otherwise selecting Pop would leave Pop as the only chip and you could never switch
    assertEq(genres({ active: true, genre: 'Pop' }), ['Pop', 'World']);
  });

  test('songs without a genre add no empty chip', () => {
    assert(genres({}).every(g => g !== '' && g != null), 'empty genre leaked into the chips');
  });

  test('interpret filter narrows the genres', () => {
    assertEq(genres({ interpret: 'oasis' }), ['Pop']);
  });

  console.log(B('\nsongs: energy shown as low/middle/high'));

  const energyLabel = loadEnergyLabel();

  test('1-3 is low, 4-7 middle, 8-10 high', () => {
    assertEq([1, 2, 3].map(energyLabel), ['low', 'low', 'low']);
    assertEq([4, 5, 7].map(energyLabel), ['middle', 'middle', 'middle']);
    assertEq([8, 9, 10].map(energyLabel), ['high', 'high', 'high']);
  });

  test('accepts the value as a string, as it comes from the API', () => {
    assertEq(energyLabel('5'), 'middle');
    assertEq(energyLabel(' 9 '), 'high');
  });

  test('values outside 1-10 still land in a band', () => {
    assertEq(energyLabel(0), 'low');
    assertEq(energyLabel(99), 'high');
  });

  test('empty stays empty', () => {
    assertEq(energyLabel(''), '');
    assertEq(energyLabel(null), '');
    assertEq(energyLabel(undefined), '');
  });

  console.log(B('\nsongs: dates follow the interface language'));

  test('German shows 22.01.2026', () => {
    assertEq(loadFormatDate('de')('2026-01-22'), '22.01.2026');
  });

  test('English and French show 22/01/26', () => {
    assertEq(loadFormatDate('en')('2026-01-22'), '22/01/26');
    assertEq(loadFormatDate('fr')('2026-01-22'), '22/01/26');
  });

  test('pads single digits', () => {
    assertEq(loadFormatDate('de')('2015-07-11'), '11.07.2015');
    assertEq(loadFormatDate('en')('2015-07-11'), '11/07/15');
  });

  test('accepts a full timestamp from the API', () => {
    assertEq(loadFormatDate('de')('2016-09-03T00:00:00.000Z'), '03.09.2016');
  });

  test('empty and invalid values render as empty', () => {
    const de = loadFormatDate('de');
    assertEq(de(null), '');
    assertEq(de(''), '');
    assertEq(de('not a date'), '');
  });

  test('falls back to the international format for an unknown locale', () => {
    assertEq(loadFormatDate('it')('2026-01-22'), '22/01/26');
  });

  test("short form drops the year, keeping each language's separator", () => {
    assertEq(loadFormatDate('de')('2026-01-22', 'short'), '22.01.');
    assertEq(loadFormatDate('en')('2026-01-22', 'short'), '22/01');
    assertEq(loadFormatDate('fr')('2026-01-22', 'short'), '22/01');
  });

  test('long form spells the month in the interface language', () => {
    assert(/Januar/.test(loadFormatDate('de')('2026-01-22', 'long')), 'German month name expected');
    assert(/January/.test(loadFormatDate('en')('2026-01-22', 'long')), 'English month name expected');
    assert(/janvier/.test(loadFormatDate('fr')('2026-01-22', 'long')), 'French month name expected');
  });

  test('time is 24-hour in every language', () => {
    const { formatTime } = loadDateHelpers('en');
    const t = formatTime(new Date('2026-01-22T19:05:00Z'));
    assert(/^\d{2}:\d{2}$/.test(t), 'expected HH:MM, got ' + t);
    assert(!/AM|PM/i.test(t), 'must not use AM/PM');
  });

  test('tag filter matches any selected tag', () => {
    const songs = [{ id: 1, title: 'A', tags: ['Liebe'] }, { id: 2, title: 'B', tags: ['Arbeit'] }, { id: 3, title: 'C', tags: [] }];
    const ctx = loadTags(songs);
    assertEq(ctx.getSongs({ tags: ['Liebe', 'Arbeit'] }).map(s => s.id), [1, 2]);
    assertEq(ctx.getSongs({ tags: [] }).map(s => s.id), [1, 2, 3]);
    assertEq(ctx.tags({ tags: ['Liebe'] }), ['Arbeit', 'Liebe']);
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
