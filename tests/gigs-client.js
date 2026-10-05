#!/usr/bin/env node
// Client-side unit tests for gigs.js helpers.
// gigs.js needs a DOM at load time, so the helper under test is extracted by name
// and evaluated on its own.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const GIGS_SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/gigs.js'), 'utf8');

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

// Pulls one top-level `function name(...) { ... }` out of the source by brace matching.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in app/js/gigs.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function loadIsUpcoming() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(`${extractFunction(GIGS_SRC, '_gigIsUpcoming')}; this.fn = _gigIsUpcoming;`, context);
  return context.fn;
}

// generatePosterBlob with a stub image and canvas: returns the canvas sizes it drew.
function loadPosterBlob(width, height, bytesPerPixel) {
  const drawn = [];
  const context = {
    console,
    document: {
      createElement() {
        const c = { width: 0, height: 0,
          getContext: () => ({ drawImage() {} }),
          toBlob(cb, type, quality) { drawn.push({ w: c.width, h: c.height, type, quality }); cb({ size: c.width * c.height * bytesPerPixel }); } };
        return c;
      },
    },
    _loadImage: async () => ({ naturalWidth: width, naturalHeight: height }),
  };
  vm.createContext(context);
  const src = GIGS_SRC.match(/var POSTER_MAX_EDGE = \d+;/)[0] +
    ['_canvasToJpegBlob', '_posterCanvas'].map(n => extractFunction(GIGS_SRC, n)).join('\n') +
    '\nasync ' + extractFunction(GIGS_SRC, 'generatePosterBlob');
  vm.runInContext(`${src}; this.fn = generatePosterBlob;`, context);
  return { generate: () => context.fn({}), drawn };
}

(async () => {
  console.log(B('\ngigs: poster downscaling'));

  {
    const { generate, drawn } = loadPosterBlob(4000, 3000, 0.1);
    await generate();
    test('a 12-MP photo is cut to 2000 px on the long edge', () => {
      assert(drawn.length === 1, `expected one encode, got ${drawn.length}`);
      assert(drawn[0].w === 2000 && drawn[0].h === 1500, `got ${drawn[0].w}x${drawn[0].h}`);
      assert(drawn[0].type === 'image/jpeg' && drawn[0].quality === 0.85, 'JPEG at 0.85');
    });
  }
  {
    const { generate, drawn } = loadPosterBlob(800, 1200, 0.1);
    await generate();
    test('a small image is never upscaled', () => {
      assert(drawn[0].w === 800 && drawn[0].h === 1200, `got ${drawn[0].w}x${drawn[0].h}`);
    });
  }
  {
    const { generate, drawn } = loadPosterBlob(4000, 3000, 5);
    await generate();
    test('a poster still over 5 MB steps down, then lowers quality', () => {
      assert(drawn.map(d => d.w).join(',') === '2000,1600,1200,1200', drawn.map(d => d.w).join(','));
      assert(drawn[3].quality === 0.6, 'last resort at quality 0.6');
    });
  }

  console.log(B('\ngigs: add-to-calendar only for upcoming gigs'));

  const isUpcoming = loadIsUpcoming();
  const day = 86400000;
  // UTC throughout — the helper compares against new Date().toISOString(), and mixing in
  // a local-midnight date would make this suite fail depending on the time of day.
  const iso = ts => new Date(ts).toISOString().slice(0, 10);

  test('a gig in the future is upcoming', () => {
    assert(isUpcoming(iso(Date.now() + 30 * day)) === true, 'expected true');
  });

  test("today's gig is still upcoming", () => {
    assert(isUpcoming(iso(Date.now())) === true, 'expected true for today');
  });

  test('yesterday is past', () => {
    assert(isUpcoming(iso(Date.now() - day)) === false, 'expected false');
  });

  test('an old gig is past', () => {
    assert(isUpcoming('2014-09-13') === false, 'expected false');
  });

  test('a full timestamp is accepted', () => {
    assert(isUpcoming(new Date(Date.now() + 2 * day).toISOString()) === true, 'expected true');
  });

  test('matches the upcoming/past split used by the gig tables', () => {
    // renderGigs: upcoming = g.date >= new Date().toISOString().slice(0,10)
    const today = new Date().toISOString().slice(0, 10);
    assert(isUpcoming(today) === (today >= today), 'today must agree with the table split');
    assert(isUpcoming('not-a-date') === false, 'garbage must not count as upcoming');
  });

  test('a missing date is not upcoming', () => {
    assert(isUpcoming(null) === false, 'expected false for null');
    assert(isUpcoming('') === false, 'expected false for empty string');
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
