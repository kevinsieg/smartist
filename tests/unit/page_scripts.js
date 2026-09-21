'use strict';
// SPA navigation (navigate() in common.js) re-inserts a page's <body> scripts and
// runs them again in the SAME document. Top-level const/let live in the shared
// global lexical scope, so a second execution throws "Identifier ... has already
// been declared" and the whole file aborts before init() runs — the page silently
// fails to load until a hard refresh. Re-declaring var is harmless.
const fs   = require('fs');
const path = require('path');

const APP = path.join(__dirname, '../../app');

function bodyScriptNames(html) {
  const bodyStart = html.indexOf('<body');
  const body = bodyStart === -1 ? html : html.slice(bodyStart);
  const names = [];
  const re = /<script[^>]+src="\/app\/js\/([A-Za-z0-9_-]+)\.js/g;
  let m;
  while ((m = re.exec(body)) !== null) names.push(m[1]);
  return names;
}

function run(r) {
  const { test, assert, B } = r;

  console.log(B('\nSPA page scripts'));

  // Only pages that load common.js are SPA-navigated; standalone pages
  // (stage, admin) always arrive in a fresh document.
  const spaScripts = new Set();
  fs.readdirSync(APP).filter(f => f.endsWith('.html')).forEach(function(page) {
    const names = bodyScriptNames(fs.readFileSync(path.join(APP, page), 'utf8'));
    if (!names.includes('common')) return;
    names.filter(n => n !== 'common').forEach(n => spaScripts.add(n));
  });

  test('finds the SPA page scripts', () => {
    assert(spaScripts.size > 0, 'no SPA page scripts found — selector is wrong');
  });

  // A private workspace 401s every data endpoint, so page scripts must send the token.
  // Plain fetch() here made the songs panel claim "not in any setlist" while the song
  // had 71 of them. apiFetch adds the token when there is one and is harmless without.
  test('workspace data endpoints are called through apiFetch', () => {
    // Endpoints that answer without a session by design: login, password reset,
    // OAuth start, the public config payload, the contact form.
    const PUBLIC = /\/auth\b|request-reset|accept-invite|\/api\/config/;
    const offenders = [];
    fs.readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js')).forEach(function(file) {
      const src = fs.readFileSync(path.join(APP, 'js', file), 'utf8');
      const re = /(?<![A-Za-z])fetch\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        let depth = 0, end = m.index;
        for (let i = src.indexOf('(', m.index); i < src.length; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')' && --depth === 0) { end = i; break; }
        }
        const call = src.slice(m.index, end + 1);
        if (!/\/api\//.test(call)) continue;
        if (PUBLIC.test(call)) continue;
        // stage.js and arrangement.js run without common.js and add the header themselves
        if (/Authorization|_authHeaders|_stageAuthHeaders|_arrAuthHeaders/.test(call)) continue;
        offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}  ${call.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
    });
    assert(offenders.length === 0,
      'these calls send no token and fail in a private workspace:\n      ' + offenders.join('\n      '));
  });

  // "Remember me" stores the token in localStorage only (home.js storeToken clears the
  // session copy), so reading sessionStorage directly finds nothing and the action fails
  // silently — this is what made bulk save do nothing at all.
  test('page scripts read the token through getToken()', () => {
    // login/bootstrap pages read both stores on purpose; stage.js loads no common.js.
    const ALLOWED = new Set(['common.js', 'home.js', 'onboarding.js', 'stage.js', 'share-utils.js', 'arrangement.js']);
    const offenders = [];
    fs.readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js') && !ALLOWED.has(f)).forEach(function(file) {
      fs.readFileSync(path.join(APP, 'js', file), 'utf8').split('\n').forEach(function(line, i) {
        if (/sessionStorage\.(get|remove)Item\(\s*AUTH_TOKEN_KEY/.test(line) && !/localStorage/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    });
    assert(offenders.length === 0,
      'use getToken()/clearToken() — remember-me keeps the token in localStorage:\n      ' + offenders.join('\n      '));
  });

  // Dates must look the same in every corner of the app: common.js formatDate/formatTime
  // own the formatting (stage.js keeps a documented copy — it loads no common.js).
  test('no page script formats dates on its own', () => {
    const ALLOWED = new Set(['common.js', 'stage.js']);
    const offenders = [];
    fs.readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js') && !ALLOWED.has(f)).forEach(function(file) {
      fs.readFileSync(path.join(APP, 'js', file), 'utf8').split('\n').forEach(function(line, i) {
        if (/toLocaleDateString|toLocaleTimeString/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    });
    assert(offenders.length === 0,
      'use formatDate()/formatTime() from common.js:\n      ' + offenders.join('\n      '));
  });

  spaScripts.forEach(function(name) {
    test(name + '.js declares no top-level const/let', () => {
      const file = path.join(APP, 'js', name + '.js');
      // Only column-0 declarations are global; indented ones are function-scoped.
      const offenders = fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /^(const|let)\s/.test(line))
        .map(({ line, n }) => `${name}.js:${n}  ${line.trim().slice(0, 70)}`);
      assert(offenders.length === 0,
        'top-level const/let breaks SPA re-execution:\n      ' + offenders.join('\n      '));
    });
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
