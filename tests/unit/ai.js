const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

const { suggestLyricsWithAI } =
  require(path.join(__dirname, '../../api/_ai'));

const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_FETCH = global.fetch;

async function withAiEnv(apiKey, fetchImpl, fn) {
  if (apiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = apiKey;
  }
  global.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    if (ORIGINAL_GEMINI_API_KEY === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_API_KEY;
    }
    global.fetch = ORIGINAL_FETCH;
  }
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nAI lyrics'));

  await testAsync('no API key → skipped without network call', async () => {
    let called = false;
    await withAiEnv(undefined, async () => { called = true; }, async () => {
      const result = await suggestLyricsWithAI('Song', 'Artist');
      assertEq(result, { lyrics: null, skipped: true });
      assertEq(called, false, 'fetch should not be called without an API key');
    });
  });

  await testAsync('Gemini response → strips markdown, citations, and URL-only links', async () => {
    let requestBody = null;
    const lyrics =
      '**Premier couplet** [1]\n' +
      'Une longue ligne de paroles en francais qui depasse largement la limite.\n' +
      '(https://example.test/source)\n' +
      '^2^Derniere ligne de chanson sans markdown.';

    await withAiEnv('test-key', async (_url, opts) => {
      requestBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: lyrics }] } }],
        }),
      };
    }, async () => {
      const result = await suggestLyricsWithAI('Titre', 'Artiste', { language: 'FR', genre: 'FOLK' });
      assert(result.lyrics.includes('Premier couplet'), `missing cleaned first line: ${result.lyrics}`);
      assert(result.lyrics.includes('Derniere ligne de chanson sans markdown.'), `missing cleaned last line: ${result.lyrics}`);
      assert(!result.lyrics.includes('**'), `markdown was not stripped: ${result.lyrics}`);
      assert(!result.lyrics.includes('[1]'), `citation index was not stripped: ${result.lyrics}`);
      assert(!result.lyrics.includes('https://'), `URL-only link was not stripped: ${result.lyrics}`);
      assert(!result.lyrics.includes('^2^'), `superscript citation was not stripped: ${result.lyrics}`);

      const prompt = requestBody.contents[0].parts[0].text;
      assert(prompt.includes('a folk song'), `missing genre hint in prompt: ${prompt}`);
      assert(prompt.includes('Return the lyrics in French.'), `missing French language instruction: ${prompt}`);
    });
  });

  await testAsync('provider quota response → null lyrics with skipped flag', async () => {
    await withAiEnv('test-key', async () => ({
      ok: false,
      status: 429,
      text: async () => 'quota exceeded',
    }), async () => {
      assertEq(await suggestLyricsWithAI('Song', 'Artist'), { lyrics: null, skipped: true });
    });
  });

  await testAsync('network failure → null lyrics without skipped flag', async () => {
    await withAiEnv('test-key', async () => {
      throw new Error('socket closed');
    }, async () => {
      assertEq(await suggestLyricsWithAI('Song', 'Artist'), { lyrics: null });
    });
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
