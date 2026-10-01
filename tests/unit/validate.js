const path = require('path');
const { validateSongIds, validateStr, validateNum, validateEmail, F, parseFields } =
  require(path.join(__dirname, '../../api/_validate'));

function run(r) {
  const { test, assert, assertEq, B } = r;

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

  console.log(B('\nF.object maxBytes'));
  const SPEC = { links: F.object({ maxBytes: 100 }) };
  test('an object under the cap passes', () => {
    assertEq(parseFields({ links: { a: 'x' } }, SPEC).value, { links: { a: 'x' } });
  });
  test('an object over the cap is refused', () => {
    assertEq(parseFields({ links: { a: 'x'.repeat(200) } }, SPEC).error, 'links is too large');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
