// Chords inside lyrics, stored as ChordPro ("[Am]Hello"). People edit them as a
// chord line above a lyric line; these helpers convert both ways, transpose and
// render. Shared by the song pages and stage.html: pure, no DOM, no t().
// H is the German name for B; both mean B natural here.
var _CH_CHORD = /^([A-H][#b]?)((?:maj|min|dim|aug|sus|add|m|M|[0-9]|#|b|\+|-|°|ø)*)(?:\/([A-H][#b]?))?$/;
var _CH_MARK  = /^(?:x[0-9]+|[0-9]+x|n\.?c\.?|%|-|\.)$/i;
// A section name leading a chord line ("Intro: G D Em C"); it stays text.
var _CH_LEAD  = /^(?:verse|chorus|refrain|ref\.?|bridge|intro|outro|interlude|solo|pre-?chorus|instrumental|coda|strophe|couplet|pont|vers|zwischenspiel)[0-9]*:?$/i;
var _CH_LABEL = /^\s*\[?\s*(?:verse|chorus|refrain|ref\.?|bridge|intro|outro|interlude|solo|pre-?chorus|instrumental|coda|strophe|couplet|pont|vers|zwischenspiel)\b[^\]\n]{0,20}\]?:?\s*$/i;
var _CH_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
var _CH_FLAT  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
var _CH_PC    = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11, 'B#': 0, H: 11 };

// "||Em", "(Dm)", "Am||" -> the chord inside, "" for a pure bar mark.
function _chCore(tok) { return tok.replace(/^[|:(]+/, '').replace(/[|:)]+$/, ''); }
// "Em(Am)": the capo shape, then the chord that sounds -> { shape, sound }.
function _chPair(tok) {
  var m = /^([^(]+)\(([^)]+)\)$/.exec(tok);
  return m && _CH_CHORD.test(_chCore(m[1])) && _CH_CHORD.test(m[2]) ? { shape: m[1], sound: m[2] } : null;
}
// The sounding chord keeps the shape's bar marks: "||Em" + "Dm" -> "||Dm".
function _chSounding(shape, sound) { return /^[|:]*/.exec(shape)[0] + sound; }
function _chIsChord(tok) { var p = _chPair(tok); return _CH_CHORD.test(_chCore(p ? p.shape : tok)); }
function _chIsToken(tok) { var p = _chPair(tok), c = _chCore(p ? p.shape : tok); return c === '' || _CH_MARK.test(c) || _CH_CHORD.test(c); }

function _chNorm1(l) {
  l = l.replace(/\r$/, '');
  var out = '';
  for (var i = 0; i < l.length; i++) out += l[i] === '\t' ? ' '.repeat(8 - (out.length % 8)) : l[i];
  return out;
}

// Length of a leading section label on a chord line ("Intro: "), else 0.
function _chLeadLen(line) {
  var m = /^\s*(\S+)\s+\S/.exec(line);
  return m && _CH_LEAD.test(m[1]) ? m[0].length - 1 : 0;
}

function chordsIsLine(line) {
  line = String(line);
  var toks = line.slice(_chLeadLen(line)).trim().split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every(_chIsToken) && toks.some(_chIsChord);
}

function _chIsLyric(line) {
  return line !== undefined && line.trim() !== '' && !chordsIsLine(line) && !_CH_LABEL.test(line);
}

