'use strict';
// SPA navigation (navigate() in shell.js) re-inserts a page's <body> scripts and
// runs them again in the SAME document. Top-level const/let live in the shared
// global lexical scope, so a second execution throws "Identifier ... has already
// been declared" and the whole file aborts before init() runs — the page silently
// fails to load until a hard refresh. Re-declaring var is harmless.
const fs   = require('fs');
const path = require('path');

const APP = path.join(__dirname, '../../app');

// The shared scripts every app page loads (core, session, ui, shell); stage.html
// loads core only. SPA navigation keeps them and re-runs everything else.
const SHARED = ['core', 'session', 'ui', 'shell'];

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

  // Only pages that load shell.js are SPA-navigated; standalone pages
  // (stage, admin) always arrive in a fresh document.
  const spaScripts = new Set();
  fs.readdirSync(APP).filter(f => f.endsWith('.html')).forEach(function(page) {
    const names = bodyScriptNames(fs.readFileSync(path.join(APP, page), 'utf8'));
    if (!names.includes('shell')) return;
    names.filter(n => !SHARED.includes(n)).forEach(n => spaScripts.add(n));
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
        // stage.js and arrangement.js run without session.js and add the header themselves
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
    // login/bootstrap pages read both stores on purpose; stage.js loads no session.js.
    // Scripts on pages that load no session.js: getToken() does not exist there,
    // so they read both stores themselves. See the standalone-pages test below.
    const ALLOWED = new Set(['session.js', 'shell.js', 'home.js', 'onboarding.js', 'stage.js', 'share-utils.js', 'arrangement.js', 'workspaces.js']);
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

  // Dates must look the same in every corner of the app: core.js formatDate/formatTime
  // own the formatting, stage included (it loads core.js).
  test('no page script formats dates on its own', () => {
    const ALLOWED = new Set(['core.js']);
    const offenders = [];
    fs.readdirSync(path.join(APP, 'js')).filter(f => f.endsWith('.js') && !ALLOWED.has(f)).forEach(function(file) {
      fs.readFileSync(path.join(APP, 'js', file), 'utf8').split('\n').forEach(function(line, i) {
        if (/toLocaleDateString|toLocaleTimeString/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    });
    assert(offenders.length === 0,
      'use formatDate()/formatTime() from core.js:\n      ' + offenders.join('\n      '));
  });


  // A page that does not load the shared scripts cannot call their functions. When
  // the auth-token sweep moved 16 sessionStorage reads onto getToken(), it also
  // moved workspaces.js — which runs standalone, because there is no band yet to
  // build a nav from. The call threw ReferenceError and the page rendered
  // nothing at all. Such scripts keep a guarded local copy, the way
  // share-utils.js and arrangement.js do on stage.
  //
  // A page is judged as a whole: the function may come from any script it
  // loads (stage.js defines its own escHtml, which arrangement.js then uses).
  test('standalone pages do not call shared-script functions they do not load', () => {
    const stripComments = src => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

    const definedIn = src => {
      const names = new Set();
      const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) names.add(m[1]);
      return names;
    };

    const commonFns = new Set(SHARED.flatMap(n =>
      [...definedIn(stripComments(fs.readFileSync(path.join(APP, 'js', n + '.js'), 'utf8')))]));

    const scriptsOf = html => {
      const out = [];
      const re = /<script[^>]+src="\/app\/js\/([A-Za-z0-9_/-]+)\.js/g;
      let m;
      while ((m = re.exec(html)) !== null) out.push(m[1]);
      return out;
    };

    const offenders = [];
    fs.readdirSync(APP).filter(f => f.endsWith('.html')).forEach(htmlName => {
      const scripts = scriptsOf(fs.readFileSync(path.join(APP, htmlName), 'utf8'));
      if (SHARED.every(n => scripts.includes(n))) return;

      const sources = scripts
        .map(n => ({ name: n, file: path.join(APP, 'js', n + '.js') }))
        .filter(x => fs.existsSync(x.file))
        .map(x => ({ name: x.name, src: stripComments(fs.readFileSync(x.file, 'utf8')) }));

      const available = new Set();
      sources.forEach(x => definedIn(x.src).forEach(n => available.add(n)));

      // arrangement.js is shared between the songs page (which has all the
      // shared scripts) and stage (core.js only). Its editing paths — the only callers of
      // apiFetch/setStatus — are unreachable on the read-only stage view, as its
      // own header states. Anything else it reaches for is a real bug.
      const KNOWN_UNREACHABLE = { 'arrangement': new Set(['apiFetch', 'setStatus']) };

      sources.forEach(({ name, src }) => {
        commonFns.forEach(fn => {
          if (available.has(fn)) return;
          if ((KNOWN_UNREACHABLE[name] || new Set()).has(fn)) return;
          if (new RegExp('(^|[^.\\w$])' + fn + '\\s*\\(', 'm').test(src)) {
            offenders.push(`${htmlName} → ${name}.js calls ${fn}()`);
          }
        });
      });
    });
    assert(offenders.length === 0,
      'these pages do not load the script that defines it, so the call throws:\n      ' +
      [...new Set(offenders)].join('\n      '));
  });

  // Pages that load shell.js get their i18n wait for free: initPage() awaits
  // window.i18n.ready before rendering. Pages without it must do that themselves.
  //
  // Skipping it only shows up on a COLD visit. i18n.js primes its dictionary
  // synchronously from localStorage, so on any repeat visit t() works and the
  // page looks fine — which is why this survived review. With an empty cache the
  // dictionary is still in flight when the script renders, t() returns the key
  // itself, and the visitor reads "signup.sendBtn". ready's applyTranslations()
  // does not repair it: that only touches elements carrying data-i18n, and
  // strings baked into generated HTML by t() carry nothing to re-translate.
  // A reload hides it. This hit the whole signup funnel.
  test('pages without shell.js await i18n.ready before calling t()', () => {
    const standalone = new Set();
    fs.readdirSync(APP).filter(f => f.endsWith('.html')).forEach(function(page) {
      const html  = fs.readFileSync(path.join(APP, page), 'utf8');
      if (!/js\/i18n\.js/.test(html)) return;          // English-only page
      const names = bodyScriptNames(html);
      if (names.includes('shell')) return;             // initPage() handles it
      names.forEach(n => standalone.add(n));
    });

    const offenders = [];
    standalone.forEach(function(name) {
      const file = path.join(APP, 'js', name + '.js');
      if (!fs.existsSync(file)) return;
      const src = fs.readFileSync(file, 'utf8');
      // Calls to t(…) that are not part of a longer identifier like format(...)
      if (!/(^|[^A-Za-z0-9_.$])t\s*\(/m.test(src)) return;
      if (/i18n\.ready/.test(src)) return;
      offenders.push(name + '.js');
    });

    assert(offenders.length === 0,
      'these render t() strings before the dictionary can arrive, so a cold\n' +
      '      visit shows raw keys until the visitor reloads:\n      ' +
      offenders.join('\n      '));
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
