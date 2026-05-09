#!/usr/bin/env node
// Unit tests for pure modules — no external dependencies, no network, no DB.
//
// Usage:
//   node tests/unit.js
//   cd tests && node unit.js

const path = require('path');
const crypto = require('crypto');

const { validateSongIds, validateStr, validateNum, validateEmail } =
  require(path.join(__dirname, '../api/_validate'));
const { generateMagicToken, verifyMagicToken } =
  require(path.join(__dirname, '../api/_token'));
const { setlistTitle } =
  require(path.join(__dirname, '../api/_pdf'));
const { keyFromUrl, filenameFromUrl } =
  require(path.join(__dirname, '../api/_r2'));

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
const asyncTests = [];

function recordPass(name) {
  console.log(`  ${G('✓')} ${name}`);
  passed++;
}

function recordFailure(name, e) {
  console.log(`  ${R('✗')} ${name}`);
  console.log(`      ${R(e.message)}`);
  failures.push({ name, error: e.message });
  failed++;
}

function test(name, fn) {
  try {
    fn();
    recordPass(name);
  } catch (e) {
    recordFailure(name, e);
  }
}

function asyncTest(name, fn) {
  asyncTests.push({ name, fn });
}

function asyncSection(name) {
  asyncTests.push({ section: name });
}

async function runAsyncTests() {
  for (const { section, name, fn } of asyncTests) {
    if (section) {
      console.log(B(`\n${section}`));
      continue;
    }
    try {
      await fn();
      recordPass(name);
    } catch (e) {
      recordFailure(name, e);
    }
  }
}

// ── Assertions ───────────────────────────────────────────────────────────────
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr)
    throw new Error(msg || `expected ${bStr}, got ${aStr}`);
}

// ── validateSongIds ───────────────────────────────────────────────────────────

console.log(B('\nvalidateSongIds'));

test('valid array of positive integers → same ids returned', () => {
  assertEq(validateSongIds([1, 2, 3]), [1, 2, 3]);
});

test('single id → [id]', () => {
  assertEq(validateSongIds([42]), [42]);
});

test('empty array → []', () => {
  assertEq(validateSongIds([]), []);
});

test('null → null', () => {
  assertEq(validateSongIds(null), null);
});

test('string → null', () => {
  assertEq(validateSongIds('1,2,3'), null);
});

test('number → null', () => {
  assertEq(validateSongIds(5), null);
});

test('contains zero → null', () => {
  assertEq(validateSongIds([1, 0, 3]), null);
});

test('contains negative → null', () => {
  assertEq(validateSongIds([1, -2, 3]), null);
});

test('contains float → null', () => {
  assertEq(validateSongIds([1, 1.5, 3]), null);
});

test('contains non-number string → null', () => {
  assertEq(validateSongIds([1, 'abc', 3]), null);
});

test('contains NaN (as string "NaN") → null', () => {
  assertEq(validateSongIds([1, NaN, 3]), null);
});

test('duplicates → null', () => {
  assertEq(validateSongIds([1, 2, 2, 3]), null);
});

test('201 items → null', () => {
  const ids = Array.from({ length: 201 }, (_, i) => i + 1);
  assertEq(validateSongIds(ids), null);
});

test('200 items → array of 200', () => {
  const ids = Array.from({ length: 200 }, (_, i) => i + 1);
  const result = validateSongIds(ids);
  assert(Array.isArray(result), 'expected array');
  assertEq(result.length, 200);
  assertEq(result[0], 1);
  assertEq(result[199], 200);
});

// ── validateStr ───────────────────────────────────────────────────────────────

console.log(B('\nvalidateStr'));

test('valid string → trimmed value', () => {
  assertEq(validateStr('  hello  ', 20), 'hello');
});

test('null → null', () => {
  assertEq(validateStr(null, 10), null);
});

test('undefined → null', () => {
  assertEq(validateStr(undefined, 10), null);
});

test('empty string → null', () => {
  assertEq(validateStr('', 10), null);
});

test('whitespace only → null', () => {
  assertEq(validateStr('   ', 10), null);
});

test('exceeds maxLen → false', () => {
  assertEq(validateStr('hello', 4), false);
});

test('exactly at maxLen → string', () => {
  assertEq(validateStr('hi', 2), 'hi');
});

test('number input → coerced to string', () => {
  assertEq(validateStr(42, 10), '42');
});

test('string with interior whitespace preserved after trim', () => {
  assertEq(validateStr('  foo bar  ', 20), 'foo bar');
});

