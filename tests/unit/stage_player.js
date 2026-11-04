// Stage view setlist player: which songs it plays, taken from stage.js as the
// browser runs it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const src = fs.readFileSync(path.join(__dirname, '../../app/js/stage.js'), 'utf8');
  const part = marker => {
    const start = src.indexOf(marker);
    if (start === -1) throw new Error(`${marker} not found in app/js/stage.js`);
    return start;
  };
  const fn = name => {
    const start = part(`function ${name}(`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
  };
  const re = src.slice(part('var _STAGE_AUDIO_RE'), src.indexOf('\n', part('var _STAGE_AUDIO_RE')));
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${re}\n${fn('_stageListenUrl')}\n${fn('_stagePlaylist')}\n${fn('_stageMakeOrder')}\n${fn('_stageStepAt')}\n${fn('_stageClock')}\nthis.list = _stagePlaylist; this.order = _stageMakeOrder; this.step = _stageStepAt; this.clock = _stageClock;`, ctx);
  return ctx;
}

function run(r) {
  const { test, assertEq } = r;
  const { list, order, step, clock } = load();
  console.log('\nstage player');

  const song = (title, listenUrl) => ({ title, extra: listenUrl === undefined ? {} : { listenUrl } });

  test('plays songs with a listen file, in setlist order, and skips the rest', () => {
    const out = list([song('A', 'https://m/a.mp3'), song('B'), song('C', 'https://m/c.m4a?x=1'), { title: 'D' }]);
    assertEq(out.map(x => x.title), ['A', 'C']);
    assertEq(out.map(x => x.i), [0, 2]);
    assertEq(out[1].url, 'https://m/c.m4a?x=1');
  });
  test('a link that is not an audio file (a video page) is skipped', () => {
    assertEq(list([song('A', 'https://www.youtube.com/watch?v=1'), song('B', '')]).length, 0);
  });
  test('an empty or missing setlist gives an empty queue', () => {
    assertEq(list([]).length, 0);
    assertEq(list(undefined).length, 0);
  });

  test('without shuffle the order is the setlist\'s own', () => {
    assertEq(order(4, false, 2), [0, 1, 2, 3]);
  });
  test('shuffle starts at the chosen song and plays every song once', () => {
    const out = order(5, true, 3, () => 0.5);
    assertEq(out[0], 3);
    assertEq(out.slice().sort(), [0, 1, 2, 3, 4]);
  });
  test('shuffle with no chosen song still plays every song once', () => {
    assertEq(order(4, true, -1, () => 0.1).slice().sort(), [0, 1, 2, 3]);
  });
  test('stepping stops past either end unless the repeat is all', () => {
    assertEq(step(3, 1, 1, 'off'), 2);
    assertEq(step(3, 2, 1, 'off'), -1);
    assertEq(step(3, 0, -1, 'off'), -1);
    assertEq(step(3, 2, 1, 'all'), 0);
    assertEq(step(3, 0, -1, 'all'), 2);
    assertEq(step(1, 0, 1, 'all'), 0);
  });
  test('the clock reads m:ss, and h:mm:ss from an hour', () => {
    assertEq(clock(0), '0:00');
    assertEq(clock(65.9), '1:05');
    assertEq(clock(3725), '1:02:05');
    assertEq(clock(NaN), '0:00');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
