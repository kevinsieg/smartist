#!/usr/bin/env node
// Client-side unit tests for home.js stored-session validation.
// home.js is evaluated in a vm sandbox with stubbed browser globals so we can
// call its functions directly without a DOM.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const HOME_SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/home.js'), 'utf8')
  .replace(/\ninit\(\);\s*$/, ''); // drop the auto-run so eval has no side effects

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ${G('✓')} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${R('✗')} ${name}`);
    console.log(`      ${R(e.message)}`);
    failures.push({ name, error: e.message });
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function makeStorage() {
  const data = new Map();
  return {
    setItem(k, v) { data.set(k, String(v)); },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    removeItem(k) { data.delete(k); },
  };
}

function makeContext(fetchImpl) {
  const context = {
    atob, Date, URLSearchParams, URL, console,
    fetch: fetchImpl,
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
  };
  vm.createContext(context);
  vm.runInContext(HOME_SRC, context, { filename: 'app/js/home.js' });
  context.artistSlug = 'testband';
  return context;
}

(async () => {
  console.log(B('\nhome session validation'));

  await test('valid stored token is validated via my-artists (Bearer), not the password endpoint', async () => {
    let request = null;
    const ctx = makeContext(async (url, opts) => {
      request = { url, opts: opts || {} };
      return { ok: true, status: 200, json: async () => ({ artists: [{ slug: 'band', name: 'Band', role: 'admin' }] }) };
    });
    const res = await ctx.verifySession('tok-123');
    assertEq(res.ok, true);
    assertEq(res.artists.length, 1);
    assert(request.url.indexOf('action=my-artists') !== -1, 'must call the my-artists endpoint, got ' + request.url);
    assert(request.url.indexOf('/auth') === -1, 'must NOT post the token to the password/auth endpoint');
    assertEq(request.opts.headers.Authorization, 'Bearer tok-123');
  });

  await test('invalid or expired stored token (401) reports not logged in', async () => {
    const ctx = makeContext(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorised' }) }));
    const res = await ctx.verifySession('stale-token');
    assertEq(res.ok, false);
    assertEq(res.artists.length, 0);
  });

  await test('network error during session check reports not logged in', async () => {
    const ctx = makeContext(async () => { throw new Error('offline'); });
    const res = await ctx.verifySession('tok');
    assertEq(res.ok, false);
    assertEq(res.artists.length, 0);
  });

  console.log(B('\nhome OAuth error at the multi-tenant root'));

  // A failed Google/Facebook sign-in lands on /login?oauth_error=1. At the
  // root there is no band, and the early "no workspace" return used to render
  // a bare form: the error vanished and the page looked like nothing happened.
  await test('oauth_error at the root shows the error message on the login form', async () => {
    const ctx = makeContext(async () => ({ ok: false, json: async () => ({}) }));
    let rendered;
    ctx.window = { location: { search: '?oauth_error=1', hash: '', pathname: '/login' } };
    ctx.history = { replaceState() {} };
    ctx.AUTH_TOKEN_KEY = 'smartist_token';
    ctx.t = (k) => k;
    ctx.loadConfig = async () => ({ name: '', config: {} });  // no slug: the root
    ctx.renderLogin = (msg) => { rendered = { msg }; };
    ctx.renderSetPassword = () => { rendered = { setPassword: true }; };
    await vm.runInContext('init()', ctx);
    assert(rendered, 'nothing rendered');
    assertEq(rendered.msg, 'home.oauthErrorMsg');
  });

  console.log(B('\nhome OAuth sign-in completion'));

  // The callback leaves the session in an HttpOnly cookie and sends the
  // browser to /login#oauth=1; the page trades the cookie for the token once
  // (POST oauth-session) and never sees it in a URL. Every Google and Facebook
  // sign-in ends here.
  function oauthArrival(handover, artists) {
    const calls = { fetch: [], stored: [], rendered: null, replaced: 0 };
    const ctx = makeContext(async (url, opts = {}) => {
      calls.fetch.push({ url, opts });
      if (opts.method === 'POST') return handover;
      return artists
        ? { ok: true, status: 200, json: async () => ({ artists }) }
        : { ok: false, status: 401, json: async () => ({}) };
    });
    ctx.window = { location: { search: '', hash: '#oauth=1&hint=' + Buffer.from('me@example.test').toString('base64url'), pathname: '/login', origin: 'https://app.example' } };
    ctx.history = { replaceState() { calls.replaced++; } };
    ctx.AUTH_TOKEN_KEY = 'smartist_token';
    ctx.t = (k) => k;
    ctx.storeToken = (tok, remember) => { calls.stored.push([tok, remember]); ctx.sessionStorage.setItem('smartist_token', tok); };
    ctx.loadConfig = async () => ({ name: '', config: { oauth: true } });
    ctx.renderLoggedIn = (cfg, list) => { calls.rendered = { loggedIn: true, cfg, artists: list }; };
    ctx.renderLogin = (msg, cfg) => { calls.rendered = { msg, cfg }; };
    return { ctx, calls };
  }
  const handoverOk = { ok: true, status: 200, json: async () => ({ token: 'tok-oauth' }) };

  await test('#oauth=1 trades the cookie for the session once and signs in', async () => {
    const { ctx, calls } = oauthArrival(handoverOk, [{ slug: 'band', name: 'Band', role: 'admin' }]);
    await vm.runInContext('init()', ctx);
    const post = calls.fetch.filter(c => c.opts.method === 'POST');
    assertEq(post.length, 1, 'one handover request');
    assertEq(post[0].url, '/api/config');
    assertEq(JSON.parse(post[0].opts.body), { action: 'oauth-session' });
    assertEq(calls.stored, [['tok-oauth', false]]);
    const check = calls.fetch.find(c => c.opts.method !== 'POST');
    assertEq(check.opts.headers.Authorization, 'Bearer tok-oauth');
    assert(calls.rendered && calls.rendered.loggedIn, 'not signed in');
    assertEq(calls.rendered.artists.length, 1);
    assert(calls.replaced > 0, 'the #oauth fragment stays in the address bar');
    assertEq(ctx.sessionStorage.getItem('smartist_admin_email'), 'me@example.test');
  });

  await test('a spent or missing cookie → "invalid link" on the login form, nothing stored', async () => {
    const { ctx, calls } = oauthArrival({ ok: false, status: 401, json: async () => ({}) }, null);
    await vm.runInContext('init()', ctx);
    assertEq(calls.stored, []);
    assertEq(calls.rendered.msg, 'home.invalidLink');
    assert(calls.rendered.cfg && calls.rendered.cfg.config.oauth, 'the form lost its sign-in buttons');
  });

  await test('a session the server refuses is dropped again', async () => {
    const { ctx, calls } = oauthArrival(handoverOk, null);
    await vm.runInContext('init()', ctx);
    assertEq(calls.rendered.msg, 'home.invalidLink');
    assertEq(ctx.sessionStorage.getItem('smartist_token'), null);
  });

  await test('the handover failing on the network → login form, no crash', async () => {
    const { ctx, calls } = oauthArrival(handoverOk, null);
    ctx.fetch = async () => { throw new Error('offline'); };
    await vm.runInContext('init()', ctx);
    assertEq(calls.rendered.msg, 'home.invalidLink');
  });

  console.log(B('\nafter sign-in: next= stays on this site'));
  for (const [next, want] of [
    ['/band/dashboard', '/band/dashboard'],
    ['/workspaces?x=1', '/workspaces?x=1'],
    ['/\\evil.example', ''],
    ['//evil.example', ''],
    ['/\t/evil.example', ''],
    ['https://evil.example/x', ''],
    ['javascript:alert(1)', ''],
    ['/.//evil.example', ''],
    ['/x/..//evil.example', ''],
    ['https://app.example//evil.example', ''],
  ]) {
    await test(`next=${JSON.stringify(next)} → ${JSON.stringify(want)}`, async () => {
      const ctx = makeContext(async () => ({ ok: false }));
      ctx.window = { location: { origin: 'https://app.example' } };
      assertEq(vm.runInContext(`_safeNext(${JSON.stringify(next)})`, ctx), want);
    });
  }

  console.log(`\n${B('─'.repeat(40))}`);
  console.log(`${G(`${passed} passed`)}  ${failed ? R(`${failed} failed`) : D('0 failed')}`);
  if (failures.length) {
    console.log(R('\nFailed:'));
    failures.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.error}`));
  }
  assert(passed + failed > 0, 'no tests ran');
  process.exit(failed > 0 ? 1 : 0);
})();
