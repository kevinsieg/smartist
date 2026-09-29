'use strict';

// Every data-on* handler in the app's markup and scripts, as written in the
// source, with its interpolations replaced by a placeholder — so the handler
// parser in core.js can check each one without a browser.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../..');
const APP = path.join(ROOT, 'app');

function appFiles() {
  return [
    ...fs.readdirSync(APP).filter(f => f.endsWith('.html')).map(f => path.join(APP, f)),
    ...fs.readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js')).map(f => path.join(APP, 'js', f)),
  ];
}

// '…' + expr + '…' and ${expr} become §; a JS-escaped \' becomes '. A § that
// stands for a whole call (heartButtonHtml's onclick) becomes f().
function normalise(value, isJs) {
  if (!isJs) return value.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return value
    .replace(/\$\{[^}]*\}/g, '§')
    .replace(/'\s*\+.*?\+\s*'/g, '§')
    .replace(/\\'/g, "'");
}

function fill(src) {
  return src.replace(/(^|;)\s*§\s*(?=;|$)/g, '$1f()').replace(/§/g, '1');
}

function handlers() {
  const out = [];
  for (const file of appFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const isJs = file.endsWith('.js');
    const rel = path.relative(ROOT, file);
    src.split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      for (const m of line.matchAll(/data-on([a-z]+)="([^"]*)"/g))
        out.push({ where: `${rel}:${i + 1}`, event: m[1], raw: m[2], src: fill(normalise(m[2], isJs)) });
      for (const m of line.matchAll(/setAttribute\('data-on([a-z]+)',\s*`([^`]*)`/g))
        out.push({ where: `${rel}:${i + 1}`, event: m[1], raw: m[2], src: fill(normalise(m[2], true)) });
    });
  }
  return out;
}

// core.js's parser, loaded without a document so it only defines functions.
function parser() {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(APP, 'js/core.js'), 'utf8'), ctx);
  return { parse: ctx._onParse, events: ctx._ON_EVENTS };
}

module.exports = { appFiles, handlers, parser, ROOT, APP };
