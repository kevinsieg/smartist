const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

const gemaImport =
  require(path.join(__dirname, '../../api/[band]/gema/import'))._test;

function run(r) {
  const { test, assert, assertEq, B } = r;

  console.log(B('\nGEMA import helpers'));

  test('parseCsvLine keeps quoted commas inside a field', () => {
    assertEq(
      gemaImport.parseCsvLine('15299392-001,"Song, With Comma",DEUTSCH'),
      ['15299392-001', 'Song, With Comma', 'DEUTSCH']
    );
  });
  test('parseCsv skips preamble and ignores rows without Werknummer', () => {
    const csv = [
      'Downloaded from GEMA',
      'Werknummer,Titel,Sprache,Dauer,Erstmals geladen',
      '15299392-001,Über den Wolken,DEUTSCH,03:42,05.11.2026',
      ',Missing Work Number,DEUTSCH,01:00,05.11.2026',
    ].join('\n');
    assertEq(gemaImport.parseCsv(csv), [{
      Werknummer: '15299392-001',
      Titel: 'Über den Wolken',
      Sprache: 'DEUTSCH',
      Dauer: '03:42',
      'Erstmals geladen': '05.11.2026',
    }]);
  });
  test('parseCsv rejects files without a Werknummer header', () => {
    let error = null;
    try {
      gemaImport.parseCsv('Titel,Sprache\nSong,DEUTSCH');
    } catch (e) {
      error = e;
    }
    assert(error, 'expected parseCsv to throw');
    assert(error.message.includes('Werknummer'), `unexpected error: ${error.message}`);
  });
  test('parseBeteiligte maps duplicate-index columns and normalises shares/roles', () => {
    const row = [
      '15299392-001', '', 'Jane Writer', 'IP-123', 'KOMPONIST/-IN', '1', '',
      '"12,5"', '-', '25', '"50,25"', 'GEMA', 'ASCAP', '', '', 'Rep Publisher',
      'IP-999', 'TEXTDICHTER/-IN',
    ].join(',');
    assertEq(gemaImport.parseBeteiligte(`Preamble\nWerknummer,unused\n${row}`), [{
      gema_work_number: '15299392-001',
      name: 'Jane Writer',
      ip_name_number: 'IP-123',
      role: 'composer',
      role_order: '1',
      publisher_relation: null,
      ar_share: 12.5,
      vr_share: null,
      ar_share_cumulated: 25,
      vr_share_cumulated: 50.25,
      society_ar: 'GEMA',
      society_vr: 'ASCAP',
      represents_name: 'Rep Publisher',
      represents_ip: 'IP-999',
      represents_role: 'lyricist',
    }]);
  });
  test('normalizeTitle folds German characters and punctuation for matching', () => {
    assertEq(gemaImport.normalizeTitle('Spaß! Öl über Bühne'), 'SPASS OEL UEBER BUEHNE');
  });
  test('GEMA value normalisers preserve unknown language and parse known values', () => {
    assertEq(gemaImport.normLanguage('franzoesisch'), 'FR');
    assertEq(gemaImport.normLanguage('Spanisch'), 'Spanisch');
    assertEq(gemaImport.normRole('SUB-VERLEGER'), 'sub-publisher');
    assertEq(gemaImport.normRole('Producer'), 'Producer');
  });
  test('GEMA scalar parsers handle German numbers, durations, and dates', () => {
    assertEq(gemaImport.parseShare('12,5'), 12.5);
    assertEq(gemaImport.parseShare('-'), null);
    assertEq(gemaImport.parseDuration('01:02:03'), 3723);
    assertEq(gemaImport.parseDuration('03:04'), 184);
    assertEq(gemaImport.parseDuration('-'), null);
    assertEq(gemaImport.parseGermanDate('05.11.2026'), '2026-11-05');
    assertEq(gemaImport.parseGermanDate('2026-11-05'), null);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
