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

  test('German songbooks: H chords, 2x repeats and beat dots', () => {
    for (const l of ['G   H7   Em', 'H   Hm7   E', 'Am   .   .   G', 'Am  F  C  G  2x'])
      assertEq(C.chordsIsLine(l), true, l);
    assertEq(C.chordsToPro('H7     Em\nOne more line'), '[H7]One mor[Em]e line');
  });

  // "Em(Am)" / "Em (Am)": a capo shape, then the chord that sounds. The sounding
  // chord is stored; the shape comes back from the song's capo.
  test('a shape with its sounding chord in brackets stores the sounding chord', () => {
    assertEq(C.chordsIsLine('Em(Am)   C   G'), true);
    assertEq(C.chordsIsLine('Am(Em)'), true);
    assertEq(C.chordsToPro('Em(Am)   G\nla la la la la'), '[Am]la la la [G]la la');
    assertEq(C.chordsToPro('Em (Am)  G\nla la la la la'), '[Am]la la la [G]la la');
    assertEq(C.chordsToPro('||Em (Dm)   F\n\nx'), '[||Dm]            [F]\n\nx');
    assertEq(C.chordsToPro('(Dm)   F\n\nx'), '[(Dm)]       [F]\n\nx');
    assertEq(C.chordsIsLine('Hello(World) G'), false);
  });

  test('a bracketed chord pairs only with the chord one space before it', () => {
    assertEq(C.chordsToPro('Am        (G)\nsome words here and more'), '[Am]some words[(G)] here and more');
    assertEq(C.chordsToPro('C (G) F\n\nx'), '[G]      [F]\n\nx');
  });

  test('a fractional capo is rounded', () => {
    assertEq(C.chordsRender('[Am]la', { capo: 2.4 }).includes('>Gm<'), true);
    assertEq(C.chordsRender('[Am]la', { capo: '5' }).includes('>Em<'), true);
  });

  test('capo shows the shapes: sounding chord minus the capo, plus transpose', () => {
    const pro = '[Am]la [Dm]le';
    const shapes = C.chordsRender(pro, { capo: 5 });
    assertEq(shapes.includes('>Em<'), true, shapes);
    assertEq(shapes.includes('>Am<'), true, shapes);
    assertEq(C.chordsRender(pro, { capo: 5, steps: 2 }).includes('>F#m<'), true);
    assertEq(C.chordsRender(pro, {}).includes('>Am<'), true);
  });

  test('H and B are both B natural when transposing', () => {
    assertEq(C.chordsTranspose('H', 1), 'C');
    assertEq(C.chordsTranspose('H7', 2), 'Db7');
    assertEq(C.chordsTranspose('B', 1), 'C');
    assertEq(C.chordsTranspose('Hm', 0), 'Hm');
  });

  test('a section label may lead a chord line and stays text', () => {
    for (const l of ['Intro: G  D  Em  C', 'Refrain  Am  F', 'Interlude: Em  Am'])
      assertEq(C.chordsIsLine(l), true, l);
    assertEq(C.chordsIsLine('Intro: is long'), false);
    const intro = 'Intro: G   D   Em   C';
    const pro = C.chordsToPro(intro + '\n\nFirst line');
    assertEq(pro.includes('[Intro:]'), false, pro);
    assertEq(pro.startsWith('Intro:'), true, pro);
    assertEq(C.chordsToAbove(pro), intro + '\n\nFirst line');
    const html = C.chordsRender(pro, {});
    assertEq((html.match(/class="ch"/g) || []).length >= 4, true, html);
    assertEq(html.includes('Intro:'), true);
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
      '||Em         || x3     F     G     E   E7',
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

  test('render: a trailing line break adds no empty row', () => {
    assertEq((C.chordsRender('a\nb\n', {}).match(/class="chord-row"/g) || []).length, 2);
    assertEq((C.chordsRender('a\n\nb', {}).match(/class="chord-row"/g) || []).length, 3);
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

  test('chordsForSave: untouched lyrics are saved byte-for-byte', () => {
    for (const x of ['Do Re Mi\nA B C\nEasy as', 'A\nboy named Sue', 'Bb\nis a note', 'E\nverybody', '[G]la [C]la\nplain'])
      assertEq(C.chordsForSave(C.chordsToAbove(x), x), x, x);
  });

  test('chordsForSave: edited text still converts', () => {
    assertEq(C.chordsForSave('G\nla', ''), '[G]la');
    assertEq(C.chordsForSave('G\nla', undefined), '[G]la');
    assertEq(C.chordsForSave('G\nla!', 'G\nla'), '[G]la!');
  });

  // Paraphrased in the owner's layout: intro, verse, chorus, chord-less verse,
  // a lone "Refrain", a bridge.
  const SONG = [
    '[Dm7]      [Dm7]    [Gm7]    [Fmaj7]',
    '',
    '[Dm7]In my little [Dm7]house I am [Gm7]never [Fmaj7]alone',
    '[Dm7]Walls are [Dm7]thin and the [Gm7]night is [Fmaj7]long',
    '',
    '[G]Life in the [G]suburbs is [Am]fine and [Am]good',
    '[C]Everyone has a [C]place and a [D]garden [D7]too',
    '',
    'Second verse has other words',
    'and no chords at all',
    '',
    'Refrain',
    '',
    '[Em]New [Dm]neighbours [F]plant [G]trees',
  ].join('\n');

  test('parts: letters by chord sequence, chord-less verse and lone Refrain repeat', () => {
    const p = C.chordsParts(SONG);
    assertEq(p.blocks.map(b => b.letter).join(''), 'ABCBCD');
    assertEq(p.parts.map(x => x.letter).join(''), 'ABCD');
    assertEq(p.chorus, 'C');
    assertEq(p.parts[1].chords, [['Dm7', 'Dm7', 'Gm7', 'Fmaj7'], ['Dm7', 'Dm7', 'Gm7', 'Fmaj7']]);
    assertEq(p.blocks[4].label, 'Refrain');
    assertEq(p.blocks[4].kind, 'chorus');
  });

  test('parts: several verses share a letter; chorus guessed from repeated lyrics', () => {
    const t = '[G]one [C]two\n[G]three [D]four\n\n[Em]sing it [C]loud\n[G]sing it [D]proud\n\n[G]five [C]six\n[G]seven [D]eight\n\n[Em]sing it [C]loud\n[G]sing it [D]proud';
    const p = C.chordsParts(t);
    assertEq(p.blocks.map(b => b.letter).join(''), 'ABAB');
    assertEq(p.chorus, 'B');
  });

  test('parts: labels set kinds; a labelled chorus wins over the guess', () => {
    const t = 'Verse 1:\n[G]a [C]b\n\n[Chorus]\n[D]c [G]d\n\nStrophe 2\nwords only\n\nBridge\n[Em]e [C]f';
    const p = C.chordsParts(t);
    assertEq(p.blocks.map(b => b.kind).join(','), 'verse,chorus,verse,bridge');
    assertEq(p.blocks.map(b => b.letter).join(''), 'ABAC');
    assertEq(p.chorus, 'B');
  });

  test('parts: no chorus guess on a tie; edge inputs do not throw', () => {
    assertEq(C.chordsParts('[G]a\n\n[C]b').chorus, null);
    assertEq(C.chordsParts('').parts.length, 0);
    assertEq(C.chordsParts('[G]one block\n[C]no blank lines').blocks.length, 1);
    assertEq(C.chordsParts('[||]   [x3]\n\n[G]a').parts.length, 1);
    assertEq(C.chordsParts('[||]   [x3]\n\n[G]a').blocks.map(b => b.letter).join(','), ',A');
  });

  test('key: from the chords when the field is empty', () => {
    assertEq(C.chordsGuessKey('[Dm]a [Gm]b [F]c [Dm]d'), 'Dm');
    assertEq(C.chordsGuessKey('[G]a [C]b [G]c [D]d'), 'G');
    assertEq(C.chordsGuessKey('no chords'), '');
  });

  test('Nashville numbers in major and minor keys', () => {
    const g = t => C.chordsNashville(t, 'G');
    assertEq([g('G'), g('C'), g('D7'), g('Em'), g('D/F#'), g('Bb'), g('F#dim'), g('Cmaj7')].join(' '), '1 4 57 6- 5/7 b3 7° 4maj7');
    const d = t => C.chordsNashville(t, 'Dm');
    assertEq([d('Dm'), d('Gm'), d('F'), d('C'), d('A7')].join(' '), '1- 4- b3 b7 57');
    assertEq(C.chordsNashville('||Em', 'G'), '||6-');
    assertEq(C.chordsNashville('n.C.', 'G'), 'n.C.');
    assertEq(C.chordsNashville('Am', 'D minor'), '5-');
    assertEq(C.chordsNashville('Am', 'nonsense'), 'Am');
    for (const bad of ['garbage', 'bla', 'dur']) assertEq(C.chordsNashville('A', bad), 'A', bad);
    assertEq(C.chordsNashville('Am', 'F# m'), 'b3-');
    assertEq(C.chordsNashville('Eb', 'Bb'), '4');
    assertEq(C.chordsNashville('F', 'H'), '#4');
    assertEq(C.chordsNashville('Em', 'C major'), '3-');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
