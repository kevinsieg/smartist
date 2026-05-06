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
const { suggestLyricsWithAI } =
  require(path.join(__dirname, '../api/_ai'));

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
const asyncTests = [];

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

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

async function runAsyncTests() {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  ${G('✓')} ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ${R('✗')} ${name}`);
      console.log(`      ${R(e.message)}`);
      failures.push({ name, error: e.message });
      failed++;
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

// ── suggestLyricsWithAI ───────────────────────────────────────────────────────

console.log(B('\nsuggestLyricsWithAI'));

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

testAsync('no API key → skipped without network call', async () => {
  let called = false;
  await withAiEnv(undefined, async () => { called = true; }, async () => {
    const result = await suggestLyricsWithAI('Song', 'Artist');
    assertEq(result, { lyrics: null, skipped: true });
    assertEq(called, false, 'fetch should not be called without an API key');
  });
});

testAsync('Gemini response → strips markdown, citations, and URL-only links', async () => {
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

testAsync('provider quota response → null lyrics with skipped flag', async () => {
  await withAiEnv('test-key', async () => ({
    ok: false,
    status: 429,
    text: async () => 'quota exceeded',
  }), async () => {
    assertEq(await suggestLyricsWithAI('Song', 'Artist'), { lyrics: null, skipped: true });
  });
});

testAsync('network failure → null lyrics without skipped flag', async () => {
  await withAiEnv('test-key', async () => {
    throw new Error('socket closed');
  }, async () => {
    assertEq(await suggestLyricsWithAI('Song', 'Artist'), { lyrics: null });
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────

runAsyncTests().then(() => {
  const total = passed + failed;
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
});