// ── validateNum ───────────────────────────────────────────────────────────────

console.log(B('\nvalidateNum'));

test('integer → number', () => {
  assertEq(validateNum(7), 7);
});

test('float → number', () => {
  assertEq(validateNum(3.14), 3.14);
});

test('negative → number', () => {
  assertEq(validateNum(-5), -5);
});

test('zero → 0', () => {
  assertEq(validateNum(0), 0);
});

test('numeric string → number', () => {
  assertEq(validateNum('12'), 12);
});

test('null → null', () => {
  assertEq(validateNum(null), null);
});

test('undefined → null', () => {
  assertEq(validateNum(undefined), null);
});

test('empty string → null', () => {
  assertEq(validateNum(''), null);
});

test('non-numeric string → false', () => {
  assertEq(validateNum('abc'), false);
});

test('Infinity → false', () => {
  assertEq(validateNum(Infinity), false);
});

test('-Infinity → false', () => {
  assertEq(validateNum(-Infinity), false);
});

test('NaN → false', () => {
  assertEq(validateNum(NaN), false);
});

// ── validateEmail ─────────────────────────────────────────────────────────────

console.log(B('\nvalidateEmail'));

test('valid email → lowercase normalised', () => {
  assertEq(validateEmail('User@Example.COM'), 'user@example.com');
});

test('already lowercase → unchanged', () => {
  assertEq(validateEmail('foo@bar.io'), 'foo@bar.io');
});

test('email with leading/trailing whitespace → trimmed', () => {
  assertEq(validateEmail('  test@test.org  '), 'test@test.org');
});

test('null → null', () => {
  assertEq(validateEmail(null), null);
});

test('empty string → null', () => {
  assertEq(validateEmail(''), null);
});

test('undefined → null', () => {
  assertEq(validateEmail(undefined), null);
});

test('no @ symbol → false', () => {
  assertEq(validateEmail('notanemail'), false);
});

test('no domain → false', () => {
  assertEq(validateEmail('user@'), false);
});

test('no TLD → false', () => {
  assertEq(validateEmail('user@domain'), false);
});

test('embedded space → false', () => {
  assertEq(validateEmail('user @domain.com'), false);
});

test('space in domain → false', () => {
  assertEq(validateEmail('user@do main.com'), false);
});

// ── generateMagicToken / verifyMagicToken ─────────────────────────────────────

console.log(B('\ngenerateMagicToken / verifyMagicToken'));

const HASH = crypto.randomBytes(32).toString('hex');
const WRONG_HASH = crypto.randomBytes(32).toString('hex');

test('returns a base64url string (no +, =, / chars)', () => {
  const token = generateMagicToken(HASH);
  assert(typeof token === 'string', 'not a string');
  assert(token.length > 0, 'empty token');
  assert(!/[+=/]/.test(token), `contains non-base64url chars: ${token}`);
});

test('fresh token verifies true with correct hash', () => {
  const token = generateMagicToken(HASH);
  assertEq(verifyMagicToken(token, HASH), true);
});

test('fresh token verifies false with wrong hash', () => {
  const token = generateMagicToken(HASH);
  assertEq(verifyMagicToken(token, WRONG_HASH), false);
});

test('tampered payload (changed expires) → false', () => {
  const token = generateMagicToken(HASH);
  const raw = JSON.parse(Buffer.from(token, 'base64url').toString());
  raw.expires += 1000; // alter expires without updating sig
  const tampered = Buffer.from(JSON.stringify(raw)).toString('base64url');
  assertEq(verifyMagicToken(tampered, HASH), false);
});

test('tampered payload (changed sig) → false', () => {
  const token = generateMagicToken(HASH);
  const raw = JSON.parse(Buffer.from(token, 'base64url').toString());
  raw.sig = raw.sig.replace(/[0-9a-f]/, c => (parseInt(c, 16) ^ 1).toString(16));
  const tampered = Buffer.from(JSON.stringify(raw)).toString('base64url');
  assertEq(verifyMagicToken(tampered, HASH), false);
});

test('expired token (past expires) → false', () => {
  // Construct a token with an expires timestamp 1 ms in the past
  const expires = Date.now() - 1;
  const sig = crypto.createHmac('sha256', HASH).update(String(expires)).digest('hex');
  const expired = Buffer.from(JSON.stringify({ expires, sig })).toString('base64url');
  assertEq(verifyMagicToken(expired, HASH), false);
});

