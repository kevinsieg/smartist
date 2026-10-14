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
    store: { get: async k => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async k => { m.delete(k); }, keys: async () => [...m.keys()] },
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

  const blobRes = { ok: true, status: 200, blob: async () => new Blob(['x']) };
  const withMelodies = { melodies: [{ sheet_urls: ['https://m/a.jpg', 'https://m/b.jpg'], audio_url: 'https://m/c.mp3' }, { sheet_urls: ['https://m/a.jpg'], audio_url: null }] };

  test('offlineMediaUrls lists every sheet image and recording once', () => {
    assertEq(O.offlineMediaUrls(withMelodies), ['https://m/a.jpg', 'https://m/b.jpg', 'https://m/c.mp3']);
    assertEq(O.offlineMediaUrls({}), []);
    assertEq(O.offlineMediaUrls(null), []);
  });

  await testAsync('a saved media file comes back as an object URL, only for the user who saved it', async () => {
    const d = makeDeps({ token: () => tok(7), fetch: async () => blobRes });
    await O.offlineMediaSave('https://m/c.mp3', d);
    assert((await O.offlineMediaGet('https://m/c.mp3', d)).startsWith('blob:'), 'expected a blob: url');
    assertEq(await O.offlineMediaGet('https://m/other.mp3', d), null);
    const other = makeDeps({ token: () => tok(8), store: d.store });
    assertEq(await O.offlineMediaGet('https://m/c.mp3', other), null);
  });

  await testAsync('offlineKeep also saves the melody files of every song, as cors requests', async () => {
    const modes = [], caches = [];
    const d = makeDeps({ fetch: async (u, o) => {
      if (u.startsWith('https://m/')) { modes.push(o && o.mode); caches.push(o && o.cache); return blobRes; }
      return ok(u.includes('/setlists/') ? { songs: [{ id: 4 }] } : u.includes('/songs/4') ? withMelodies : {});
    } });
    const progress = [];
    const out = await O.offlineKeep('b', 3, (a, b) => progress.push([a, b]), d);
    assertEq(out, { saved: 5, failed: [] });
    assertEq(modes, ['cors', 'cors', 'cors']);
    assertEq(caches, ['reload', 'reload', 'reload'], 'a copy cached by an earlier plain <img>/<audio> load has no CORS headers');
    assertEq(progress[progress.length - 1], [5, 5]);
    assert(await d.store.get('media:https://m/b.jpg'), 'media not stored');
  });

  await testAsync('a melody file that cannot be fetched is reported and the rest is kept', async () => {
    const d = makeDeps({ fetch: async u => {
      if (u === 'https://m/b.jpg') throw new TypeError('Failed to fetch');
      if (u.startsWith('https://m/')) return blobRes;
      return ok(u.includes('/setlists/') ? { songs: [{ id: 4 }] } : u.includes('/songs/4') ? withMelodies : {});
    } });
    const out = await O.offlineKeep('b', 3, null, d);
    assertEq(out.failed, ['https://m/b.jpg']);
    assertEq(out.saved, 4);
  });

  await testAsync('keeping a setlist again does not download files already saved', async () => {
    let fetched = 0;
    const d = makeDeps({ fetch: async u => {
      if (u.startsWith('https://m/')) { fetched++; return blobRes; }
      return ok(u.includes('/setlists/') ? { songs: [{ id: 4 }] } : u.includes('/songs/4') ? withMelodies : {});
    } });
    await O.offlineKeep('b', 3, null, d);
    assertEq(fetched, 3);
    const out = await O.offlineKeep('b', 3, null, d);
    assertEq(fetched, 3);
    assertEq(out, { saved: 5, failed: [] });
  });

  // ---- kept setlists: the green/grey icon, prune and re-sync ------------------

  // Setlist 3 holds songs 4 and 5, setlist 6 holds songs 5 and 7. Song 5 has the
  // melody files; the others none. `world.lists` can change between calls.
  function world(over) {
    const w = { lists: { 3: [4, 5], 6: [5, 7] }, gone: {}, down: false, fetched: [] };
    const d = makeDeps(Object.assign({ fetch: async u => {
      w.fetched.push(u);
      if (w.down) throw new TypeError('Failed to fetch');
      if (u.startsWith('https://m/')) return blobRes;
      const sl = u.match(/\/setlists\/(\d+)$/);
      if (sl) return w.gone[sl[1]] ? bad(404) : ok({ songs: (w.lists[sl[1]] || []).map(id => ({ id })) });
      return ok(u.includes('/songs/5') ? withMelodies : {});
    } }, over));
    return Object.assign(w, { d });
  }
  const has = async (d, k) => (await d.store.get(k)) !== undefined;

  await testAsync('a kept setlist is recorded for this user only, with what it uses', async () => {
    const w = world({ token: () => tok(7), now: () => 5000 });
    assertEq(await O.offlineKept('b', 3, w.d), null);
    await O.offlineKeep('b', 3, null, w.d);
    const rec = await O.offlineKept('b', 3, w.d);
    assertEq(rec.syncedAt, 5000);
    assert(rec.urls.includes('/api/b/songs/4') && rec.urls.includes('/api/b/setlists/3'), 'urls ' + rec.urls);
    assertEq(rec.media, ['https://m/a.jpg', 'https://m/b.jpg', 'https://m/c.mp3']);
    assertEq(await O.offlineKept('b', 3, makeDeps({ token: () => tok(8), store: w.d.store })), null);
  });

  await testAsync('keeping again prunes what the setlist no longer uses', async () => {
    const w = world();
    await O.offlineKeep('b', 3, null, w.d);
    w.lists[3] = [4];
    await O.offlineKeep('b', 3, null, w.d);
    assert(await has(w.d, '/api/b/songs/4'), 'song 4 must stay');
    assert(!(await has(w.d, '/api/b/songs/5')), 'song 5 is no longer in the setlist');
    assert(!(await has(w.d, 'media:https://m/a.jpg')), 'its melody files must go with it');
  });

  await testAsync('what another kept setlist still uses is never pruned', async () => {
    const w = world();
    await O.offlineKeep('b', 3, null, w.d);
    await O.offlineKeep('b', 6, null, w.d);
    w.lists[3] = [4];
    await O.offlineKeep('b', 3, null, w.d);
    assert(await has(w.d, '/api/b/songs/5'), 'song 5 is in setlist 6');
    assert(await has(w.d, 'media:https://m/c.mp3'), 'its recording too');
  });

  await testAsync('removing a kept setlist deletes only what no other one uses', async () => {
    const w = world();
    await O.offlineKeep('b', 3, null, w.d);
    await O.offlineKeep('b', 6, null, w.d);
    await O.offlineRelease('b', 3, w.d);
    assertEq(await O.offlineKept('b', 3, w.d), null);
    assert(!(await has(w.d, '/api/b/setlists/3')) && !(await has(w.d, '/api/b/songs/4')), 'only setlist 3 used these');
    assert(await has(w.d, '/api/b/songs/5') && await has(w.d, '/api/b/songs/7'), 'setlist 6 still needs these');
    assert(await has(w.d, '/api/config?light=1&slug=b'), 'the config is shared');
    await O.offlineRelease('b', 6, w.d);
    assert(!(await has(w.d, 'media:https://m/a.jpg')) && !(await has(w.d, '/api/config?light=1&slug=b')), 'nothing left uses these');
  });

  await testAsync('removing what was never kept does nothing', async () => {
    const w = world();
    await O.offlineKeep('b', 3, null, w.d);
    await O.offlineRelease('b', 99, w.d);
    assert(await has(w.d, '/api/b/songs/4'));
  });

  await testAsync('re-sync refreshes stale kept setlists only, and prunes', async () => {
    let t = 0;
    const w = world({ now: () => t });
    await O.offlineKeep('b', 3, null, w.d);
    t = 10 * 60 * 1000;
    w.fetched.length = 0;
    assertEq(await O.offlineSyncKept(w.d), 0);
    assertEq(w.fetched, [], 'a copy synced ten minutes ago is fresh');
    t = 2 * 60 * 60 * 1000;
    w.lists[3] = [4];
    assertEq(await O.offlineSyncKept(w.d), 1);
    assert(!(await has(w.d, '/api/b/songs/5')), 'pruned by the re-sync');
    assertEq((await O.offlineKept('b', 3, w.d)).syncedAt, t);
  });

  await testAsync('re-sync with no connection changes nothing and does not throw', async () => {
    let t = 0;
    const w = world({ now: () => t });
    await O.offlineKeep('b', 3, null, w.d);
    t = 3 * 60 * 60 * 1000; w.down = true;
    assertEq(await O.offlineSyncKept(w.d), 0);
    assert(await has(w.d, '/api/b/songs/5'));
    assertEq((await O.offlineKept('b', 3, w.d)).syncedAt, 0);
  });

  await testAsync('a kept setlist that was deleted on the server is removed on re-sync', async () => {
    let t = 0;
    const w = world({ now: () => t });
    await O.offlineKeep('b', 3, null, w.d);
    t = 3 * 60 * 60 * 1000; w.gone[3] = true;
    await O.offlineSyncKept(w.d);
    assertEq(await O.offlineKept('b', 3, w.d), null);
    assert(!(await has(w.d, '/api/b/songs/4')), 'its copies go with it');
  });

  await testAsync('re-sync leaves another user\'s kept setlists alone', async () => {
    let t = 0;
    const w = world({ now: () => t, token: () => tok(1) });
    await O.offlineKeep('b', 3, null, w.d);
    t = 3 * 60 * 60 * 1000;
    w.fetched.length = 0;
    assertEq(await O.offlineSyncKept(makeDeps({ token: () => tok(2), store: w.d.store, now: () => t, fetch: w.d.fetch })), 0);
    assertEq(w.fetched, []);
  });
}

module.exports = run;

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
