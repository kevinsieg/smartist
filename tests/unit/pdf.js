const path = require('path');
const { setlistTitle } =
  require(path.join(__dirname, '../../api/_pdf'));

function run(r) {
  const { test, assertEq, B } = r;

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
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