test('garbage string → false (try/catch returns false)', () => {
  assertEq(verifyMagicToken('this-is-not-a-token', HASH), false);
});

test('null input → false', () => {
  assertEq(verifyMagicToken(null, HASH), false);
});

test('empty string → false', () => {
  assertEq(verifyMagicToken('', HASH), false);
});

test('valid JSON but missing fields → false', () => {
  const broken = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
  assertEq(verifyMagicToken(broken, HASH), false);
});

// ── setlistTitle ──────────────────────────────────────────────────────────────

console.log(B('\nsetlistTitle'));

test('title, gig name, and date → combined share/PDF title', () => {
  assertEq(setlistTitle({
    title: 'Festival Opener',
    gig_name: 'Summer Fest',
    gig_date: '2026-07-18T20:00:00.000Z',
  }), '"Festival Opener" — Summer Fest — 2026-07-18');
});

test('missing setlist title keeps gig details', () => {
  assertEq(setlistTitle({
    title: '',
    gig_name: 'Club Night',
    gig_date: '2026-02-03',
  }), 'Club Night — 2026-02-03');
});

test('empty setlist metadata → null', () => {
  assertEq(setlistTitle({ title: null, gig_name: null, gig_date: null }), null);
});

// ── R2 URL helpers ────────────────────────────────────────────────────────────

console.log(B('\nR2 URL helpers'));

const ORIGINAL_R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
process.env.R2_PUBLIC_URL = 'https://cdn.example.test/media';

test('keyFromUrl extracts object key under configured public URL', () => {
  assertEq(
    keyFromUrl('https://cdn.example.test/media/audio/abc-Track.mp3'),
    'audio/abc-Track.mp3'
  );
});

test('keyFromUrl returns null for unrelated URL', () => {
  assertEq(keyFromUrl('https://other.example.test/media/audio/abc-Track.mp3'), null);
});

test('filenameFromUrl strips query string and decodes filename', () => {
  assertEq(
    filenameFromUrl('https://cdn.example.test/media/audio/abc-My%20Song.mp3?token=123'),
    'abc-My Song.mp3'
  );
});

if (ORIGINAL_R2_PUBLIC_URL === undefined) {
  delete process.env.R2_PUBLIC_URL;
} else {
  process.env.R2_PUBLIC_URL = ORIGINAL_R2_PUBLIC_URL;
}

// ── AI lyrics helper ─────────────────────────────────────────────────────────

asyncSection('AI lyrics helper');

const AI_PATH = require.resolve(path.join(__dirname, '../api/_ai'));
const LOGGER_PATH = require.resolve(path.join(__dirname, '../api/_logger'));

async function withMockedAiLogger(fn) {
  const originalAi = require.cache[AI_PATH];
  const originalLogger = require.cache[LOGGER_PATH];
  require.cache[LOGGER_PATH] = {
    id: LOGGER_PATH,
    filename: LOGGER_PATH,
    loaded: true,
    exports: {
      info: async () => {},
      warn: async () => {},
      error: async () => {},
    },
  };
  delete require.cache[AI_PATH];
  try {
    return await fn(require(AI_PATH));
  } finally {
    if (originalAi) require.cache[AI_PATH] = originalAi;
    else delete require.cache[AI_PATH];
    if (originalLogger) require.cache[LOGGER_PATH] = originalLogger;
    else delete require.cache[LOGGER_PATH];
  }
}

async function withGeminiKeyAndFetch(key, fetchImpl, fn) {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'GEMINI_API_KEY');
  const originalKey = process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  if (key === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = key;
  global.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    if (hadKey) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
    global.fetch = originalFetch;
  }
}

asyncTest('missing API key skips AI fetch', async () => {
  let fetched = false;
  await withGeminiKeyAndFetch(undefined, async () => {
    fetched = true;
    throw new Error('fetch should not be called without an API key');
  }, async () => {
    await withMockedAiLogger(async ({ suggestLyricsWithAI }) => {
      assertEq(await suggestLyricsWithAI('Song', 'Artist'), { lyrics: null, skipped: true });
    });
  });
  assertEq(fetched, false);
});

