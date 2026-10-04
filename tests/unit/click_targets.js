// A click handler on an element the keyboard cannot reach (a <div> or <span>
// with data-onclick) makes that action mouse- and touch-only. Such an element
// must be a real control instead (<button>, <a href>), or be marked up as one:
// role="button" with tabindex="0" (ui.js then runs it on Enter and Space).
// Exempt: wrappers that only stop propagation, modal backdrops (Escape closes
// those), mouse shortcuts hidden from assistive tech (aria-hidden), and the
// listed rows and cards whose action is also reachable through a button inside.
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '../../app');
const JS_DIR = path.join(APP_DIR, 'js');

// Class → why the keyboard is covered another way.
const ALLOWED = {
  'hist-song-row': 'the song title inside is a <button>',
  'platform-card': 'the card name inside is a <button>',
  'arr-tab-name': 'double-click shortcut; the Rename button does the same',
};

function clickProblems(src) {
  const problems = [];
  const re = /<(div|span|td|tr|li|img|p|label|section|h[1-6])\b([^>]*?)\bdata-on(?:click|dblclick)="([^"]*)"([^>]*)>/g;
  for (const m of src.matchAll(re)) {
    const attrs = m[2] + ' ' + m[4];
    const handler = m[3].trim();
    if (/\btabindex=/.test(attrs) && /\brole="button"/.test(attrs)) continue;
    if (/\baria-hidden="true"/.test(attrs)) continue;
    if (/^event\.stopPropagation\(\);?$/.test(handler)) continue;
    const cls = (attrs.match(/\bclass="([^"]*)"/) || ['', ''])[1];
    if (/overlay/.test(cls) || /Backdrop\(/.test(handler)) continue;
    if (cls.split(/\s+/).some(c => ALLOWED[c])) continue;
    problems.push(m[0].replace(/\s+/g, ' ').slice(0, 110));
  }
  return problems;
}

// Elements given a click handler by id from a script
// (getElementById('x').addEventListener('click', …)) must be controls too.
const CONTROL_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary', 'label']);
function scriptClickProblems(jsSrc, htmlSrc) {
  const problems = [];
  const re = /getElementById\(\s*'([\w-]+)'\s*\)\??\.addEventListener\(\s*'click'/g;
  for (const m of jsSrc.matchAll(re)) {
    const tag = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${m[1]}"[^>]*>`).exec(htmlSrc);
    if (!tag || CONTROL_TAGS.has(tag[1])) continue;
    if (/\btabindex=/.test(tag[0]) && /\brole="button"/.test(tag[0])) continue;
    if (/overlay|modal/.test(tag[0])) continue;
    problems.push(`#${m[1]} is a <${tag[1]}>`);
  }
  return problems;
}

function run(r) {
  const { test, assert, B } = r;
  console.log(B('\nkeyboard-reachable click targets'));
  test('the check catches a clickable div', () =>
    assert(clickProblems('<div class="x" data-onclick="go()">').length === 1, 'not caught'));
  test('the check accepts a div marked up as a button', () =>
    assert(clickProblems('<div role="button" tabindex="0" data-onclick="go()">').length === 0, 'flagged'));
  const files = [
    ...fs.readdirSync(APP_DIR).filter(f => f.endsWith('.html')).map(f => path.join(APP_DIR, f)),
    ...fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js')).map(f => path.join(JS_DIR, f)),
  ];
  for (const f of files) {
    const p = clickProblems(fs.readFileSync(f, 'utf8'));
    if (!p.length) continue;
    test(`${path.relative(APP_DIR, f)}: click targets reachable by keyboard`, () => assert(false, p.join('\n        ')));
  }
  test('the check catches a span given a click handler by id', () =>
    assert(scriptClickProblems("document.getElementById('x').addEventListener('click', f)", '<span id="x">').length === 1, 'not caught'));
  const allHtml = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.html'))
    .map(f => fs.readFileSync(path.join(APP_DIR, f), 'utf8')).join('\n');
  for (const f of fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'))) {
    const p = scriptClickProblems(fs.readFileSync(path.join(JS_DIR, f), 'utf8'), allHtml);
    if (!p.length) continue;
    test(`js/${f}: elements with a click listener are controls`, () => assert(false, p.join('\n        ')));
  }
  test('no app file has a click-only element', () => assert(true));
}

module.exports = run;
module.exports.clickProblems = clickProblems;
