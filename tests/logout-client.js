#!/usr/bin/env node
// Client-side tests for doLogout() in shell.js (with session.js helpers).
//
// Logging out used to clear the tokens and hide the authed controls without
// navigating, so the dashboard stayed on screen with every row still rendered.
// It looked like nothing had happened, and on a private workspace it left data
// visible that the session no longer entitled anyone to see.
//
// doLogout is extracted with its collaborators and run against stubbed browser
// globals, so the assertions are about what it actually does to the page.

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
// The shared scripts, in page load order.
const COMMON = ['core', 'session', 'ui', 'shell']
  .map(n => fs.readFileSync(path.join(REPO_ROOT, `app/js/${n}.js`), 'utf8')).join('\n');

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ${G('✓')} ${name}`); passed++; }
  catch (e) { console.log(`  ${R('✗')} ${name}\n      ${R(e.message)}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Pull one top-level function, brace-matched, out of the shared scripts.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name}() not found in the shared scripts`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`could not brace-match ${name}()`);
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

function runLogout({ session = {}, local = {} } = {}) {
  const assigned = [];
  const removedEls = [];
  const header = { classList: { removed: [], remove(c) { this.removed.push(c); } } };

  const context = {
    console,
    AUTH_TOKEN_KEY: 'smartist_token',
    _artistSlug: 'myband',
    sessionStorage: makeStorage(session),
    localStorage: makeStorage(local),
    window: { location: { assign: url => assigned.push(url) } },
    document: {
      getElementById: id => (id === 'nav-auth-menu' ? { remove: () => removedEls.push(id) } : null),
      querySelector: sel => (sel === '.app-header' ? header : null),
    },
  };
  vm.createContext(context);
  vm.runInContext(
    [extractFunction(COMMON, 'clearToken'),
     extractFunction(COMMON, 'invalidateConfigCache'),
     extractFunction(COMMON, 'doLogout'),
     'doLogout();'].join('\n'),
    context, { filename: 'app/js/shell.js' }
  );
  return { assigned, removedEls, header, ...context };
}

console.log(B('\nlogout'));

test('leaves the page instead of sitting on the dashboard', () => {
  const out = runLogout({ session: { smartist_token: 'tok' } });
  assertEq(out.assigned, ['/login'],
    'the dashboard stays on screen with its data unless logout navigates');
});

test('does not carry a next= back to where it was', () => {
  const out = runLogout({ session: { smartist_token: 'tok' } });
  assert(!out.assigned[0].includes('next='), 'a logout should not remember the page it left');
});

test('clears the token from both stores', () => {
  // "Remember me" writes to localStorage; clearing only the session store
  // leaves a half-logged-out state where the next visit is signed in again.
  const out = runLogout({ session: { smartist_token: 'a' }, local: { smartist_token: 'b' } });
  assertEq(out.sessionStorage.getItem('smartist_token'), null);
  assertEq(out.localStorage.getItem('smartist_token'), null);
});

test('clears the legacy setlist_token too', () => {
  const out = runLogout({ session: { smartist_token: 'a', setlist_token: 'legacy' } });
  assertEq(out.sessionStorage.getItem('setlist_token'), null,
    'the old key kept bootstrap sessions alive after logout');
});

test('forgets the signed-in email', () => {
  const out = runLogout({ session: { smartist_token: 'a', smartist_admin_email: 'kev@example.com' } });
  assertEq(out.sessionStorage.getItem('smartist_admin_email'), null);
});

test('drops the cached band config', () => {
  // Otherwise the next person to use the browser sees the previous band's
  // name and logo in the nav before their own config loads.
  const out = runLogout({ session: {
    smartist_token: 'a',
    artist_config_cache_myband: '{"name":"My Band"}',
    artist_config_cache_myband_light: '{"name":"My Band"}',
  } });
  assertEq(out.sessionStorage.getItem('artist_config_cache_myband'), null);
  assertEq(out.sessionStorage.getItem('artist_config_cache_myband_light'), null);
});

test('closes the nav menu on the way out', () => {
  const out = runLogout({ session: { smartist_token: 'a' } });
  assert(out.removedEls.includes('nav-auth-menu'), 'the open auth menu should be dismissed');
  assert(out.header.classList.removed.includes('nav-open'), 'the mobile nav should be closed');
});

console.log(`\n${B('─'.repeat(40))}`);
console.log(`${G(`${passed} passed`)}  ${failed ? R(`${failed} failed`) : D('0 failed')}`);
process.exit(failed > 0 ? 1 : 0);
