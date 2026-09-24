#!/usr/bin/env node
// Client-side tests for workspaces.js.
//
// This page is the one place a person lands when their login belongs to more
// than one band, and it loads no common.js — so a call to a common.js helper
// throws ReferenceError, the async body aborts, and the page shows its static
// heading with nothing under it. That shipped, and a static scan alone would
// not have caught the abort: the script has to actually run.
//
// workspaces.js is an IIFE, so these tests drive it the way a browser does —
// stub the globals, execute the file, wait a tick, and read the DOM it wrote.

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/workspaces.js'), 'utf8');

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); console.log(`  ${G('✓')} ${name}`); passed++; }
  catch (e) { console.log(`  ${R('✗')} ${name}\n      ${R(e.message)}`); failed++; }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function makeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    setItem: (k, v) => data.set(k, String(v)),
    getItem: k => (data.has(k) ? data.get(k) : null),
    removeItem: k => data.delete(k),
    _data: data,
  };
}

// Runs workspaces.js exactly as the page does, and returns what it produced.
async function run({ session = {}, local = {}, fetchImpl } = {}) {
  const content = { innerHTML: '' };
  const logout  = { style: {}, addEventListener() {} };
  const replaced = [];

  const context = {
    console, Promise, JSON, Object, Array, String,
    fetch: fetchImpl || (async () => ({ status: 200, json: async () => ({ artists: [] }) })),
    sessionStorage: makeStorage(session),
    localStorage: makeStorage(local),
    // The real page has i18n.js; keys echo back so assertions can spot them.
    t: key => key,
    window: { location: { replace: url => replaced.push(url) } },
    document: {
      getElementById: id => (id === 'workspaces-content' ? content : id === 'ws-logout' ? logout : null),
    },
  };
  context.location = context.window.location;
  vm.createContext(context);
  // A ReferenceError inside the IIFE surfaces as an unhandled rejection, which
  // would not fail this test on its own — capture it and assert on it instead.
  let thrown = null;
  process.once('unhandledRejection', e => { thrown = e; });
  vm.runInContext(SRC, context, { filename: 'app/js/workspaces.js' });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  return { html: content.innerHTML, replaced, thrown, session: context.sessionStorage };
}

(async () => {
  console.log(B('\nworkspaces page'));

  await test('renders a card per band — the regression that shipped blank', async () => {
    const out = await run({
      session: { smartist_token: 'tok' },
      fetchImpl: async () => ({ status: 200, json: async () => ({ artists: [
        { slug: 'band-one', name: 'Band One', role: 'admin' },
        { slug: 'band-two', name: 'Band Two', role: 'admin' },
      ] }) }),
    });
    assert(!out.thrown, 'script threw: ' + (out.thrown && out.thrown.message));
    assert(out.html.includes('/band-one/dashboard'), 'no link to the first band');
    assert(out.html.includes('/band-two/dashboard'), 'no link to the second band');
    assertEq((out.html.match(/workspace-card/g) || []).length, 2);
  });

  await test('escapes band names rather than injecting them as markup', async () => {
    const out = await run({
      session: { smartist_token: 'tok' },
      fetchImpl: async () => ({ status: 200, json: async () => ({ artists: [
        { slug: 'a', name: '<img src=x onerror=alert(1)>', role: 'admin' },
        { slug: 'b', name: 'Second', role: 'member' },
      ] }) }),
    });
    assert(!out.html.includes('<img'), 'band name was not escaped');
    assert(out.html.includes('&lt;img'), 'expected the escaped form');
  });

  await test('a remembered token in localStorage is found', async () => {
    // "Remember me" writes to localStorage only; reading the session store
    // alone left this page looking logged out.
    const out = await run({
      local: { smartist_token: 'remembered' },
      fetchImpl: async (url, opts) => {
        assertEq(opts.headers.Authorization, 'Bearer remembered');
        return { status: 200, json: async () => ({ artists: [{ slug: 'x', name: 'X', role: 'admin' }, { slug: 'y', name: 'Y', role: 'admin' }] }) };
      },
    });
    assert(!out.thrown, 'script threw: ' + (out.thrown && out.thrown.message));
    assertEq((out.html.match(/workspace-card/g) || []).length, 2);
  });

  await test('no token at all shows the sign-in prompt, not an empty page', async () => {
    const out = await run({});
    assert(out.html.includes('workspaces.unauthHint'), 'expected the unauthenticated hint');
    assert(out.html.includes('/login'), 'expected a way back to login');
  });

  await test('no bands offers to create the first one', async () => {
    const out = await run({
      session: { smartist_token: 'tok' },
      fetchImpl: async () => ({ status: 200, json: async () => ({ artists: [] }) }),
    });
    assert(out.html.includes('workspaces.createFirst'), 'expected the create-first call to action');
    assert(out.html.includes('/onboarding'));
  });

  await test('exactly one band skips the page and opens it', async () => {
    const out = await run({
      session: { smartist_token: 'tok' },
      fetchImpl: async () => ({ status: 200, json: async () => ({ artists: [{ slug: 'only', name: 'Only', role: 'admin' }] }) }),
    });
    assertEq(out.replaced, ['/only/dashboard']);
  });

  await test('the skip flag stops the single-band redirect, and is consumed', async () => {
    // Set when a page bounced here after a config failure — without it the two
    // pages redirect to each other forever.
    const out = await run({
      session: { smartist_token: 'tok', ws_skip_autoredirect: '1' },
      fetchImpl: async () => ({ status: 200, json: async () => ({ artists: [{ slug: 'only', name: 'Only', role: 'admin' }] }) }),
    });
    assertEq(out.replaced, [], 'must not redirect while the flag is set');
    assert(out.html.includes('/only/dashboard'), 'expected the band listed instead');
    assertEq(out.session.getItem('ws_skip_autoredirect'), null, 'the flag must be cleared after use');
  });

  await test('a 401 shows the sign-in prompt and keeps the stored token', async () => {
    // A legacy bootstrap session cannot list workspaces; discarding the token
    // here would log a working session out.
    const out = await run({
      session: { smartist_token: 'tok' },
      fetchImpl: async () => ({ status: 401, json: async () => ({ error: 'Unauthorized' }) }),
    });
    assert(out.html.includes('workspaces.unauthHint'));
    assertEq(out.session.getItem('smartist_token'), 'tok', 'the token must survive a 401 here');
  });

  await test('a network failure says so instead of rendering nothing', async () => {
    const out = await run({
      session: { smartist_token: 'tok' },
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert(out.html.includes('workspaces.loadError'), 'expected the load-error message');
  });

  console.log(`\n${B('─'.repeat(40))}`);
  console.log(`${G(`${passed} passed`)}  ${failed ? R(`${failed} failed`) : D('0 failed')}`);
  process.exit(failed > 0 ? 1 : 0);
})();
