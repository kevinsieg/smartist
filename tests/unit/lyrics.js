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
  async function attempt({ allowAI, capped, bandCapped = false }) {
    let aiCalls = 0;
    const saved = {};
    const all = {
      ...stubs,
      [api('_ratelimit.js')]: { checkRateLimit: async key =>
        key === 'lyrics-ai-day' ? capped : key === 'lyrics-ai-day:1' ? bandCapped : false },
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
      const res = await suggestLyrics(null, { id: 1, slug: 'b' }, 5, '127.0.0.1', { allowAI });
      return { aiCalls, res };
    } finally {
      global.fetch = realFetch;
      for (const f of Object.keys(all)) {
        if (saved[f]) require.cache[f] = saved[f]; else delete require.cache[f];
      }
    }
  }

  await testAsync('a member session reaches the AI step', async () => {
    const { aiCalls, res } = await attempt({ allowAI: true, capped: false });
    assertEq(aiCalls, 1);
    assertEq(res.body.source, 'ai');
  });
  await testAsync('the demo session never reaches the AI step', async () => {
    const { aiCalls, res } = await attempt({ allowAI: false, capped: false });
    assertEq(aiCalls, 0);
    assertEq(res.body.aiSkipped, true);
  });
  await testAsync('the daily AI cap stops the AI step for everyone', async () => {
    const { aiCalls } = await attempt({ allowAI: true, capped: true });
    assertEq(aiCalls, 0);
  });
  await testAsync('a band over its own daily AI cap stops at the free sources', async () => {
    const { aiCalls, res } = await attempt({ allowAI: true, capped: false, bandCapped: true });
    assertEq(aiCalls, 0);
    assertEq(res.body.aiSkipped, true);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
