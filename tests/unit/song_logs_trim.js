const path = require('path');

// api/_db.js trimSongLogs: a song keeps its newest SONG_LOG_KEEP history
// entries, and purgeDeletedSongs. The statements are checked on a real database
// by hand; here: who they touch, how often they run, and that a failure never
// fails a request.
require('./_runner').stubLogger();
const { trimSongLogs, purgeDeletedSongs, PURGE_AFTER_DAYS } = require(path.join(__dirname, '../../api/_db'));
const { SONG_LOG_KEEP } = require(path.join(__dirname, '../../api/_constants'));

// Like postgres.js, a query runs when awaited; one nested in another is part
// of that one's text and values.
function fakeSql(fail = false) {
  const calls = [];
  const sql = (strings, ...values) => {
    let text = strings[0];
    const flat = [];
    values.forEach((v, i) => {
      if (v && v.isQuery) { text += v.text; flat.push(...v.values); } else { text += '?'; flat.push(v); }
      text += strings[i + 1];
    });
    return {
      isQuery: true, text, values: flat,
      then(ok, ko) {
        calls.push({ text, values: flat });
        return (fail ? Promise.reject(new Error('db down')) : Promise.resolve([])).then(ok, ko);
      },
    };
  };
  return { sql, calls };
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nsong history trim'));

  await testAsync('keeps the newest 20 per song, only for the songs written', async () => {
    const { sql, calls } = fakeSql();
    await trimSongLogs(sql, 7, [3, 4]);
    assertEq(calls.length, 1);
    assertEq(SONG_LOG_KEEP, 20);
    assertEq(calls[0].values, [7, [3, 4], 20]);
    assert(/PARTITION BY song_id ORDER BY changed_at DESC, id DESC/.test(calls[0].text), 'newest first');
    assert(/song_id IN \(SELECT unnest\(\?::int\[\]\)\)/.test(calls[0].text), 'scoped to the songs written');
  });

  await testAsync('runs on every write, and not without a song', async () => {
    const { sql, calls } = fakeSql();
    await trimSongLogs(sql, 7, 3);
    assertEq(calls.length, 1);
    assertEq(calls[0].values[1], [3]);
    await trimSongLogs(sql, 7, []);
    await trimSongLogs(sql, 7, null);
    assertEq(calls.length, 1);
  });

  await testAsync('purge of deleted songs: old, unlisted, without files; one delete in ten', async () => {
    const { sql, calls } = fakeSql();
    const random = Math.random;
    try {
      Math.random = () => 0.5;
      await purgeDeletedSongs(sql, 7);
      assertEq(calls.length, 0);
      Math.random = () => 0.05;
      await purgeDeletedSongs(sql, 7);
      assertEq(calls.length, 1);
    } finally {
      Math.random = random;
    }
    assertEq(PURGE_AFTER_DAYS, 90);
    assert(/s\.deleted/.test(calls[0].text), 'deleted songs only');
    assert(/WHERE NOT listed/.test(calls[0].text), 'setlists keep their songs');
    assert(/DELETE FROM song_lyrics WHERE song_id IN \(SELECT id FROM old WHERE listed\)/.test(calls[0].text)
      && /DELETE FROM song_arrangements WHERE song_id IN \(SELECT id FROM old WHERE listed\)/.test(calls[0].text),
      'a song kept by a setlist loses its lyrics and arrangements');
    assert(/listenUrl/.test(calls[0].text), 'songs with files stay');
    assert(/DELETE FROM song_logs/.test(calls[0].text), 'their history goes too');
  });

  await testAsync('a failed trim never fails the request', async () => {
    const { sql } = fakeSql(true);
    const error = console.error;
    console.error = () => {};
    try {
      await trimSongLogs(sql, 7, 3);
      await purgeDeletedSongs(sql, 7, { always: true });
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
