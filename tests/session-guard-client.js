#!/usr/bin/env node
// Client-side tests for what session.js takes from the address bar and where
// apiFetch sends the session token.
//
// The first path segment used to be the workspace slug whatever it held, and
// shell.js built it into a data-onclick argument: a link to
// /x');apiFetch(this.ownerDocument.referrer);… ran apiFetch, which attached
// the bearer token to a request to the linking site. Now the segment counts as
// a slug only in the slug format, and apiFetch talks to this site's API only.

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../app/js/session.js'), 'utf8');

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ${G('✓')} ${name}`); passed++; }
  catch (e) { console.log(`  ${R('✗')} ${name}\n      ${R(e.message)}`); failed++; }
}
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function storage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

function load(pathname) {
  const fetched = [];
  const location = new URL('https://app.example' + pathname);
  const ctx = {
    URL, URLSearchParams, console, setTimeout, clearTimeout, Promise, JSON,
    location, sessionStorage: storage(), localStorage: storage(),
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null },
    fetch: async (url, opts) => { fetched.push({ url, opts }); return { ok: true, status: 200, json: async () => ({}) }; },
  };
  ctx.window = ctx;
  ctx.sessionStorage.setItem('smartist_token', 'TOKEN');
  vm.createContext(ctx);
  vm.runInContext(SRC + '\n;this.__slug = _artistSlug; this.__apiFetch = apiFetch;', ctx);
  return { slug: ctx.__slug, apiFetch: ctx.__apiFetch, fetched };
}

(async () => {
  console.log(B('\nworkspace slug from the path'));
  await test('a slug-shaped segment is the workspace', async () => assertEq(load('/my-band/songs').slug, 'my-band'));
  await test('a global page is no workspace', async () => assertEq(load('/profile').slug, ''));
  await test('markup in the segment is no workspace', async () =>
    assertEq(load("/x');apiFetch(this.ownerDocument.referrer);clickById('/contact").slug, ''));
  await test('short and underscore slugs from setup are workspaces', async () => {
    assertEq(load('/ci/songs').slug, 'ci');
    assertEq(load('/my_band/songs').slug, 'my_band');
  });
  await test('upper case or symbols are no workspace', async () => {
    assertEq(load('/My-Band/songs').slug, '');
    assertEq(load('/a.b/songs').slug, '');
  });

  console.log(B('\napiFetch'));
  await test('sends the token to this site\'s API', async () => {
    const s = load('/my-band/songs');
    await s.apiFetch('/api/my-band/songs');
    assertEq(s.fetched.length, 1);
    assertEq(s.fetched[0].opts.headers.Authorization, 'Bearer TOKEN');
  });
  for (const url of ['https://evil.example/collect', '//evil.example/x', '/my-band/songs', 'https://app.example/login']) {
    await test(`refuses ${url}, nothing sent`, async () => {
      const s = load('/my-band/songs');
      let threw = false;
      try { await s.apiFetch(url); } catch { threw = true; }
      assertEq(threw, true, 'must throw');
      assertEq(s.fetched.length, 0, 'nothing fetched');
    });
  }

  console.log(B('\nsheet frames (songs-media.js)'));
  const media = fs.readFileSync(path.join(__dirname, '../app/js/songs-media.js'), 'utf8');
  const start = media.indexOf('var _EMBED_SANDBOX');
  const end = media.indexOf('function toEmbedUrl');
  const frameCtx = { _mediaBase: 'https://media.example', escHtml: x => x, safeUrl: x => x };
  vm.createContext(frameCtx);
  vm.runInContext(media.slice(start, end) + ';this.__frame = _sheetFrame;', frameCtx);
  const sandboxed = u => frameCtx.__frame(u).includes('sandbox=');
  await test('an uploaded sheet in our bucket is framed without a sandbox', async () =>
    assertEq(sandboxed('https://media.example/sheets/7/uuid-chart.pdf'), false));
  for (const u of ['https://evil.example/login#.pdf', 'https://evil.example/login?x.pdf', 'https://evil.example/chart.pdf',
                   'https://media.example.evil.example/sheets/7/x.pdf', 'https://media.example/audio/7/x.pdf'])
    await test(`anything else is sandboxed: ${u}`, async () => assertEq(sandboxed(u), true));

  console.log(`\n${passed} passed  ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
