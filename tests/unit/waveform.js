'use strict';

// app/js/waveform.js: peaks of a decoded recording, stored as a short hex
// string on the song and drawn in the stage view without decoding anything.

const path = require('path');
const W = require(path.join(__dirname, '../../app/js/waveform.js'));

function run(r) {
  const { test, assertEq, assert, B } = r;
  console.log(B('\nwaveform'));

  test('peaks: one value per bar, the loudest sample of its slice, scaled so the loudest bar is 1', () => {
    const s = new Float32Array(400);
    s[10] = 0.25; s[150] = -0.5; s[399] = 0.1;
    const p = W.waveformPeaks(s, 4);
    assertEq(p.length, 4);
    assertEq(p[0], 0.5);
    assertEq(p[1], 1);
    assertEq(p[2], 0);
    assert(Math.abs(p[3] - 0.2) < 1e-6, 'last bar ' + p[3]);
  });

  test('peaks: silence and an empty recording give zeros, never NaN', () => {
    assertEq(W.waveformPeaks(new Float32Array(100), 3), [0, 0, 0]);
    assertEq(W.waveformPeaks(new Float32Array(0), 3), [0, 0, 0]);
  });

  test('peaks: a recording shorter than the bars still gives every bar', () => {
    const p = W.waveformPeaks(new Float32Array([0.5, 1]), 5);
    assertEq(p.length, 5);
    assert(p.every(v => v >= 0 && v <= 1), 'out of range');
  });

  test('encode/decode: 2 hex digits per bar, 100 bars by default, round trip within 1/255', () => {
    const peaks = Array.from({ length: W.WAVEFORM_BARS }, (_, i) => i / (W.WAVEFORM_BARS - 1));
    const s = W.waveformEncode(peaks);
    assertEq(s.length, 200);
    assert(W.waveformValid(s));
    const back = W.waveformDecode(s);
    assertEq(back.length, 100);
    back.forEach((v, i) => assert(Math.abs(v - peaks[i]) <= 1 / 255, 'bar ' + i));
  });

  test('valid: only exactly 200 lowercase hex digits', () => {
    assertEq(W.waveformValid('a'.repeat(200)), true);
    for (const bad of ['', 'a'.repeat(199), 'a'.repeat(201), 'g'.repeat(200), 'A'.repeat(200), null, undefined, 5, ['a']])
      assertEq(W.waveformValid(bad), false, String(bad));
  });

  test('decode: an invalid string gives null (the stage view then draws nothing)', () => {
    assertEq(W.waveformDecode('nope'), null);
    assertEq(W.waveformDecode(null), null);
  });

  test('draw: one bar per peak, the played part in the played colour', () => {
    const calls = [];
    const ctx = { clearRect() {}, fillRect(...a) { calls.push([ctx.fillStyle, ...a]); }, set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; } };
    const canvas = { width: 100, height: 20, getContext: () => ctx };
    W.waveformDraw(canvas, [1, 1, 1, 1], 0.5, { played: 'P', rest: 'R' });
    assertEq(calls.length, 4);
    assertEq(calls.map(c => c[0]), ['P', 'P', 'R', 'R']);
    calls.forEach(c => assert(c[4] > 0 && c[4] <= 20, 'bar height ' + c[4]));
  });
}

module.exports = run;

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}
