const path = require('path');
const { LYRICS_SOURCES, plainFromSynced } =
  require(path.join(__dirname, '../../api/_lyrics'));

function run(r) {
  const { test, assertEq, B } = r;

  console.log(B('\nlyrics helpers'));

  test('LYRICS_SOURCES preserves provider fallback order', () => {
    assertEq(LYRICS_SOURCES, ['lyrics.ovh', 'lrclib', 'ai']);
  });
  test('plainFromSynced strips LRCLIB timestamp markers and trims text', () => {
    assertEq(
      plainFromSynced('  [00:12.34]First line\n[01:02.03]Second line  '),
      'First line\nSecond line'
    );
  });
  test('plainFromSynced keeps non-timestamp bracketed lyrics text', () => {
    assertEq(
      plainFromSynced('[Intro]\n[00:01.00]Sing it'),
      '[Intro]\nSing it'
    );
  });
  test('plainFromSynced nullish input → empty string', () => {
    assertEq(plainFromSynced(null), '');
    assertEq(plainFromSynced(undefined), '');
  });
  return runAiGate(r);
}

// suggestLyrics with the free sources missing: does the paid AI step run?
async function runAiGate(r) {
  const { testAsync, assertEq, B } = r;
  console.log(B('\nlyrics AI gate'));

  const api = p => path.join(__dirname, '../../api', p);
  const stubs = {
    [api('_domain/songs.js')]: { lyricsSearchInfo: async () => ({ title: 'T', interpret: 'A' }) },
    [api('_logger.js')]:       { info: async () => {}, warn: async () => {}, error: async () => {} },
  };
  // counts: the day's count each key reaches with this request.
  async function attempt({ allowAI, counts = {}, who = 'a@x.test' }) {
    let aiCalls = 0;
    const saved = {};
    const alarms = [];
    const all = {
      ...stubs,
      [api('_ratelimit.js')]: {
        checkRateLimit: async () => false,
        countInWindows: async list => new Map(list.map(({ key }) => [key, counts[key] ?? 1])),
        alarmAt: async (n, key, threshold) => { if (n === threshold + 1) alarms.push(key); },
        personKey: (prefix, w) => `${prefix}:${String(w).toLowerCase()}`,
      },
      [api('_ai.js')]:        { suggestLyricsWithAI: async () => { aiCalls++; return { lyrics: 'x'.repeat(60) }; } },
    };
    for (const [f, exports] of Object.entries(all)) {
      saved[f] = require.cache[f];
      require.cache[f] = { id: f, filename: f, loaded: true, exports };
    }
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404 });
    try {
      const { suggestLyrics } = require(api('_lyrics.js'));
      const res = await suggestLyrics(null, { id: 1, slug: 'b' }, 5, '127.0.0.1', { allowAI, who });
      return { aiCalls, res, alarms };
    } finally {
      global.fetch = realFetch;
      for (const f of Object.keys(all)) {
        if (saved[f]) require.cache[f] = saved[f]; else delete require.cache[f];
      }
    }
  }
  const L = require(api('_lyrics.js'));

  await testAsync('a member session reaches the AI step', async () => {
    const { aiCalls, res } = await attempt({ allowAI: true });
    assertEq(aiCalls, 1);
    assertEq(res.body.source, 'ai');
  });
  await testAsync('the demo session never reaches the AI step', async () => {
    const { aiCalls, res } = await attempt({ allowAI: false });
    assertEq(aiCalls, 0);
    assertEq(res.body.aiSkipped, true);
  });
  // A hard stop at the alarm let a few free accounts switch AI lyrics off for
  // every band for the day.
  await testAsync('everyone together past the daily alarm raises it once and nobody is refused', async () => {
    const { aiCalls, alarms } = await attempt({ allowAI: true, counts: { 'lyrics-ai-day': L.AI_DAILY_ALARM + 1 } });
    assertEq(aiCalls, 1);
    assertEq(alarms, ['lyrics-ai-day']);
  });
  await testAsync('only the hard cost ceiling, far above the alarm, stops the AI step for everyone', async () => {
    const { aiCalls } = await attempt({ allowAI: true, counts: { 'lyrics-ai-day': L.AI_DAILY_MAX + 1 } });
    assertEq(aiCalls, 0);
    assertEq(L.AI_DAILY_MAX >= L.AI_DAILY_ALARM * 5, true);
  });
  await testAsync('a band over its own daily AI cap stops at the free sources', async () => {
    const { aiCalls, res } = await attempt({ allowAI: true, counts: { 'lyrics-ai-day:1': L.AI_BAND_DAILY_MAX + 1 } });
    assertEq(aiCalls, 0);
    assertEq(res.body.aiSkipped, true);
  });
  await testAsync('a person over their daily AI cap across all bands stops at the free sources', async () => {
    const { aiCalls } = await attempt({ allowAI: true, who: 'A@x.test', counts: { 'lyrics-ai-person:a@x.test': L.AI_PERSON_DAILY_MAX + 1 } });
    assertEq(aiCalls, 0);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
