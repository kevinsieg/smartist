'use strict';

// scripts/_setlist_csv.js: the logic of scripts/import_setlist_csv.js — which
// CSV row is which existing song, and what a match may fill in. Pure, so it is
// tested here without a database.

const path = require('path');
const { makeRunner } = require('./_runner');
const L = require(path.join(__dirname, '../../scripts/_setlist_csv.js'));

function run(r) {
  const { test, assert, assertEq, B } = r;
  const song = (id, title, over) => Object.assign({ id, title, length_min: null, interpret: null, extra: {}, deleted: false }, over);

  console.log(B('\nsetlist csv import'));

  test('titles compare ignoring case, accents, punctuation and leading articles', () => {
    assertEq(L.normTitle("Les Penn' Sardin"), 'penn sardin');
    assertEq(L.normTitle('Penn sardin'), 'penn sardin');
    assertEq(L.normTitle('  Océano  Nox '), 'oceano nox');
    assertEq(L.normTitle("L’Hirondelle"), 'hirondelle');
    assertEq(L.normTitle('Nous marins de Terre-Neuve'), 'nous marins de terre neuve');
  });

  test('parseRows reads the columns, with French header aliases', () => {
    const out = L.parseRows('title,length,author,compositeur,harmonisation,traditional\nAnita,3:48,A,B,C,no\nLa Margot,2:40,,,C,yes\n');
    assertEq(out.errors, []);
    assertEq(out.rows[0], { line: 2, title: 'Anita', length_min: 3.8, author: 'A', composer: 'B', arranger: 'C', traditional: false });
    assertEq(out.rows[1].traditional, true);
    assertEq(out.rows[1].author, null);
  });

  test('parseRows reports a missing title column, a bad length and a repeated title', () => {
    assertEq(L.parseRows('name,length\nx,1:00\n').errors.length, 1);
    const bad = L.parseRows('title,length\nA,abc\nB,2:00\nb,2:10\n');
    assertEq(bad.errors.length, 2);
    assert(/line 2/.test(bad.errors[0]) && /line 4/.test(bad.errors[1]), bad.errors.join(' | '));
  });

  test('a normalized title match is the same song', () => {
    const c = L.classify({ title: "Les Penn' Sardin" }, [song(1, 'Penn sardin'), song(2, 'Anita')], {});
    assertEq(c.kind, 'match');
    assertEq(c.song.id, 1);
  });

  test('a close title is "maybe", never matched on its own', () => {
    const sub = L.classify({ title: "Sa compagne c'est la mer" }, [song(1, 'Sa Compagne')], {});
    assertEq(sub.kind, 'maybe');
    assertEq(sub.candidates.map(s => s.id), [1]);
    const near = L.classify({ title: 'Chant des Terre-neuvas' }, [song(1, 'Chant de Terre Neuve')], {});
    assertEq(near.kind, 'maybe');
  });

  test('a typo or a swapped letter is a "maybe", so a slightly wrong earlier import is highlighted', () => {
    for (const existing of ['Chant des Terre-neuva', 'Chant des Terre-nuevas', 'Chant des Terre-neuvas ', 'Chant des Terreneuvas'])
      assertEq(L.classify({ title: 'Chant des Terre-neuvas' }, [song(1, existing)], {}).kind, existing === 'Chant des Terre-neuvas ' ? 'match' : 'maybe', existing);
  });

  test('an unrelated title is new', () => {
    assertEq(L.classify({ title: 'Surcouf' }, [song(1, 'Anita'), song(2, 'La Margot')], {}).kind, 'new');
  });

  test('a deleted song is never matched, but a same title is a "maybe"', () => {
    const c = L.classify({ title: 'Anita' }, [song(1, 'Anita', { deleted: true })], {});
    assertEq(c.kind, 'maybe');
    assertEq(c.candidates[0].deleted, true);
  });

  test('two live songs with the same normalized title are ambiguous, not matched', () => {
    const c = L.classify({ title: 'Anita' }, [song(1, 'Anita'), song(2, 'anita')], {});
    assertEq(c.kind, 'maybe');
    assertEq(c.candidates.length, 2);
  });

  test('--same settles a "maybe" by title', () => {
    const same = L.parseSame(["Sa compagne c'est la mer=Sa Compagne"]);
    const c = L.classify({ title: "Sa compagne c'est la mer" }, [song(1, 'Sa Compagne')], same);
    assertEq(c.kind, 'match');
    assertEq(c.song.id, 1);
  });

  test('--new settles a "maybe" as a new song', () => {
    const c = L.classify({ title: 'Anita' }, [song(1, 'Anita', { deleted: true })], {}, new Set([L.normTitle('Anita')]));
    assertEq(c.kind, 'new');
  });

  test('--skip leaves a title out, even a clear match', () => {
    const skip = new Set([L.normTitle('Anita')]);
    assertEq(L.classify({ title: 'Anita' }, [song(1, 'Anita')], {}, undefined, skip).kind, 'skip');
  });

  test('a typed choice becomes a decision: a number is that live candidate, n new, s skip, q abort', () => {
    const cands = [song(1, 'Chant des Terre-neuva'), song(2, 'Chant de Terre Neuve', { deleted: true })];
    assertEq(L.parseChoice('1', cands), { kind: 'same', song: cands[0] });
    assertEq(L.parseChoice(' N ', cands), { kind: 'new' });
    assertEq(L.parseChoice('s', cands), { kind: 'skip' });
    assertEq(L.parseChoice('Q', cands), { kind: 'abort' });
  });

  test('an invalid choice, a number out of range or a deleted candidate asks again', () => {
    const cands = [song(1, 'A'), song(2, 'B', { deleted: true })];
    for (const bad of ['', 'x', '0', '3', '2', '1.5']) assertEq(L.parseChoice(bad, cands), null, bad);
  });

  test('decisions are written back as the flags that repeat them without a prompt', () => {
    const flags = L.decisionFlags([
      { row: { title: 'Sa compagne c\'est la mer' }, kind: 'same', song: song(1, 'Sa Compagne') },
      { row: { title: 'Surcouf "II"' }, kind: 'new' },
      { row: { title: 'Anita' }, kind: 'skip' },
    ]);
    assertEq(flags, [
      '--same "Sa compagne c\'est la mer=Sa Compagne"',
      '--new "Surcouf \\"II\\""',
      '--skip "Anita"',
    ]);
  });

  test('a match is only completed where the song is empty; nothing is overwritten', () => {
    const row = { title: 'Anita', length_min: 3.8, author: 'A', composer: 'B', arranger: 'C', traditional: true };
    const empty = L.completion(song(1, 'Anita'), row, 'Traditionnel');
    assertEq(empty, { length_min: 3.8, interpret: 'Traditionnel', extra: { author: 'A', composer: 'B', arranger: 'C' } });
    const full = L.completion(song(1, 'Anita', { length_min: 4, interpret: 'Someone', extra: { author: 'X', composer: 'Y', arranger: 'Z' } }), row, 'Traditionnel');
    assertEq(full, null);
    const part = L.completion(song(1, 'Anita', { length_min: 4, extra: { author: 'X' } }), row, 'Traditionnel');
    assertEq(part, { interpret: 'Traditionnel', extra: { composer: 'B', arranger: 'C' } });
  });

  test('an empty or blank existing value counts as empty', () => {
    const row = { title: 'Anita', length_min: null, author: 'A', composer: null, arranger: null, traditional: false };
    assertEq(L.completion(song(1, 'Anita', { interpret: '', extra: { author: ' ' } }), row, 'T'), { extra: { author: 'A' } });
  });

  test('a new song carries every field the CSV has', () => {
    const row = { title: 'La Margot', length_min: 2.667, author: null, composer: null, arranger: 'C', traditional: true };
    assertEq(L.newSong(row, 'Traditionnel'), { title: 'La Margot', length_min: 2.667, interpret: 'Traditionnel', extra: { arranger: 'C' } });
  });
}

module.exports = run;

if (require.main === module) {
  const r = makeRunner();
  Promise.resolve(run(r)).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
