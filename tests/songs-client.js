#!/usr/bin/env node
// Client-side unit tests for songs.js helpers.
// songs.js needs a DOM at load time, so the helpers are extracted and run on their own.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/songs.js'), 'utf8');

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

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in app/js/songs.js`);
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

const SONGS = [
  { id: 1, title: 'Ab in die Welt',  interpret: 'Kevin Klang', genre: 'World',  active: true },
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
