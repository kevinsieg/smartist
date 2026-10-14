// Which voice's melody does the stage view show? Pure, no DOM, no t(): loaded
// by stage.html (core.js only) and by the unit tests.

var MELODY_VOICE_KEY = 'stage_melody_voice';

// The saved voice against this song's melodies and the band's instruments.
// A saved voice the band no longer has is dropped (known: false).
function melodyChoose(melodies, instruments, savedKey) {
  if (!savedKey) return { key: null, melody: null, known: true };
  var list = Array.isArray(instruments) ? instruments : [];
  var known = list.some(function(i) { return i && i.key === savedKey; });
  if (!known) return { key: null, melody: null, known: false };
  var melody = (Array.isArray(melodies) ? melodies : []).find(function(m) { return m.instrument === savedKey; }) || null;
  return { key: savedKey, melody: melody, known: true };
}

var MELODY_AUDIO_RE = /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i;

// The recordings the stage view's one player can play: Listen and Playback
// when they are audio files (a link is shown as a link instead), and the chosen
// voice's own recording. Each carries its stored waveform, or null.
function melodySources(extra, melody) {
  var e = extra || {};
  var out = [];
  if (typeof e.listenUrl === 'string' && MELODY_AUDIO_RE.test(e.listenUrl))
    out.push({ id: 'listen', url: e.listenUrl, waveform: typeof e.waveform === 'string' ? e.waveform : null });
  if (typeof e.playbackUrl === 'string' && MELODY_AUDIO_RE.test(e.playbackUrl))
    out.push({ id: 'playback', url: e.playbackUrl, waveform: typeof e.playbackWaveform === 'string' ? e.playbackWaveform : null });
  if (melody && melody.audio_url)
    out.push({ id: 'own', url: melody.audio_url, waveform: typeof melody.waveform === 'string' ? melody.waveform : null });
  return out;
}

// What plays first: the voice's own recording, else Listen, else Playback.
function melodyDefaultSource(sources) {
  var ids = (sources || []).map(function(s) { return s.id; });
  return ['own', 'listen', 'playback'].find(function(id) { return ids.indexOf(id) >= 0; }) || null;
}

// The voices to offer on this song: configured instruments (in settings order)
// whose melody holds an image or a recording.
function melodyVoices(melodies, instruments) {
  var have = {};
  (Array.isArray(melodies) ? melodies : []).forEach(function(m) {
    if ((m.sheet_urls && m.sheet_urls.length) || m.audio_url) have[m.instrument] = true;
  });
  return (Array.isArray(instruments) ? instruments : []).filter(function(i) { return i && have[i.key]; });
}

// The voices that have something on this song, with what each has: the songs
// page lists them in the song's overview.
function melodySummary(melodies, instruments) {
  var list = Array.isArray(melodies) ? melodies : [];
  return melodyVoices(list, instruments).map(function(i) {
    var m = list.find(function(x) { return x.instrument === i.key; });
    return { key: i.key, label: i.label || i.key, images: (m.sheet_urls || []).length, audio: !!m.audio_url };
  });
}

// The sheet images of the song itself (the whole-song row), not of a voice.
var MELODY_SONG_KEY = '_song';
function melodySongImages(melodies) {
  var m = (Array.isArray(melodies) ? melodies : []).find(function(x) { return x.instrument === MELODY_SONG_KEY; });
  return (m && m.sheet_urls) || [];
}

// What the stage view shows. view is the user's last choice of track (listen,
// playback or voice, or 'none' once deselected) or null: it opens on Listen, else
// Playback, else the voice.
// The voice's recording belongs to the voice view. The sheet is chosen apart
// from the track: sheetPref is the key of the user's last pick (a voice, or
// '_song' for the whole song, or 'none' once deselected) or null, which follows the track (the voice's
// sheets with the voice, the song's with Listen and Playback) and falls back to
// what exists. sheets lists what can be picked. The saved voice stays chosen
// while another view is open. note says why no sheet is shown: choose (no voice
// picked), gone (the saved one is not set up any more). A voice with no sheet, or a
// sheet deselected, shows no message: only what exists is offered.
function melodyStage(extra, melodies, instruments, savedKey, view, sheetPref) {
  var list = Array.isArray(melodies) ? melodies : [];
  var sources = melodySources(extra, null);
  var voices = melodyVoices(list, instruments);
  var pick = melodyChoose(list, instruments, savedKey);
  var views = [];
  if (sources.some(function(s) { return s.id === 'listen'; })) views.push('listen');
  if (sources.some(function(s) { return s.id === 'playback'; })) views.push('playback');
  if (voices.length) views.push('voice');
  var shown = views.indexOf(view) >= 0 || view === 'none' ? view : (views[0] || null);
  var current = (Array.isArray(instruments) ? instruments : []).find(function(i) { return i && i.key === pick.key; });
  var offered = voices.slice();
  if (current && !offered.some(function(v) { return v.key === current.key; })) offered.push(current);

  var source = null;
  if (shown === 'listen' || shown === 'playback') source = sources.find(function(s) { return s.id === shown; }) || null;
  else if (shown === 'voice') source = melodySources({}, pick.melody)[0] || null;

  var sheets = [];
  if (melodySongImages(list).length) sheets.push({ key: MELODY_SONG_KEY, label: 'Whole song' });
  voices.forEach(function(v) {
    var m = list.find(function(x) { return x.instrument === v.key; });
    if (m && m.sheet_urls && m.sheet_urls.length) sheets.push({ key: v.key, label: v.label || v.key });
  });
  var has = function(key) { return sheets.some(function(x) { return x.key === key; }); };
  var order = shown === 'none' ? [] : (shown === 'voice' ? [pick.key, MELODY_SONG_KEY] : [MELODY_SONG_KEY, pick.key]);
  var sheet = sheetPref === 'none' ? null : [sheetPref].concat(order).find(function(k) { return k && has(k); }) || null;
  var images = sheet === MELODY_SONG_KEY ? melodySongImages(list)
    : sheet ? ((list.find(function(x) { return x.instrument === sheet; }) || {}).sheet_urls || []) : [];
  var note = '';
  if (shown === 'voice' && !pick.key) note = pick.known ? 'choose' : 'gone';
  return {
    views: views, view: shown, source: source, images: images, sheets: sheets, sheet: sheet, note: note, voices: offered,
    voice: { key: pick.key, label: current ? (current.label || current.key) : '', known: pick.known },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { melodyChoose: melodyChoose, melodySources: melodySources, melodyDefaultSource: melodyDefaultSource, melodySummary: melodySummary, melodyVoices: melodyVoices, melodyStage: melodyStage, melodySongImages: melodySongImages, MELODY_VOICE_KEY: MELODY_VOICE_KEY };
}