// Insert [chord] at each chord's column of the lyric, right to left so the
// columns stay valid; a chord past the end pads the lyric with spaces.
function _chMerge(chordLine, lyric) {
  var found = [], m, re = /\S+/g;
  while ((m = re.exec(chordLine))) {
    var pair = _chPair(m[0]);
    found.push({ at: m.index, end: m.index + m[0].length, tok: pair ? _chSounding(pair.shape, pair.sound) : m[0] });
  }
  // "Em (Am)": a bracketed chord one space after a chord is that chord's sound.
  for (var k = found.length - 2; k >= 0; k--) {
    var alt = /^\(([^()]+)\)$/.exec(found[k + 1].tok);
    if (alt && found[k + 1].at === found[k].end + 1 && _CH_CHORD.test(alt[1]) && _chIsChord(found[k].tok) && found[k].tok.indexOf('(') === -1) {
      found[k].tok = _chSounding(found[k].tok, alt[1]);
      found.splice(k + 1, 1);
    }
  }
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
    if (/^\s*[A-H]\s*$/.test(line) && !lyricNext) { out.push(raw[i]); continue; }
    var lead = _chLeadLen(line);
    if (lead) { out.push(_chMerge(' '.repeat(lead) + line.slice(lead), line.slice(0, lead).replace(/\s+$/, ''))); continue; }
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
    var chords = '', lyric = '', overlay = '';
    segs.forEach(function (s) {
      if (s.chord) {
        var at = Math.max(lyric.length, chords.length ? chords.length + 1 : 0);
        chords += ' '.repeat(at - chords.length) + s.chord;
        var o = Math.max(lyric.length, overlay.length ? overlay.length + 1 : 0);
        overlay += ' '.repeat(o - overlay.length) + s.chord;
      } else overlay = s.text.replace(/\s+$/, '');
      lyric += s.text;
    });
    // "Intro: [G] [D]" goes back to one line: the label with its chords after it.
    var above = _CH_LEAD.test(lyric.trim()) ? overlay
      : lyric.trim() ? chords + '\n' + lyric.replace(/\s+$/, '') : chords;
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
  var show = !opts || opts.chords !== false;
  // With a capo the player sees shapes: the sounding chord minus the capo.
  var steps = ((opts && opts.steps) || 0) - ((opts && Math.round(Number(opts.capo))) || 0);
  var labels = chordsHas(text);
  var lines = String(text).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // a trailing line break is no row
  return lines.map(function (line) {
    var segs = _chSegments(line);
    if (segs.length === 1) {
      return labels && _CH_LABEL.test(line)
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

// Text the user did not change is saved as stored: chord-looking plain lines must not be rewritten.
function chordsForSave(edited, original) {
  return edited === chordsToAbove(original || '') ? (original || '') : chordsToPro(edited);
}

// ── Parts: blocks between blank lines, lettered by chord sequence ─────────────
var _CH_DEG = ['1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7'];

function _chKind(label) {
  var w = label.replace(/^\s*\[?\s*/, '').toLowerCase();
  if (/^pre-?chorus/.test(w)) return 'pre';
  if (/^(chorus|refrain|ref\b)/.test(w)) return 'chorus';
  if (/^(verse|strophe|couplet|vers)/.test(w)) return 'verse';
  if (/^(bridge|pont)/.test(w)) return 'bridge';
  return 'other';
}

function _chLines(text) {
  var lines = String(text).split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function chordsParts(text) {
  var lines = _chLines(text), raw = [], cur = null;
  lines.forEach(function (line, i) {
    if (!line.trim()) { cur = null; return; }
    if (!cur) { cur = { start: i, end: i, lines: [] }; raw.push(cur); }
    cur.end = i; cur.lines.push(line);
  });
  var blocks = raw.map(function (b) {
    var label = '', kind = '', chords = [], words = [];
    b.lines.forEach(function (line, j) {
      var segs = _chSegments(line), lineChords = [];
      segs.forEach(function (s) { if (s.chord) lineChords.push(s.chord); });
      var plain = segs.map(function (s) { return s.text; }).join('');
      var lead = /^\s*\[?\s*(\S+)/.exec(plain);
      if (j === 0 && !label && (lineChords.length ? lead && _CH_LEAD.test(lead[1].replace(/[[\]]/g, '')) : _CH_LABEL.test(line))) {
        label = (lineChords.length ? lead[1] : line.trim()).replace(/^\[|\]$/g, '').replace(/:$/, '').trim();
        kind = _chKind(label);
        if (!lineChords.length) return;
        plain = plain.slice(plain.indexOf(lead[1]) + lead[1].length);
      }
      if (lineChords.some(function (c) { return _chIsChord(c); }) || lineChords.length) chords.push(lineChords);
      if (plain.trim()) words.push(plain.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' '));
    });
    return { start: b.start, end: b.end, label: label, kind: kind, chords: chords, lyrics: words.join(' ') };
  });

  var parts = [], letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function newPart(b) {
    var p = { letter: letters[parts.length] || '?', kind: b.kind, label: b.label, chords: b.chords, key: JSON.stringify(b.chords) };
    parts.push(p);
    return p;
  }
  function lyricParts() {
    var seen = [];
    blocks.forEach(function (b) { if (b.letter && b.lyrics && seen.indexOf(b.letter) === -1) seen.push(b.letter); });
    return seen;
  }
  blocks.forEach(function (b, i) {
    var part = null;
    if (b.chords.length) {
      var key = JSON.stringify(b.chords);
      part = parts.filter(function (p) { return p.key === key; })[0] || newPart(b);
    } else if (b.kind) {
      for (var k = i - 1; k >= 0 && !part; k--) if (blocks[k].kind === b.kind) part = parts.filter(function (p) { return p.letter === blocks[k].letter; })[0];
      if (!part && b.kind === 'chorus') {
        var lp = lyricParts();
        if (lp.length > 1) part = parts.filter(function (p) { return p.letter === lp[1]; })[0];
      }
      if (!part) part = newPart(b);
    } else {
      var first = lyricParts()[0];
      part = first ? parts.filter(function (p) { return p.letter === first; })[0] : newPart(b);
    }
    if (b.kind && !part.kind) { part.kind = b.kind; part.label = b.label; }
    b.letter = part.letter;
  });

  var chorus = null;
  blocks.forEach(function (b) { if (b.kind === 'chorus' && !chorus) chorus = b.letter; });
  if (!chorus) {
    var count = {};
    blocks.forEach(function (b) { if (b.lyrics) count[b.lyrics] = (count[b.lyrics] || 0) + 1; });
    var best = 0, tie = false, bestText = '';
    Object.keys(count).forEach(function (t) {
      if (count[t] > best) { best = count[t]; bestText = t; tie = false; } else if (count[t] === best) tie = true;
    });
    if (best >= 2 && !tie) blocks.forEach(function (b) { if (b.lyrics === bestText) chorus = b.letter; });
  }

  return {
    blocks: blocks.map(function (b) { return { letter: b.letter, kind: b.kind, label: b.label, start: b.start, end: b.end }; }),
    parts: parts.map(function (p) { return { letter: p.letter, kind: p.kind, label: p.label, chords: p.chords }; }),
    chorus: chorus,
  };
}

// ── Key and Nashville numbers ────────────────────────────────────────────────
function _chParseKey(key) {
  var m = /^\s*([A-H][#b]?)\s*(m(?!aj)|min|minor|moll|-)?/i.exec(String(key || ''));
  if (!m) return null;
  var root = m[1][0].toUpperCase() + m[1].slice(1);
  return _CH_PC[root] === undefined ? null : { pc: _CH_PC[root], minor: !!m[2] };
}

function chordsGuessKey(text) {
  var all = [];
  _chLines(text).forEach(function (line) {
    _chSegments(line).forEach(function (s) {
      var m = s.chord && _CH_CHORD.exec(_chCore(s.chord));
      if (m) all.push({ root: m[1], minor: /^(m(?!aj)|min)/.test(m[2]) });
    });
  });
  if (!all.length) return '';
  var freq = {}, top = all[0];
  all.forEach(function (c) { freq[c.root] = (freq[c.root] || 0) + 1; if (freq[c.root] > freq[top.root]) top = c; });
  var last = all[all.length - 1], pick = last.root === all[0].root || last.root === top.root ? last : top;
  return pick.root + (pick.minor ? 'm' : '');
}

function chordsNashville(tok, key) {
  var k = _chParseKey(key);
  if (!k) return tok;
  var core = _chCore(tok), m = _CH_CHORD.exec(core);
  if (!m) return tok;
  var deg = function (root) { return _CH_DEG[(_CH_PC[root] - k.pc + 12) % 12]; };
  var q = m[2];
  var qual = /^(m(?!aj)|min)/.test(q) ? '-' + q.replace(/^(min|m)/, '') : /^dim/.test(q) ? '°' + q.slice(3) : q;
  var num = deg(m[1]) + qual + (m[3] ? '/' + deg(m[3]) : '');
  var at = tok.indexOf(core);
  return tok.slice(0, at) + num + tok.slice(at + core.length);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { chordsIsLine: chordsIsLine, chordsToPro: chordsToPro, chordsToAbove: chordsToAbove, chordsForSave: chordsForSave, chordsTranspose: chordsTranspose, chordsRender: chordsRender, chordsHas: chordsHas, chordsParts: chordsParts, chordsGuessKey: chordsGuessKey, chordsNashville: chordsNashville };
}
