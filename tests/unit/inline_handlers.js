'use strict';

// The CSP has no 'unsafe-inline' in script-src, so the browser refuses every
// onclick="…" attribute and every <script> without src — silently, except for
// a console line when someone clicks. These checks catch them before that:
// no inline handler or inline script anywhere in app/, and every data-on*
// handler is one the parser in core.js accepts, calling a function the app
// defines at top level.

const fs = require('fs');
const { makeRunner } = require('./_runner');
const { appFiles, handlers, parser } = require('./_handlers');

const INLINE_HANDLER = /(?<![\w.$-])on[a-z]+\s*=\s*["'\\]|setAttribute\(\s*['"]on[a-z]+['"]/;

function run(r) {
  const { test, assert, B } = r;
  console.log(B('\nhandlers in markup (no inline script)'));

  const files = appFiles().map(f => ({ f, src: fs.readFileSync(f, 'utf8') }));
  const { parse, events } = parser();
  const all = handlers();
  const defs = files.map(x => x.src).join('\n');

  test('no inline event handler attribute in app/', () => {
    const hits = [];
    for (const { f, src } of files)
      src.split('\n').forEach((line, i) => { if (INLINE_HANDLER.test(line)) hits.push(`${f}:${i + 1}`); });
    assert(hits.length === 0, `inline handlers (use data-on…): ${hits.join(', ')}`);
  });

  test('no inline <script> block in app/ pages', () => {
    const hits = [];
    for (const { f, src } of files.filter(x => x.f.endsWith('.html')))
      for (const m of src.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g))
        if (!/\ssrc=/.test(m[1] || '') && m[2].trim()) hits.push(f);
    assert(hits.length === 0, `inline scripts (move to app/js): ${hits.join(', ')}`);
  });

  test('handlers were found at all', () => assert(all.length > 100, `only ${all.length} found`));

  test('every data-on* event is one core.js listens for', () => {
    const bad = all.filter(h => !events.includes(h.event));
    assert(bad.length === 0, bad.map(h => `${h.where} data-on${h.event}`).join(', '));
  });

  test('every data-on* handler parses', () => {
    const bad = [];
    for (const h of all) { try { parse(h.src); } catch (e) { bad.push(`${h.where} "${h.raw}": ${e.message}`); } }
    assert(bad.length === 0, bad.join('\n      '));
  });

  test('every function a handler calls is defined at top level', () => {
    const names = new Set();
    for (const h of all) for (const s of parse(h.src)) if (s.call && s.call[0] !== 'event') names.add(s.call[0]);
    names.delete('f');   // the placeholder for a call passed in as a string
    const esc = n => n.replace(/\$/g, '\\$');
    const missing = [...names].filter(n => !new RegExp(
      `^(async\\s+)?function\\s+${esc(n)}\\s*\\(|^var\\s+${esc(n)}\\s*=|window\\.${esc(n)}\\s*=`, 'm').test(defs));
    assert(missing.length === 0, `not defined globally: ${missing.join(', ')}`);
  });

  test('the parser refuses anything but calls to named functions', () => {
    for (const src of ['location.assign(1)', 'f(g(1))', 'f(1+2)', 'this.remove()', 'a=1', 'f(window.x)'])
      assert((() => { try { parse(src); return false; } catch { return true; } })(), `accepted: ${src}`);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
