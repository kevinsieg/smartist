#!/usr/bin/env node
// Client-side tests for the offline banner, the failed-save notice and the
// wipe (core.js), and for apiFetch marking network errors (session.js).
// Functions are extracted from the shared scripts and run against stubbed
// browser globals.

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const COMMON = ['core', 'session']
  .map(n => fs.readFileSync(path.join(__dirname, `../app/js/${n}.js`), 'utf8')).join('\n');

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log(`  ${G('✓')} ${name}`); passed++; }
  catch (e) { console.log(`  ${R('✗')} ${name}\n      ${R(e.message)}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name}() not found`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`could not brace-match ${name}()`);
}

function makeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return { setItem: (k, v) => data.set(k, String(v)), getItem: k => (data.has(k) ? data.get(k) : null), removeItem: k => data.delete(k) };
}

function makeEnv({ fetch, token } = {}) {
  const els = new Map();
  const deleted = [];
  const calls = { requireLogin: 0 };
  const context = {
    console, URL, setTimeout, clearTimeout, Promise,
    AUTH_TOKEN_KEY: 'smartist_token',
    sessionStorage: makeStorage(token ? { smartist_token: token } : {}),
    localStorage: makeStorage(),
    location: { href: 'https://app.test/b/songs', origin: 'https://app.test' },
    fetch,
    isViewMode: () => false,
    requireLogin: () => { calls.requireLogin++; },
    _sessionAlive: async () => true,
    _endDeadSession: () => {},
    indexedDB: { deleteDatabase: name => { deleted.push(name); return {}; } },
    document: {
      getElementById: id => els.get(id) || null,
      createElement: () => ({ style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, remove() { els.delete(this.id); } }),
      body: { appendChild(el) { els.set(el.id, el); } },
    },
  };
  vm.createContext(context);
  vm.runInContext(['var _offlineIsDown = false;']
    .concat(['getToken', 'offlineText', '_offlineShow', 'offlineMarkDown', 'offlineMarkUp', 'offlineNotice', 'clearOfflineData']
      .map(n => extractFunction(COMMON, n)))
    .concat(['async ' + extractFunction(COMMON, 'apiFetch')]).join('\n'), context);
  return { context, els, deleted, calls };
}

const net = async () => { throw new TypeError('Failed to fetch'); };
const resp = status => async () => ({ status, ok: status < 400 });

(async () => {
  console.log(B('\noffline notices'));

  await test('a failed read shows the banner but no notice, and throws .offline', async () => {
    const { context, els } = makeEnv({ fetch: net });
    let err; try { await context.apiFetch('/api/b/songs'); } catch (e) { err = e; }
    assertEq(err && err.offline, true);
    assert(els.has('offline-banner'), 'banner missing');
    assert(!els.has('offline-notice'), 'a read must not raise the save notice');
  });

  await test('a failed save raises the "not saved" notice even if the page swallows the error', async () => {
    const { context, els } = makeEnv({ fetch: net });
    await context.apiFetch('/api/b/songs', 'POST', { title: 'x' }).catch(() => {});
    assert(els.has('offline-notice'), 'notice missing');
    assertEq(els.get('offline-notice').textContent, 'Not saved. No connection.');
  });

  await test('the next successful request removes the banner', async () => {
    const { context, els } = makeEnv({ fetch: net });
    await context.apiFetch('/api/b/songs').catch(() => {});
    context.fetch = resp(200);
    await context.apiFetch('/api/b/songs');
    assert(!els.has('offline-banner'), 'banner still there');
  });

  await test('a 401 still ends the session and now wipes the saved offline data', async () => {
    const { context, deleted, calls } = makeEnv({ fetch: resp(401), token: 't' });
    let err; try { await context.apiFetch('/api/b/songs'); } catch (e) { err = e; }
    assertEq(err && err.message, 'Session expired');
    assertEq(context.sessionStorage.getItem('smartist_token'), null);
    assertEq(deleted, ['smartist-offline']);
    assertEq(calls.requireLogin, 1);
  });

  console.log(`\n${B('─'.repeat(40))}`);
  console.log(`${G(`${passed} passed`)}  ${failed ? R(`${failed} failed`) : D('0 failed')}`);
  process.exit(failed > 0 ? 1 : 0);
})();
