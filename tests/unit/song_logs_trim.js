const path = require('path');

// api/_db.js trimSongLogs: a song keeps its newest SONG_LOG_KEEP history
// entries. The statement itself is checked on a real database by hand; here:
// who it touches, how often it runs, and that a failure never fails a request.
const { trimSongLogs, SONG_LOG_KEEP } = require(path.join(__dirname, '../../api/_db'));

function fakeSql(fail = false) {
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('?'), values });
    return fail ? Promise.reject(new Error('db down')) : Promise.resolve([]);
  };
  return { sql, calls };
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nsong history trim'));

  await testAsync('keeps the newest 20 per song, scoped to the band, orphans untouched', async () => {
    const { sql, calls } = fakeSql();
    await trimSongLogs(sql, 7, { always: true });
    assertEq(calls.length, 1);
    assertEq(SONG_LOG_KEEP, 20);
    assertEq(calls[0].values, [7, 20]);
    assert(/PARTITION BY song_id ORDER BY changed_at DESC, id DESC/.test(calls[0].text), 'newest first');
    assert(/song_id IS NOT NULL/.test(calls[0].text), 'entries of songs that no longer exist stay');
  });

  await testAsync('runs on about one write in ten', async () => {
    const { sql, calls } = fakeSql();
    const random = Math.random;
    try {
      Math.random = () => 0.5;
      await trimSongLogs(sql, 7);
      assertEq(calls.length, 0);
      Math.random = () => 0.05;
      await trimSongLogs(sql, 7);
      assertEq(calls.length, 1);
    } finally {
      Math.random = random;
    }
  });

  await testAsync('a failed trim never fails the request', async () => {
    const { sql } = fakeSql(true);
    const error = console.error;
    console.error = () => {};
    try {
      await trimSongLogs(sql, 7, { always: true });
    } finally {
      console.error = error;
    }
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
