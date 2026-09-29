// withBusy() in ui.js: a write button answers the click at once and
// cannot fire twice. ui.js is browser-only, so the function is lifted
// out of the source and evaluated alone.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../app/js/ui.js'), 'utf8');
const m = src.match(/async function withBusy\([\s\S]*?\n}\n/);
const withBusy = m && new Function('t', m[0] + '\nreturn withBusy;')(k => k === 'common.saving' ? 'Saving…' : k);

const btn = () => ({ disabled: false, textContent: 'Save' });

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  console.log(B('\nwithBusy'));

  await testAsync('exists in ui.js', async () => assert(typeof withBusy === 'function', 'withBusy not found'));
  if (!withBusy) return;

  await testAsync('disables and relabels while running, restores after', async () => {
    const b = btn();
    let seen;
    const out = await withBusy(b, async () => { seen = { ...b }; return 42; });
    assertEq(seen.disabled, true);
    assertEq(seen.textContent, 'Saving…');
    assertEq(b.disabled, false);
    assertEq(b.textContent, 'Save');
    assertEq(out, 42);
  });

  await testAsync('restores after a throw and rethrows', async () => {
    const b = btn();
    let threw = false;
    try { await withBusy(b, async () => { throw new Error('x'); }); } catch { threw = true; }
    assert(threw, 'error swallowed');
    assertEq(b.disabled, false);
    assertEq(b.textContent, 'Save');
  });

  await testAsync('second call while busy does not run', async () => {
    const b = btn();
    let calls = 0, release;
    const first = withBusy(b, () => { calls++; return new Promise(res => { release = res; }); });
    await withBusy(b, async () => { calls++; });
    release();
    await first;
    assertEq(calls, 1);
  });

  await testAsync('custom label', async () => {
    const b = btn();
    let label;
    await withBusy(b, async () => { label = b.textContent; }, 'Deleting…');
    assertEq(label, 'Deleting…');
  });

  await testAsync('no button still runs fn', async () => {
    assertEq(await withBusy(null, async () => 7), 7);
  });
}

module.exports = run;
