const path = require('path');
const i18n = require(path.join(__dirname, '../../app/js/i18n'));
const en = require(path.join(__dirname, '../../app/i18n/en.json'));
const fr = require(path.join(__dirname, '../../app/i18n/fr.json'));
const de = require(path.join(__dirname, '../../app/i18n/de.json'));

function run(r) {
  const { test, assert, assertEq, B } = r;
  const { resolveLocale, translate, readCachedDict, SUPPORTED_LOCALES, DEFAULT_LOCALE, I18N_VERSION } = i18n;

  console.log(B('\nresolveLocale'));
  test('stored supported locale wins', () =>
    assertEq(resolveLocale('de', ['en-US']), 'de'));
  test('stored unsupported is ignored, falls to browser', () =>
    assertEq(resolveLocale('es', ['fr-FR', 'en']), 'fr'));
  test('browser primary subtag matched (fr-CA → fr)', () =>
    assertEq(resolveLocale(null, ['fr-CA']), 'fr'));
  test('first supported browser lang wins', () =>
    assertEq(resolveLocale(null, ['es', 'de-AT', 'fr']), 'de'));
  test('no match → default en', () =>
    assertEq(resolveLocale(null, ['es', 'it']), 'en'));
  test('empty inputs → default en', () =>
    assertEq(resolveLocale(null, []), 'en'));
  test('null stored, null-ish navLangs → default', () =>
    assertEq(resolveLocale(null, undefined || []), 'en'));

  console.log(B('\ntranslate'));
  const dict = { 'a.b': 'Hello', 'greet': 'Hi {name}!' };
  test('returns translated string', () => assertEq(translate(dict, 'a.b'), 'Hello'));
  test('interpolates {var}', () => assertEq(translate(dict, 'greet', { name: 'Sam' }), 'Hi Sam!'));
  test('missing var left as-is', () => assertEq(translate(dict, 'greet', {}), 'Hi {name}!'));
  test('missing key falls back to key', () => assertEq(translate(dict, 'no.such'), 'no.such'));
  test('empty dict falls back to key', () => assertEq(translate({}, 'x'), 'x'));

  console.log(B('\nreadCachedDict'));
  test('version match returns dict', () =>
    assertEq(readCachedDict(JSON.stringify({ v: 1, dict: { x: 'y' } }), 1), { x: 'y' }));
  test('version mismatch returns null', () =>
    assertEq(readCachedDict(JSON.stringify({ v: 1, dict: { x: 'y' } }), 2), null));
  test('malformed JSON returns null', () =>
    assertEq(readCachedDict('{not json', 1), null));
  test('null raw returns null', () =>
    assertEq(readCachedDict(null, 1), null));

  console.log(B('\nconstants'));
  test('supported locales', () => assertEq(SUPPORTED_LOCALES, ['en', 'fr', 'de']));
  test('default locale en', () => assertEq(DEFAULT_LOCALE, 'en'));
  test('version is a number', () => assert(typeof I18N_VERSION === 'number'));

  console.log(B('\nlocale key parity'));
  const enKeys = Object.keys(en).sort();
  test('fr has identical key set to en', () => assertEq(Object.keys(fr).sort(), enKeys));
  test('de has identical key set to en', () => assertEq(Object.keys(de).sort(), enKeys));
  test('no empty values in en', () =>
    assert(enKeys.every(k => typeof en[k] === 'string' && en[k].length > 0)));
}

module.exports = run;

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}
