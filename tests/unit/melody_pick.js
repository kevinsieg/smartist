'use strict';

const path = require('path');
const { melodyChoose, melodySources, melodyDefaultSource, melodySummary, melodyVoices, melodyStage, melodySongImages } = require(path.join(__dirname, '../../app/js/melody-pick'));

function run(r) {
  const { test, assertEq, B } = r;
  console.log(B('\nmelody pick'));
  const inst = [{ key: 'TEN', label: 'Tenor' }, { key: 'BAR2', label: 'Bariton 2' }, { key: 'BAS', label: 'Bass' }];
  const mel  = [{ instrument: 'TEN', sheet_urls: ['a.jpg'], audio_url: 'ten.mp3' }, { instrument: 'BAS', sheet_urls: [], audio_url: null }];

  test('saved voice with a melody', () => {
    assertEq(melodyChoose(mel, inst, 'TEN'), { key: 'TEN', melody: mel[0], known: true });
  });
  test('saved voice without a melody on this song', () => {
    assertEq(melodyChoose(mel, inst, 'BAR2'), { key: 'BAR2', melody: null, known: true });
  });
  test('saved voice no longer configured', () => {
    assertEq(melodyChoose(mel, inst, 'GONE'), { key: null, melody: null, known: false });
  });
  test('nothing saved', () => {
    assertEq(melodyChoose(mel, inst, null), { key: null, melody: null, known: true });
  });
  test('missing lists do not throw', () => {
    assertEq(melodyChoose(undefined, undefined, 'TEN'), { key: null, melody: null, known: false });
  });
  const extra = { listenUrl: 'https://x.test/a/l.mp3', waveform: 'aa', playbackUrl: 'https://x.test/p/b.wav?v=1', playbackWaveform: 'bb' };
  test('sources: listen, playback and the voice\'s own recording, each with its waveform', () => {
    assertEq(melodySources(extra, { audio_url: 'ten.mp3', waveform: 'cc' }), [
      { id: 'listen', url: 'https://x.test/a/l.mp3', waveform: 'aa' },
      { id: 'playback', url: 'https://x.test/p/b.wav?v=1', waveform: 'bb' },
      { id: 'own', url: 'ten.mp3', waveform: 'cc' },
    ]);
  });
  test('sources: a link that is not an audio file is no source, a missing waveform is null', () => {
    assertEq(melodySources({ listenUrl: 'https://youtu.be/x', playbackUrl: 'https://x.test/b.mp3' }, null),
      [{ id: 'playback', url: 'https://x.test/b.mp3', waveform: null }]);
  });
  test('sources: nothing given gives none', () => {
    assertEq(melodySources(undefined, undefined), []);
    assertEq(melodySources({}, { audio_url: null }), []);
  });
  test('default source: own recording, then listen, then playback', () => {
    const all = melodySources(extra, { audio_url: 'ten.mp3' });
    assertEq(melodyDefaultSource(all), 'own');
    assertEq(melodyDefaultSource(all.filter(x => x.id !== 'own')), 'listen');
    assertEq(melodyDefaultSource(all.filter(x => x.id === 'playback')), 'playback');
    assertEq(melodyDefaultSource([]), null);
  });
  const ex = { listenUrl: 'https://x.test/l.mp3', waveform: 'aa', playbackUrl: 'https://x.test/p.mp3' };
  const mels = [{ instrument: 'TEN', sheet_urls: ['t1.jpg', 't2.jpg'], audio_url: 'ten.mp3', waveform: 'cc' }, { instrument: 'BAS', sheet_urls: ['b1.jpg'], audio_url: null }];
  test('stage: opens on Listen with the three buttons, and the chosen voice\'s sheets while there is no song sheet', () => {
    const st = melodyStage(ex, mels, inst, 'TEN', null);
    assertEq(st.views, ['listen', 'playback', 'voice']);
    assertEq(st.view, 'listen');
    assertEq(st.source, { id: 'listen', url: 'https://x.test/l.mp3', waveform: 'aa' });
    assertEq(st.images, ['t1.jpg', 't2.jpg']);
    assertEq(st.voice.label, 'Tenor');
  });
  test('stage: the voice view plays the voice\'s recording and shows its sheets', () => {
    const st = melodyStage(ex, mels, inst, 'TEN', 'voice');
    assertEq(st.view, 'voice');
    assertEq(st.source, { id: 'own', url: 'ten.mp3', waveform: 'cc' });
    assertEq(st.images, ['t1.jpg', 't2.jpg']);
  });
  test('stage: a voice without a recording shows its sheets and plays nothing', () => {
    const st = melodyStage(ex, mels, inst, 'BAS', 'voice');
    assertEq(st.source, null);
    assertEq(st.images, ['b1.jpg']);
  });
  test('stage: the voice view without a chosen voice asks for one', () => {
    const st = melodyStage(ex, mels, inst, null, 'voice');
    assertEq([st.source, st.images, st.voice.key], [null, [], null]);
    assertEq(st.note, 'choose');
  });
  test('stage: a saved voice the band no longer has is dropped and says so', () => {
    assertEq(melodyStage(ex, mels, inst, 'GONE', 'voice').note, 'gone');
  });
  test('stage: a voice without a sheet shows no message, and neither does a deselected sheet', () => {
    assertEq(melodyStage(ex, mels, inst, 'BAR2', 'voice').note, '');
    assertEq(melodyStage(ex, mels, inst, 'TEN', 'voice', 'none').note, '');
  });
  test('stage: a view the song cannot show falls back to the first one it can', () => {
    assertEq(melodyStage({ playbackUrl: 'https://x.test/p.mp3' }, [], inst, null, 'voice').view, 'playback');
    assertEq(melodyStage({}, mels, inst, null, 'listen').view, 'voice');
    assertEq(melodyStage({}, [], inst, null, null).views, []);
  });
  test('stage: voices offered are those with content, plus the chosen one', () => {
    assertEq(melodyStage(ex, mels, inst, 'BAR2', 'voice').voices.map(v => v.key), ['TEN', 'BAS', 'BAR2']);
  });
  const withSong = mels.concat([{ instrument: '_song', sheet_urls: ['s1.jpg'], audio_url: null }]);
  test('song sheet: the images of the whole-song row, never a voice', () => {
    assertEq(melodySongImages(withSong), ['s1.jpg']);
    assertEq(melodySongImages(mels), []);
    assertEq(melodySongImages(undefined), []);
    assertEq(melodyVoices(withSong, inst).map(v => v.key), ['TEN', 'BAS']);
  });
  const song = { key: '_song', label: 'Whole song' };
  test('sheets: Listen and Playback open on the song sheet, the voice view on the voice\'s', () => {
    const l = melodyStage(ex, withSong, inst, 'TEN', null);
    assertEq([l.sheet, l.images], ['_song', ['s1.jpg']]);
    const v = melodyStage(ex, withSong, inst, 'TEN', 'voice');
    assertEq([v.sheet, v.images], ['TEN', ['t1.jpg', 't2.jpg']]);
  });
  test('sheets: any voice with images or the whole song can be picked, in a list that names them', () => {
    const st = melodyStage(ex, withSong, inst, 'TEN', 'listen');
    assertEq(st.sheets, [song, { key: 'TEN', label: 'Tenor' }, { key: 'BAS', label: 'Bass' }]);
  });
  test('sheets: with no song sheet, Listen shows the chosen voice\'s sheets', () => {
    const st = melodyStage(ex, mels, inst, 'TEN', 'listen');
    assertEq([st.sheet, st.images], ['TEN', ['t1.jpg', 't2.jpg']]);
    assertEq(st.sheets.map(x => x.key), ['TEN', 'BAS']);
  });
  test('sheets: a sheet picked apart from the track, even another voice\'s', () => {
    const st = melodyStage(ex, withSong, inst, 'TEN', 'listen', 'BAS');
    assertEq([st.sheet, st.images, st.source.id], ['BAS', ['b1.jpg'], 'listen']);
    const own = melodyStage(ex, withSong, inst, 'TEN', 'voice', '_song');
    assertEq([own.sheet, own.images, own.source.id], ['_song', ['s1.jpg'], 'own']);
  });
  test('sheets: a choice that does not exist falls back', () => {
    assertEq(melodyStage(ex, mels, inst, 'TEN', 'listen', '_song').sheet, 'TEN');
    assertEq(melodyStage(ex, withSong, inst, null, 'listen', 'GONE').sheet, '_song');
    assertEq(melodyStage(ex, withSong, inst, 'BAR2', 'voice').sheet, '_song');
  });
  test('sheets: a song with only a song sheet still opens', () => {
    const st = melodyStage({}, [{ instrument: '_song', sheet_urls: ['s1.jpg'], audio_url: null }], inst, null, null);
    assertEq([st.views, st.view, st.images, st.sheet], [[], null, ['s1.jpg'], '_song']);
  });
  test('deselected: no track and no sheet, until a sheet is picked on purpose', () => {
    const st = melodyStage(ex, withSong, inst, 'TEN', 'none');
    assertEq([st.view, st.source, st.images, st.sheet, st.note], ['none', null, [], null, '']);
    assertEq(st.views, ['listen', 'playback', 'voice']);
    const picked = melodyStage(ex, withSong, inst, 'TEN', 'none', 'BAS');
    assertEq([picked.source, picked.images], [null, ['b1.jpg']]);
  });
  test('deselected sheet: the track plays, no sheet shows', () => {
    const st = melodyStage(ex, withSong, inst, 'TEN', 'listen', 'none');
    assertEq([st.source.id, st.images, st.sheet], ['listen', [], null]);
    assertEq(st.sheets.length, 3);
  });
  test('summary: voices with content in settings order, with image count and recording', () => {
    const m = [{ instrument: 'BAS', sheet_urls: ['a', 'b'], audio_url: null }, { instrument: 'TEN', sheet_urls: [], audio_url: 'ten.mp3' }, { instrument: 'BAR2', sheet_urls: [], audio_url: null }];
    assertEq(melodySummary(m, inst), [
      { key: 'TEN', label: 'Tenor', images: 0, audio: true },
      { key: 'BAS', label: 'Bass', images: 2, audio: false },
    ]);
    assertEq(melodySummary(undefined, undefined), []);
  });
  test('voices offered: configured instruments in settings order, only those with content on this song', () => {
    assertEq(melodyVoices(mel, inst).map(v => v.key), ['TEN']);
  });
  test('a melody of a removed instrument is not offered', () => {
    assertEq(melodyVoices([{ instrument: 'GONE', sheet_urls: ['x'], audio_url: null }], inst), []);
  });
  test('missing lists give no voices', () => assertEq(melodyVoices(undefined, undefined), []));
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
