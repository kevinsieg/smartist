'use strict';

// song_media helpers: the rows folded back into the shapes the client reads,
// and the statements that save a song's links.

const path = require('path');
const { melodiesFromMedia, songLinks, setSongLinks, withMedia, splitLinks, LINK_KINDS } =
  require(path.join(__dirname, '../../api/_domain/media'));

const row = (id, kind, instrument, url, extra = {}) => ({ id, kind, instrument, url, waveform: null, position: 0, updated_at: '2026-10-14T10:00:00Z', ...extra });

async function run(r) {
  const { test, testAsync, assert, assertEq, B } = r;
  console.log(B('\nsong media'));

  const rows = [
    row(1, 'listen', null, 'https://x.test/l.mp3', { waveform: 'aa'.repeat(100) }),
    row(2, 'pdf', null, 'https://x.test/s.pdf'),
    row(3, 'instrument', 'TEN', 'https://x.test/ten.mp3', { waveform: 'bb'.repeat(100) }),
    row(4, 'sheet', 'TEN', 'https://x.test/ten2.jpg', { position: 1 }),
    row(5, 'sheet', 'TEN', 'https://x.test/ten1.jpg', { position: 0 }),
    row(6, 'sheet', 'BAR', 'https://x.test/bar.jpg'),
    row(7, 'sheet', null, 'https://x.test/song.jpg'),
    row(8, 'playback', null, 'https://x.test/p.mp3', { waveform: 'cc'.repeat(100) }),
  ];

  test('melodiesFromMedia: a voice with a recording and sheet pages in order', () => {
    const ten = melodiesFromMedia(rows).find(m => m.instrument === 'TEN');
    assertEq(ten.sheet_urls, ['https://x.test/ten1.jpg', 'https://x.test/ten2.jpg']);
    assertEq(ten.audio_url, 'https://x.test/ten.mp3');
    assertEq(ten.waveform, 'bb'.repeat(100));
  });
  test('melodiesFromMedia: a voice with sheets only has no recording', () => {
    const bar = melodiesFromMedia(rows).find(m => m.instrument === 'BAR');
    assertEq(bar.sheet_urls, ['https://x.test/bar.jpg']);
    assertEq(bar.audio_url, null);
    assertEq(bar.waveform, null);
  });
  test('melodiesFromMedia: the whole song is the _song entry, images only', () => {
    const song = melodiesFromMedia(rows).find(m => m.instrument === '_song');
    assertEq(song.sheet_urls, ['https://x.test/song.jpg']);
  });
  test('melodiesFromMedia: listen, playback and the PDF are not melodies', () => {
    assertEq(melodiesFromMedia(rows).map(m => m.instrument).sort(), ['BAR', 'TEN', '_song']);
    assertEq(melodiesFromMedia([row(1, 'listen', null, 'u'), row(2, 'pdf', null, 'p')]), []);
  });
  test('songLinks: the keys the song form and the clients read', () => {
    assertEq(Object.entries(songLinks(rows)).sort(), Object.entries({
      listenUrl: 'https://x.test/l.mp3', waveform: 'aa'.repeat(100),
      playbackUrl: 'https://x.test/p.mp3', playbackWaveform: 'cc'.repeat(100),
      sheetUrl: 'https://x.test/s.pdf',
    }).sort());
  });
  test('songLinks: nothing stored, nothing returned', () => assertEq(songLinks([]), {}));

  function stub() {
    const calls = [];
    // Only statements on song_media count; a fragment (`WHERE kind = …`) is not one.
    const sql = (strings, ...values) => {
      const text = strings.join(' ').replace(/\s+/g, ' ');
      if (text.includes('song_media')) calls.push({ text, values });
      return Promise.resolve([]);
    };
    return { sql, calls };
  }

  await testAsync('setSongLinks: a link is saved by an upsert that keeps the waveform of an unchanged one', async () => {
    const { sql, calls } = stub();
    await setSongLinks(sql, 1, 5, { listenUrl: 'https://x.test/l.mp3' });
    assertEq(calls.length, 1);
    assert(calls[0].text.includes('INSERT INTO song_media'), calls[0].text);
    assert(calls[0].text.includes('ON CONFLICT'), calls[0].text);
    assert(calls[0].text.includes('song_media.url <> EXCLUDED.url'), 'unchanged url must not clear the waveform');
    assert(calls[0].values.includes('https://x.test/l.mp3'));
  });
  await testAsync('setSongLinks: an empty value or null removes the row', async () => {
    const { sql, calls } = stub();
    await setSongLinks(sql, 1, 5, { playbackUrl: '', sheetUrl: null });
    assertEq(calls.length, 2);
    assert(calls.every(c => c.text.startsWith(' DELETE FROM song_media') || c.text.startsWith('DELETE FROM song_media')), JSON.stringify(calls.map(c => c.text)));
    assert(calls[0].values.includes('playback') && calls[1].values.includes('pdf'));
  });
  await testAsync('setSongLinks: keys that are absent are left alone', async () => {
    const { sql, calls } = stub();
    await setSongLinks(sql, 1, 5, { capo: 2 });
    assertEq(calls.length, 0);
  });
  await testAsync('withMedia: songs written by a request answer with their media keys, one query for all', async () => {
    const queries = [];
    const sql = (strings, ...values) => { queries.push({ text: strings.join(' '), values }); return Promise.resolve(rows.map(x => ({ ...x, song_id: 5 }))); };
    const out = await withMedia(sql, [{ id: 5, title: 'A', extra: { capo: 2, listenUrl: 'stale' } }, { id: 6, title: 'B', extra: { waveform: 'stale' } }]);
    assertEq(queries.length, 1);
    assertEq(out[0].extra.listenUrl, 'https://x.test/l.mp3');
    assertEq(out[0].extra.capo, 2);
    assertEq(out[1].extra, {});
  });
  await testAsync('withMedia: no rows, no query', async () => {
    const sql = () => { throw new Error('queried'); };
    assertEq(await withMedia(sql, []), []);
  });
  test('splitLinks: the link keys leave the extra that is stored on the song', () => {
    assertEq(splitLinks({ capo: 2, listenUrl: 'a', sheetUrl: '' }), { rest: { capo: 2 }, links: { listenUrl: 'a', sheetUrl: '' } });
    assertEq(splitLinks(undefined), { rest: undefined, links: {} });
  });
  test('setSongLinks: the three link keys map to their kinds', () => {
    assertEq(LINK_KINDS, { listenUrl: 'listen', playbackUrl: 'playback', sheetUrl: 'pdf' });
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
