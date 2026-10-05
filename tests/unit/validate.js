const path = require('path');
const { validateSongIds, positiveId, validateOptions, deleteMode, likePattern, validateStr, validateNum, validateEmail, F, parseFields, unsafeKey } =
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
  test('null → false', () => {
    assertEq(validateSongIds(null), false);
  });
  test('string → false', () => {
    assertEq(validateSongIds('1,2,3'), false);
  });
  test('number → false', () => {
    assertEq(validateSongIds(5), false);
  });
  test('contains zero → false', () => {
    assertEq(validateSongIds([1, 0, 3]), false);
  });
  test('contains negative → false', () => {
    assertEq(validateSongIds([1, -2, 3]), false);
  });
  test('contains float → false', () => {
    assertEq(validateSongIds([1, 1.5, 3]), false);
  });
  test('contains non-number string → false', () => {
    assertEq(validateSongIds([1, 'abc', 3]), false);
  });
  test('contains NaN (as string "NaN") → false', () => {
    assertEq(validateSongIds([1, NaN, 3]), false);
  });
  test('duplicates → false', () => {
    assertEq(validateSongIds([1, 2, 2, 3]), false);
  });
  test('201 items → false', () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    assertEq(validateSongIds(ids), false);
  });
  test('200 items → array of 200', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const result = validateSongIds(ids);
    assert(Array.isArray(result), 'expected array');
    assertEq(result.length, 200);
    assertEq(result[0], 1);
    assertEq(result[199], 200);
  });

  test('numeric strings and the largest integer id pass', () => {
    assertEq(validateSongIds(['3', 2147483647]), [3, 2147483647]);
  });
  test('booleans and ids past the integer column → false', () => {
    assertEq(validateSongIds([true]), false);
    assertEq(validateSongIds([2147483648]), false);
  });

  console.log(B('\npositiveId'));

  test('missing → null, a positive integer (or its digits) → the number', () => {
    assertEq(positiveId(undefined), null);
    assertEq(positiveId(null), null);
    assertEq(positiveId(''), null);
    assertEq(positiveId(7), 7);
    assertEq(positiveId('42'), 42);
  });
  test('anything else → false, never a value the database rejects', () => {
    for (const v of ['abc', '1.5', 1.5, 0, -3, '0x10', '1e3', true, {}, [], 2147483648, '99999999999'])
      assertEq(positiveId(v), false, `${JSON.stringify(v)} passed`);
  });

  console.log(B('\ndeleteMode'));
  test('the URL decides: ?hard=1&cascade=gigs,setlists', () => {
    assertEq(deleteMode({ hard: '1', cascade: 'gigs,setlists' }, { hard: false }, ['gigs', 'setlists']),
      { hard: true, cascade: ['gigs', 'setlists'] });
  });
  test('no query, no body → a soft delete', () => {
    assertEq(deleteMode({}, undefined, ['gigs']), { hard: false, cascade: [] });
  });
  test('an unknown cascade in the URL → false', () => {
    assertEq(deleteMode({ hard: '1', cascade: 'gigs,users' }, null, ['gigs']), false);
  });
  test('the old body form still works', () => {
    assertEq(deleteMode({}, { hard: true, cascade: ['gigs'] }, ['gigs']), { hard: true, cascade: ['gigs'] });
  });
  test('a body hard that is not true is a soft delete', () => {
    assertEq(deleteMode({}, { hard: 'yes' }, ['gigs']).hard, false);
  });

  console.log(B('\nvalidateOptions'));

  test('missing → [], a list of known values → the list', () => {
    assertEq(validateOptions(undefined, ['gigs']), []);
    assertEq(validateOptions(null, ['gigs']), []);
    assertEq(validateOptions(['gigs', 'setlists'], ['gigs', 'setlists']), ['gigs', 'setlists']);
  });
  test('a string, a number or an unknown value → false', () => {
    assertEq(validateOptions('gigs,setlists', ['gigs', 'setlists']), false);
    assertEq(validateOptions(5, ['gigs']), false);
    assertEq(validateOptions(['gig'], ['gigs']), false);
  });

  console.log(B('\nlikePattern'));

  test('an empty query → null; a term → %term% with % and _ escaped', () => {
    assertEq(likePattern(''), null);
    assertEq(likePattern('  '), null);
    assertEq(likePattern(undefined), null);
    assertEq(likePattern(' Club '), '%Club%');
    assertEq(likePattern('100%_\\'), '%100\\%\\_\\\\%');
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

  console.log(B('\nobjects where text is expected'));
  test('validateStr refuses an object instead of storing "[object Object]"', () => {
    assertEq(validateStr({ a: 1 }, 100), false);
    assertEq(validateStr(['a'], 100), false);
  });
  test('a text field given an object is a 400, not a stored string', () => {
    assert(/single value/.test(parseFields({ t: { a: 1 } }, { t: F.text(100) }).error));
  });

  console.log(B('\nF.object maxBytes'));
  const SPEC = { links: F.object({ maxBytes: 100 }) };
  test('an object under the cap passes', () => {
    assertEq(parseFields({ links: { a: 'x' } }, SPEC).value, { links: { a: 'x' } });
  });
  test('an object over the cap is refused', () => {
    assertEq(parseFields({ links: { a: 'x'.repeat(200) } }, SPEC).error, 'links is too large');
  });

  console.log(B('\nunsafeKey'));
  for (const k of ['audio/12/uuid-take.mp3', 'bands/my-band/photo', 'bands/my-band/photo?v=123', 'gigs/my-band/4-uuid-poster.jpg'])
    test(`a plain key passes: ${k}`, () => assertEq(unsafeKey(k), false));
  for (const k of ['bands/mine/../other/photo', 'audio/12/../99/x.mp3', 'audio/..', './audio/1/x', 'audio//1/x',
                   'bands/mine/%2e%2e/other/photo', 'bands/mine%2fother/photo', 'bands\\mine/x', '', null])
    test(`a key a storage layer could read differently is refused: ${k}`, () => assertEq(unsafeKey(k), true));
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
