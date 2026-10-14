// A recording's loudness profile: ~100 peak values, kept on the song as a
// 200-character hex string (songs.extra.waveform) and drawn on a canvas.
// Pure helpers, also loaded by scripts/waveforms.js.

var WAVEFORM_BARS = 100;

// samples: Float32Array of mono PCM. Loudest absolute sample per slice, scaled
// so the loudest slice is 1.
function waveformPeaks(samples, bars) {
  bars = bars || WAVEFORM_BARS;
  var peaks = [];
  var max = 0;
  for (var b = 0; b < bars; b++) {
    var from = Math.floor(b * samples.length / bars);
    var to = Math.max(from + 1, Math.floor((b + 1) * samples.length / bars));
    var p = 0;
    for (var i = from; i < to && i < samples.length; i++) {
      var v = Math.abs(samples[i]);
      if (v > p) p = v;
    }
    peaks.push(p);
    if (p > max) max = p;
  }
  return peaks.map(function(p) { return max > 0 ? p / max : 0; });
}

function waveformEncode(peaks) {
  return peaks.map(function(p) {
    var n = Math.round(Math.min(1, Math.max(0, p)) * 255);
    return (n < 16 ? '0' : '') + n.toString(16);
  }).join('');
}

function waveformValid(s) {
  return typeof s === 'string' && /^[0-9a-f]{200}$/.test(s);
}

function waveformDecode(s) {
  if (!waveformValid(s)) return null;
  var peaks = [];
  for (var i = 0; i < s.length; i += 2) peaks.push(parseInt(s.slice(i, i + 2), 16) / 255);
  return peaks;
}

// progress 0..1: bars before it are drawn in colors.played.
function waveformDraw(canvas, peaks, progress, colors) {
  var ctx = canvas.getContext('2d');
  var w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  var slot = w / peaks.length;
  var barW = Math.max(1, slot * 0.7);
  for (var i = 0; i < peaks.length; i++) {
    var bh = Math.max(2, Math.sqrt(peaks[i]) * h);
    ctx.fillStyle = i / peaks.length < progress ? colors.played : colors.rest;
    ctx.fillRect(i * slot + (slot - barW) / 2, (h - bh) / 2, barW, bh);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WAVEFORM_BARS: WAVEFORM_BARS, waveformPeaks: waveformPeaks, waveformEncode: waveformEncode, waveformValid: waveformValid, waveformDecode: waveformDecode, waveformDraw: waveformDraw };
}
