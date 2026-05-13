#!/usr/bin/env node
// Unit tests for pure modules — no external dependencies, no network, no DB.
//
// Usage:
//   node tests/unit.js
//   cd tests && node unit.js

const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { validateSongIds, validateStr, validateNum, validateEmail } =
  require(path.join(__dirname, '../api/_validate'));
const { checkCredentials } =
  require(path.join(__dirname, '../api/_auth'));
const { generateMagicToken, verifyMagicToken } =
  require(path.join(__dirname, '../api/_token'));
const { setlistTitle } =
  require(path.join(__dirname, '../api/_pdf'));
const { keyFromUrl, filenameFromUrl } =
  require(path.join(__dirname, '../api/_r2'));
const { LYRICS_SOURCES, plainFromSynced } =
  require(path.join(__dirname, '../api/_lyrics'));
const { clientIp, isMissingRateLimitTable } =
  require(path.join(__dirname, '../api/_ratelimit'));

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
const pending = [];

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

function asyncTest(name, fn) {
  pending.push((async () => {
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
  })());
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

// ── lyrics helpers ───────────────────────────────────────────────────────────

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

// ── rate-limit helpers ───────────────────────────────────────────────────────

console.log(B('\nrate-limit helpers'));

test('clientIp uses first forwarded IP before proxies', () => {
  assertEq(
    clientIp({ headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' } }),
    '203.0.113.10'
  );
});

test('clientIp trims forwarded IP whitespace', () => {
  assertEq(clientIp({ headers: { 'x-forwarded-for': ' 2001:db8::1 ' } }), '2001:db8::1');
});

test('clientIp missing forwarded header → unknown', () => {
  assertEq(clientIp({ headers: {} }), 'unknown');
});

test('isMissingRateLimitTable detects PostgreSQL undefined_table errors', () => {
  assertEq(isMissingRateLimitTable({ code: '42P01', message: 'relation "rate_limits" does not exist' }), true);
});

test('isMissingRateLimitTable detects Neon missing relation messages', () => {
  assertEq(isMissingRateLimitTable({ message: 'relation "rate_limits" does not exist' }), true);
});

test('isMissingRateLimitTable ignores unrelated database errors', () => {
  assertEq(isMissingRateLimitTable({ code: '08006', message: 'connection failure' }), false);
});

// ── Summary ───────────────────────────────────────────────────────────────────

(async () => {
  await Promise.all(pending);
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
})();
