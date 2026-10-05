const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

// Parsers shared by the pro-import route and scripts/import_gema.js.
const gemaImport = require(path.join(__dirname, '../../api/_domain/gema'));

function run(r) {
  const { test, assert, assertEq, B } = r;

  console.log(B('\nGEMA import helpers'));

  test('parseCsvLine keeps quoted commas inside a field', () => {
    assertEq(
      gemaImport.parseCsvLine('12345678-001,"Song, With Comma",DEUTSCH'),
      ['12345678-001', 'Song, With Comma', 'DEUTSCH']
    );
  });
  test('parseCsv skips preamble and ignores rows without Werknummer', () => {
    const csv = [
      'Downloaded from GEMA',
      'Werknummer,Titel,Sprache,Dauer,Erstmals geladen',
      '12345678-001,Über den Wolken,DEUTSCH,03:42,05.11.2026',
      ',Missing Work Number,DEUTSCH,01:00,05.11.2026',
    ].join('\n');
    assertEq(gemaImport.parseCsv(csv), [{
      Werknummer: '12345678-001',
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
      '12345678-001', '', 'Jane Writer', 'IP-123', 'KOMPONIST/-IN', '1', '',
      '"12,5"', '-', '25', '"50,25"', 'GEMA', 'ASCAP', '', '', 'Rep Publisher',
      'IP-999', 'TEXTDICHTER/-IN',
    ].join(',');
    assertEq(gemaImport.parseBeteiligte(`Preamble\nWerknummer,unused\n${row}`), [{
      gema_work_number: '12345678-001',
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
  return runSaveErrors(r);
}

// A row the database refuses says so in the preview without the database's
// own message: that names constraints, columns and values.
async function runSaveErrors(r) {
  const { testAsync, assert, assertEq } = r;
  await testAsync('a row that fails to save gets a generic error, not the database message', async () => {
    const dbMessage = 'duplicate key value violates unique constraint "gema_works_artist_id_gema_work_number_key"';
    const sql = (strings) => {
      const text = strings.join('?');
      if (/INSERT INTO gema_works/.test(text)) return Promise.reject(new Error(dbMessage));
      return Promise.resolve([]);
    };
    sql.json = v => v;
    const csv = 'Werknummer,Titel,Sprache,Dauer,Erstmals geladen\n12345678-001,Song,DEUTSCH,03:42,05.11.2026';
    const res = await gemaImport.importWorks(sql, { id: 1, config: {} }, 'own', csv, { dryRun: false });
    assertEq(res.status, 200);
    const failed = res.body.rows.filter(x => x.error);
    assert(failed.length === 1, `rows with an error: ${failed.length}`);
    assert(!failed[0].error.includes('constraint'), `leaked: ${failed[0].error}`);
    assertEq(res.body.summary.errors, 1);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
