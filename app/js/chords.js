// Chords inside lyrics, stored as ChordPro ("[Am]Hello"). People edit them as a
// chord line above a lyric line; these helpers convert both ways, transpose and
// render. Shared by the song pages and stage.html: pure, no DOM, no t().
var _CH_CHORD = /^([A-G][#b]?)((?:maj|min|dim|aug|sus|add|m|M|[0-9]|#|b|\+|-|°|ø)*)(?:\/([A-G][#b]?))?$/;
var _CH_MARK  = /^(?:x[0-9]+|n\.?c\.?|%|-)$/i;
var _CH_LABEL = /^\s*\[?\s*(?:verse|chorus|refrain|ref\.?|bridge|intro|outro|interlude|solo|pre-?chorus|instrumental|coda|strophe|couplet|pont|vers|zwischenspiel)\b[^\]\n]{0,20}\]?:?\s*$/i;
var _CH_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
var _CH_FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
var _CH_PC    = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11, 'B#': 0 };

// "||Em", "(Dm)", "Am||" -> the chord inside, "" for a pure bar mark.
function _chCore(tok) { return tok.replace(/^[|:(]+/, '').replace(/[|:)]+$/, ''); }
function _chIsChord(tok) { return _CH_CHORD.test(_chCore(tok)); }
function _chIsToken(tok) { var c = _chCore(tok); return c === '' || _CH_MARK.test(c) || _CH_CHORD.test(c); }

function _chNorm1(l) {
  l = l.replace(/\r$/, '');
  var out = '';
  for (var i = 0; i < l.length; i++) out += l[i] === '\t' ? ' '.repeat(8 - (out.length % 8)) : l[i];
  return out;
}

function chordsIsLine(line) {
  var toks = String(line).trim().split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every(_chIsToken) && toks.some(_chIsChord);
}

function _chIsLyric(line) {
  return line !== undefined && line.trim() !== '' && !chordsIsLine(line) && !_CH_LABEL.test(line);
}

// Insert [chord] at each chord's column of the lyric, right to left so the
// columns stay valid; a chord past the end pads the lyric with spaces.
function _chMerge(chordLine, lyric) {
  var found = [], m, re = /\S+/g;
  while ((m = re.exec(chordLine))) found.push({ at: m.index, tok: m[0] });
  var out = lyric;
  for (var i = found.length - 1; i >= 0; i--) {
    var at = found[i].at;
    if (out.length < at) out += ' '.repeat(at - out.length);
    out = out.slice(0, at) + '[' + found[i].tok + ']' + out.slice(at);
  }
  return out;
}

function chordsToPro(text) {
  var raw = String(text).split('\n'), out = [];
  for (var i = 0; i < raw.length; i++) {
    var line = _chNorm1(raw[i]);
    if (!chordsIsLine(line)) { out.push(raw[i]); continue; }
    var next = i + 1 < raw.length ? _chNorm1(raw[i + 1]) : undefined;
    var lyricNext = _chIsLyric(next);
    if (/^\s*[A-G]\s*$/.test(line) && !lyricNext) { out.push(raw[i]); continue; }
    if (lyricNext) { out.push(_chMerge(line, next)); i++; }
    else out.push(_chMerge(line, ''));
  }
  return out.join('\n');
}

// One ChordPro line -> segments [{ chord, text }]; non-chord brackets stay text.
function _chSegments(line) {
  var segs = [{ chord: '', text: '' }], m, re = /\[([^\]\n]*)\]/g, last = 0;
  while ((m = re.exec(line))) {
    if (!_chIsToken(m[1]) || !m[1]) continue;
    segs[segs.length - 1].text += line.slice(last, m.index);
    segs.push({ chord: m[1], text: '' });
    last = m.index + m[0].length;
  }
  segs[segs.length - 1].text += line.slice(last);
  return segs;
}

function chordsHas(text) {
  return String(text).split('\n').some(function (l) { return _chSegments(l).length > 1; });
}

function chordsToAbove(text) {
  return String(text).split('\n').map(function (line) {
    var segs = _chSegments(line);
    if (segs.length === 1) return line;
    var chords = '', lyric = '';
    segs.forEach(function (s) {
      if (s.chord) {
        var at = Math.max(lyric.length, chords.length ? chords.length + 1 : 0);
        chords += ' '.repeat(at - chords.length) + s.chord;
      }
      lyric += s.text;
    });
    var above = lyric.trim() ? chords + '\n' + lyric.replace(/\s+$/, '') : chords;
    return chordsToPro(above).trimEnd() === line.trimEnd() ? above : line;
  }).join('\n');
}

function chordsTranspose(tok, steps) {
  var n = ((steps % 12) + 12) % 12;
  if (!n) return tok;
  var core = _chCore(tok), m = _CH_CHORD.exec(core);
  if (!m) return tok;
  var shift = function (root) {
    var pc = (_CH_PC[root] + n) % 12;
    var flat = root[1] === 'b' || (root[1] !== '#' && [1, 3, 8, 10].indexOf(pc) !== -1);
    return flat ? _CH_FLAT[pc] : _CH_SHARP[pc];
  };
  var moved = shift(m[1]) + m[2] + (m[3] ? '/' + shift(m[3]) : '');
  var at = tok.indexOf(core);
  return tok.slice(0, at) + moved + tok.slice(at + core.length);
}

function _chEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function chordsRender(text, opts) {
  var show = !opts || opts.chords !== false, steps = (opts && opts.steps) || 0;
  return String(text).split('\n').map(function (line) {
    var segs = _chSegments(line);
    if (segs.length === 1) {
      return _CH_LABEL.test(line)
        ? '<div class="chord-label">' + _chEsc(line.trim()) + '</div>'
        : '<div class="chord-row">' + (_chEsc(line) || '&nbsp;') + '</div>';
    }
    var words = segs.map(function (s) { return s.text; }).join('');
    if (!show) return words.trim() ? '<div class="chord-row">' + _chEsc(words) + '</div>' : '';
    return '<div class="chord-row chord-row--chords">' + segs.filter(function (s) { return s.chord || s.text; }).map(function (s) {
      return '<span class="ch-seg"><span class="ch">' + _chEsc(s.chord ? chordsTranspose(s.chord, steps) : '') +
        '</span><span class="ch-tx">' + (_chEsc(s.text) || '&nbsp;') + '</span></span>';
    }).join('') + '</div>';
  }).join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { chordsIsLine: chordsIsLine, chordsToPro: chordsToPro, chordsToAbove: chordsToAbove, chordsTranspose: chordsTranspose, chordsRender: chordsRender, chordsHas: chordsHas };
}