asyncTest('Gemini response is parsed and markdown/citations are stripped', async () => {
  const rawLyrics =
    '## Song Title\n' +
    '**Line one** [1]\n' +
    '*Line two* (https://example.test/source)\n' +
    'Repeat the chorus again and again with enough words to pass the minimum length.';

  await withGeminiKeyAndFetch('test-gemini-key', async (url, opts) => {
    assert(url.endsWith('/models/gemini-2.0-flash:generateContent?key=test-gemini-key'),
      `unexpected Gemini URL: ${url}`);
    const body = JSON.parse(opts.body);
    const prompt = body.contents[0].parts[0].text;
    assert(prompt.includes('"Song Title" by "Artist Name"'), `prompt missing song context: ${prompt}`);
    assert(prompt.includes('a folk song'), `prompt missing genre hint: ${prompt}`);
    assert(prompt.includes('Return the lyrics in French.'), `prompt missing language instruction: ${prompt}`);
    assertEq(body.tools, [{ google_search: {} }]);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: rawLyrics }] } }],
      }),
    };
  }, async () => {
    await withMockedAiLogger(async ({ suggestLyricsWithAI }) => {
      const result = await suggestLyricsWithAI('Song Title', 'Artist Name', {
        language: 'FR',
        genre: 'FOLK',
      });
      assert(result.lyrics.includes('Song Title'), 'missing heading text');
      assert(result.lyrics.includes('Line one'), 'missing bold text after stripping');
      assert(result.lyrics.includes('Line two'), 'missing italic text after stripping');
      assert(!result.lyrics.includes('**'), 'bold markdown was not stripped');
      assert(!result.lyrics.includes('*Line'), 'italic markdown was not stripped');
      assert(!result.lyrics.includes('[1]'), 'citation marker was not stripped');
      assert(!result.lyrics.includes('https://'), 'inline link was not stripped');
    });
  });
});

asyncTest('AI provider 429 is reported as skipped instead of a lyric miss', async () => {
  await withGeminiKeyAndFetch('test-gemini-key', async () => ({
    ok: false,
    status: 429,
    text: async () => 'quota exceeded',
  }), async () => {
    await withMockedAiLogger(async ({ suggestLyricsWithAI }) => {
      assertEq(await suggestLyricsWithAI('Song', 'Artist'), { lyrics: null, skipped: true });
    });
  });
});

// ── Rate limit helpers ───────────────────────────────────────────────────────

asyncSection('Rate limit helpers');

const DB_PATH = require.resolve(path.join(__dirname, '../api/_db'));
const RATELIMIT_PATH = require.resolve(path.join(__dirname, '../api/_ratelimit'));

async function withMockedDb(sql, fn) {
  const originalDb = require.cache[DB_PATH];
  const originalRateLimit = require.cache[RATELIMIT_PATH];
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: { getDb: () => sql },
  };
  delete require.cache[RATELIMIT_PATH];
  try {
    return await fn(require(RATELIMIT_PATH));
  } finally {
    if (originalDb) require.cache[DB_PATH] = originalDb;
    else delete require.cache[DB_PATH];
    if (originalRateLimit) require.cache[RATELIMIT_PATH] = originalRateLimit;
    else delete require.cache[RATELIMIT_PATH];
  }
}

asyncTest('clientIp returns the first forwarded IP and trims whitespace', async () => {
  const { clientIp } = require(RATELIMIT_PATH);
  assertEq(
    clientIp({ headers: { 'x-forwarded-for': ' 203.0.113.10, 198.51.100.2 ' } }),
    '203.0.113.10'
  );
  assertEq(clientIp({ headers: {} }), 'unknown');
});

asyncTest('checkRateLimit allows requests at the max and blocks above it', async () => {
  const calls = [];
  const counts = [3, 4];
  const sql = async (strings, ...values) => {
    calls.push({ strings, values });
    return [{ count: counts.shift() }];
  };

  await withMockedDb(sql, async ({ checkRateLimit }) => {
    assertEq(await checkRateLimit('lyrics-suggest:1:2', 3, 300), false);
    assertEq(await checkRateLimit('lyrics-suggest:1:2', 3, 300), true);
  });

  assertEq(calls.length, 2);
  assertEq(calls[0].values[0], 'lyrics-suggest:1:2');
  assert(!Number.isNaN(Date.parse(calls[0].values[1])), 'window start should be an ISO timestamp');
});

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary() {
  console.log(`\n${B('─'.repeat(40))}`);
  console.log(
    `${G(`${passed} passed`)}  ` +
    `${failed ? R(`${failed} failed`) : D('0 failed')}`
  );
  if (failures.length) {
    console.log(R('\nFailed:'));
    failures.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.error}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

runAsyncTests()
  .then(printSummary)
  .catch(e => {
    recordFailure('async test runner', e);
    printSummary();
  });
