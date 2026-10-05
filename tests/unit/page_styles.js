// Dead CSS in page <style> blocks: every class a page's <style> defines must be
// used somewhere in the app's markup or scripts (HTML outside <style>, app/js).
// The sweep of app.css is a review step; this keeps the page blocks clean, where
// leftovers of removed views (the old song cards, say) are easy to miss.
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '../../app');
const JS_DIR = path.join(APP_DIR, 'js');

const STYLE_RE = /<style[^>]*>([\s\S]*?)<\/style>/g;

// Classes a script builds from a prefix cannot be found by name: the venue
// table's columns are 'col-' + field (venues.js).
const DYNAMIC_PREFIXES = ['col-'];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Class names in the selectors of a CSS text (declarations dropped first, so
// values such as 0.5rem or url(x.png) are not read as classes).
function selectorClasses(css) {
  const selectors = stripComments(css).replace(/\{[^{}]*\}/g, ',');
  const out = new Set();
  for (const m of selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
  return out;
}

function usageText() {
  const parts = [];
  for (const f of fs.readdirSync(APP_DIR).filter(f => f.endsWith('.html'))) {
    parts.push(fs.readFileSync(path.join(APP_DIR, f), 'utf8').replace(STYLE_RE, ''));
  }
  for (const f of fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'))) {
    parts.push(fs.readFileSync(path.join(JS_DIR, f), 'utf8'));
  }
  return parts.join('\n');
}

function run(r) {
  const { test, assert, B } = r;
  console.log(B('\npage <style> blocks: no unused classes'));
  const used = usageText();
  const isUsed = cls => new RegExp('(^|[^\\w-])' + cls.replace(/[-]/g, '\\-') + '($|[^\\w-])').test(used) ||
    DYNAMIC_PREFIXES.some(p => cls.startsWith(p));

  for (const f of fs.readdirSync(APP_DIR).filter(f => f.endsWith('.html')).sort()) {
    const html = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
    const css = [...html.matchAll(STYLE_RE)].map(m => m[1]).join('\n');
    if (!css.trim()) continue;
    test(`${f}: every class in its <style> is used`, () => {
      const unused = [...selectorClasses(css)].filter(c => !isUsed(c));
      assert(unused.length === 0, `unused: ${unused.join(', ')}`);
    });
  }
}

module.exports = run;
