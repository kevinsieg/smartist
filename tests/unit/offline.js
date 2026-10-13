'use strict';

// app/js/offline.js: what the stage view reads is saved per user and served
// again when the network fails. Everything the module touches is injected.

const path = require('path');
const { makeRunner } = require('./_runner');
const O = require(path.join(__dirname, '../../app/js/offline.js'));

const tok = userId => Buffer.from(JSON.stringify({ payload: JSON.stringify({ userId }), sig: 'x' })).toString('base64url');
const ok = body => ({ ok: true, status: 200, json: async () => body });
const bad = s => ({ ok: false, status: s, json: async () => ({}) });
const down = async () => { throw new TypeError('Failed to fetch'); };

function makeDeps(over) {
  const m = new Map();
  const d = {
    store: { get: async k => m.get(k), set: async (k, v) => { m.set(k, v); } },
    now: () => 1000, token: () => null, timeoutMs: 20, cleared: 0, marked: 0,
    clear: async () => { d.cleared++; }, markDown: () => { d.marked++; },
    fetch: async () => ok({ a: 1 }),
  };
  return Object.assign(d, over);
}

async function run(r) {
  const { testAsync, test, assert, assertEq, B } = r;
  console.log(B('\noffline'));

  test('the owner is the user id in the token, "anonymous" without one', () => {
    assertEq(O.offlineOwner(tok(7)), 'user:7');
    assertEq(O.offlineOwner(null), 'anonymous');
    assertEq(O.offlineOwner('not-a-token'), 'anonymous');
  });

  await testAsync('online: returns the answer and saves it', async () => {
    const d = makeDeps();
    const res = await O.offlineFetch('/api/b/songs/1', {}, d);
    assertEq(res, { data: { a: 1 }, savedAt: null, fromCache: false });
    assertEq((await d.store.get('/api/b/songs/1')).savedAt, 1000);
  });

  await testAsync('network down: serves the saved copy and shows the banner', async () => {
    const d = makeDeps();
    await O.offlineFetch('/api/b/songs/1', {}, d);
    d.fetch = down; d.now = () => 5000;
    const res = await O.offlineFetch('/api/b/songs/1', {}, d);
    assertEq(res, { data: { a: 1 }, savedAt: 1000, fromCache: true });
    assertEq(d.marked, 1);
  });

  await testAsync('a request that hangs falls back after the timeout (wifi without internet)', async () => {
    const d = makeDeps();
    await O.offlineFetch('/api/b/songs/1', {}, d);
    d.fetch = () => new Promise(() => {});
    const res = await O.offlineFetch('/api/b/songs/1', {}, d);
    assertEq(res.fromCache, true);
  });

  await testAsync('502/503/504 serve the saved copy without the offline banner', async () => {
    for (const s of [502, 503, 504]) {
      const d = makeDeps();
      await O.offlineFetch('/api/b/songs/1', {}, d);
      d.fetch = async () => bad(s);
      assertEq((await O.offlineFetch('/api/b/songs/1', {}, d)).fromCache, true, String(s));
      assertEq(d.marked, 0, 'a server error is not "offline"');
    }
  });

  await testAsync('404 is never replaced by the saved copy (a deleted song stays deleted)', async () => {
    const d = makeDeps();
    await O.offlineFetch('/api/b/songs/1', {}, d);
    d.fetch = async () => bad(404);
    let err; try { await O.offlineFetch('/api/b/songs/1', {}, d); } catch (e) { err = e; }
    assertEq(err && err.status, 404);
  });

  await testAsync('401 wipes the saved data and fails', async () => {
    const d = makeDeps();
    d.fetch = async () => bad(401);
    let err; try { await O.offlineFetch('/api/b/songs/1', {}, d); } catch (e) { err = e; }
    assertEq(err && err.status, 401);
    assertEq(d.cleared, 1);
  });

  await testAsync('a copy saved by another user is never served', async () => {
    const d = makeDeps({ token: () => tok(1) });
    await O.offlineFetch('/api/b/songs/1', {}, d);
    d.token = () => tok(2); d.fetch = down;
    let err; try { await O.offlineFetch('/api/b/songs/1', {}, d); } catch (e) { err = e; }
    assertEq(err && err.offline, true);
  });

  await testAsync('offline with nothing saved fails with .offline', async () => {
    const d = makeDeps({ fetch: down });
    let err; try { await O.offlineFetch('/api/b/songs/9', {}, d); } catch (e) { err = e; }
    assertEq(err && err.offline, true);
  });

  await testAsync('a broken store never breaks online use', async () => {
    const boom = async () => { throw new Error('IndexedDB unavailable'); };
    const d = makeDeps({ store: { get: boom, set: boom } });
    assertEq((await O.offlineFetch('/api/b/songs/1', {}, d)).data, { a: 1 });
    d.fetch = down;
    let err; try { await O.offlineFetch('/api/b/songs/1', {}, d); } catch (e) { err = e; }
    assertEq(err && err.offline, true);
  });

  await testAsync('after one request timed out the next ones give up fast (no 8 s + 8 s on a dead connection)', async () => {
    const d = makeDeps({ now: () => 100000, timeoutMs: 400, fastTimeoutMs: 20 });
    await O.offlineFetch('/api/b/songs/1', {}, d);
    d.fetch = () => new Promise(() => {});
    await O.offlineFetch('/api/b/songs/1', {}, d);
    const t0 = Date.now();
    const res = await O.offlineFetch('/api/b/songs/1', {}, d);
    assertEq(res.fromCache, true);
    assert(Date.now() - t0 < 200, 'second request waited the full timeout: ' + (Date.now() - t0) + ' ms');
  });

  await testAsync('a store whose save never finishes does not hold up an online answer', async () => {
    const d = makeDeps({ store: { get: async () => undefined, set: () => new Promise(() => {}) } });
    const res = await Promise.race([O.offlineFetch('/api/b/songs/1', {}, d), new Promise(r => setTimeout(() => r('stuck'), 200))]);
    assertEq(res.data, { a: 1 });
  });

  await testAsync('a store whose read never finishes does not hold up the offline error', async () => {
    const d = makeDeps({ fetch: down, store: { get: () => new Promise(() => {}), set: async () => {} } });
    const res = await Promise.race([O.offlineFetch('/api/b/songs/1', {}, d).catch(e => e), new Promise(r => setTimeout(() => r('stuck'), 300))]);
    assertEq(res && res.offline, true);
  });

  await testAsync('offlineKeep saves the config, the setlist and every song, with progress', async () => {
    const calls = [];
    const d = makeDeps({ fetch: async u => { calls.push(u); return ok(u.includes('/setlists/') ? { songs: [{ id: 4 }, { id: 5 }] } : { u }); } });
    const progress = [];
    const out = await O.offlineKeep('b', 3, (a, b) => progress.push([a, b]), d);
    assertEq(out, { saved: 3, failed: [] });
    assertEq(progress[progress.length - 1], [3, 3]);
    for (const u of ['/api/config?light=1&slug=b', '/api/b/setlists/3', '/api/b/songs/4', '/api/b/songs/5'])
      assert(await d.store.get(u), 'not saved: ' + u);
  });

  await testAsync('offlineKeep reports the songs that failed and keeps going', async () => {
    const d = makeDeps({ fetch: async u => u.includes('/songs/5') ? bad(500) : ok(u.includes('/setlists/') ? { songs: [{ id: 4 }, { id: 5 }] } : {}) });
    const out = await O.offlineKeep('b', 3, null, d);
    assertEq(out.failed, ['/api/b/songs/5']);
    assertEq(out.saved, 2);
  });

  await testAsync('offlineKeep never "keeps" from an old copy: offline it fails', async () => {
    const d = makeDeps();
    await O.offlineFetch('/api/b/setlists/3', {}, d);
    d.fetch = down;
    let err; try { await O.offlineKeep('b', 3, null, d); } catch (e) { err = e; }
    assertEq(err && err.offline, true);
  });
}

module.exports = run;

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
