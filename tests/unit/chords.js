'use strict';
// Chords inside lyrics: chord lines above lyric lines <-> ChordPro.
const path = require('path');
const C = require(path.join(__dirname, '../../app/js/chords.js'));

function run(r) {
  const { test, assertEq } = r;
  console.log('\nchords');

  test('chord lines: every token a chord or mark, at least one chord', () => {
    for (const l of ['Dm7   Gm7  Fmaj7', '  G  D/F#  Em', '||Em (Dm)   || x3   F   G', 'D   A7   D   n.C.', 'Bbmaj7 C#m7b5 Esus4 Aadd9'])
      assertEq(C.chordsIsLine(l), true, l);
    for (const l of ['', '   ', 'A day in May', 'Am Abend', '|| x3', 'Hello [Am] there', 'Ein Lied'])
      assertEq(C.chordsIsLine(l), false, l);
  });

  test('chord line above a lyric line becomes inline ChordPro at the same columns', () => {
    assertEq(C.chordsToPro('Dm7         Gm7\nIn the house by the road'), '[Dm7]In the house[Gm7] by the road');
  });

  test('chords past the end of the lyric are padded and appended', () => {
    assertEq(C.chordsToPro('G          E   E7\nShort line'), '[G]Short line [E]    [E7]');
  });

  test('chord line without a lyric below stays a chord-only line', () => {
    assertEq(C.chordsToPro('Dm7   Dm7   Gm7\n\nWords'), '[Dm7]      [Dm7]      [Gm7]\n\nWords');
  });

  test('a lone letter is a chord only above a lyric line', () => {
    assertEq(C.chordsToPro('A\n\nB'), 'A\n\nB');
    assertEq(C.chordsToPro('A\nlong road'), '[A]long road');
  });

  test('section labels and non-chord brackets stay text', () => {
    const t = 'Refrain\n[Verse 2]\nWe sing [laughs] along';
    assertEq(C.chordsToPro(t), t);
    assertEq(C.chordsToAbove(t), t);
  });

  test('tabs and CRLF are normalised before matching columns', () => {
    assertEq(C.chordsToPro('G\tC\r\nOne two three four five six'), '[G]One two [C]three four five six');
  });

  test('round trip: above -> ChordPro -> above is unchanged except trailing spaces', () => {
    const sheet = [
      'Dm7          Dm7      Gm7      Fmaj7',
      '',
      'Dm7          Dm7      Gm7      Fmaj7',
      'In my little house    I am never alone',
      'Plain verse line without chords',
      '',
      'Refrain',
      'G            Am',
      'Life in the suburbs   is fine',
      '||Em (Dm)    || x3     F     G     E   E7',
      'D       A7      D      n.C.',
      'All comes to a good   end',
    ].join('\n');
    const back = C.chordsToAbove(C.chordsToPro(sheet));
    assertEq(back.split('\n').map(l => l.trimEnd()).join('\n'), sheet);
  });

  test('plain lyrics pass through both ways untouched', () => {
    const t = 'Line one\n\n  indented line\nLast';
    assertEq(C.chordsToPro(t), t);
    assertEq(C.chordsToAbove(t), t);
    assertEq(C.chordsHas(t), false);
    assertEq(C.chordsHas('[Am]x'), true);
  });

  test('transpose: sharps, conventional flats, slash bass, marks unchanged', () => {
    assertEq(C.chordsTranspose('G', 2), 'A');
    assertEq(C.chordsTranspose('E', 2), 'F#');
    assertEq(C.chordsTranspose('C', 3), 'Eb');
    assertEq(C.chordsTranspose('A', 1), 'Bb');
    assertEq(C.chordsTranspose('Bb', 2), 'C');
    assertEq(C.chordsTranspose('Dm7', -2), 'Cm7');
    assertEq(C.chordsTranspose('D/F#', 2), 'E/G#');
    assertEq(C.chordsTranspose('(Dm)', 5), '(Gm)');
    assertEq(C.chordsTranspose('||Em', 2), '||F#m');
    assertEq(C.chordsTranspose('n.C.', 3), 'n.C.');
    assertEq(C.chordsTranspose('x3', 3), 'x3');
    assertEq(C.chordsTranspose('Am', 0), 'Am');
    assertEq(C.chordsTranspose('Am', 12), 'Am');
  });

  test('render: chords above words, escaped, toggle and transpose', () => {
    const html = C.chordsRender('[Am]Hi <b>[G]there', {});
    assertEq(html.includes('<b>'), false);
    assertEq(html.includes('&lt;b&gt;'), true);
    assertEq((html.match(/class="ch"/g) || []).length, 2);
    const off = C.chordsRender('[Am]Hi there\n[G]   [C]\nNext', { chords: false });
    assertEq(off.includes('class="ch"'), false);
    assertEq(off.includes('Hi there'), true);
    assertEq(off.includes('[G]'), false);
    assertEq(C.chordsRender('[Am]x', { steps: 2 }).includes('>Bm<'), true);
  });

  test('render: section labels get their own class, plain lines stay plain', () => {
    const html = C.chordsRender('Refrain\n[G]Plain line', {});
    assertEq(html.includes('class="chord-label"'), true);
    assertEq(html.includes('Plain line'), true);
  });

  test('render: label-like lines stay plain rows in songs without chords', () => {
    const plain = C.chordsRender('Chorus\nla', {});
    assertEq(plain.includes('chord-label'), false);
    assertEq(plain.includes('Chorus'), true);
    assertEq(C.chordsRender('Chorus\n[G]la', {}).includes('chord-label'), true);
  });

  test('plain lines come out byte-for-byte; only merged lines are normalised', () => {
    assertEq(C.chordsToPro('x\ty\r\nz'), 'x\ty\r\nz');
    assertEq(C.chordsToPro('line\twith tab'), 'line\twith tab');
    assertEq(C.chordsToPro('a\r\nb'), 'a\r\nb');
    assertEq(C.chordsToPro('a\tb\nG\r\nOne two\tx'), 'a\tb\n[G]One two x');
  });

  test('chordsToAbove keeps lines inline when the expanded form would not round-trip', () => {
    for (const l of ['[x3]la', '[G]A', '[G]Am']) {
      assertEq(C.chordsToAbove(l), l, l);
      assertEq(C.chordsToPro(C.chordsToAbove(l)), l, l);
    }
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
