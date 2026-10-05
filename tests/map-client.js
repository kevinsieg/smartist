#!/usr/bin/env node
// map.js marker layer. Two things this pins down:
//   1. ~1800 pins are clustered when the plugin is there, and the map still works without it.
//   2. The layer must expose getBounds(): L.layerGroup() does not (only featureGroup and
//      markerClusterGroup do), and the fit-to-venues call sat inside a .catch, so the map
//      silently never zoomed to the venues.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'app/js/map.js'), 'utf8');

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ${G('✓')} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${R('✗')} ${name}`);
    console.log(`      ${R(e.message)}`);
    failures.push({ name, error: e.message });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in app/js/map.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Minimal Leaflet stand-ins that record which constructor was used.
function makeLeaflet({ withCluster }) {
  const made = [];
  const layer = kind => ({ kind, getBounds: () => ({ isValid: () => true, pad: () => 'bounds' }) });
  const L = {
    featureGroup: () => { made.push('featureGroup'); return layer('featureGroup'); },
    layerGroup:   () => { made.push('layerGroup');   return layer('layerGroup'); },
  };
  if (withCluster) L.markerClusterGroup = opts => { made.push('markerClusterGroup'); return { ...layer('cluster'), opts }; };
  return { L, made };
}

function loadMakeLayer(withCluster) {
  const { L, made } = makeLeaflet({ withCluster });
  const ctx = { console, window: { L }, L };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(SRC, '_makeMarkerLayer')}\nthis.fn = _makeMarkerLayer;`, ctx);
  return { make: ctx.fn, made };
}

(async () => {
  console.log(B('\nmap: marker layer'));

  test('uses clustering when the plugin is loaded', () => {
    const { make, made } = loadMakeLayer(true);
    const l = make();
    assert(made.includes('markerClusterGroup'), `expected a cluster group, got ${made.join(',')}`);
    assert(l.opts.chunkedLoading === true, 'chunkedLoading keeps ~1800 markers from freezing the page');
  });

  test('falls back to a feature group without the plugin', () => {
    const { make, made } = loadMakeLayer(false);
    make();
    assert(made.includes('featureGroup'), `expected featureGroup, got ${made.join(',')}`);
  });

  test('never uses layerGroup — it has no getBounds()', () => {
    for (const withCluster of [true, false]) {
      const { make, made } = loadMakeLayer(withCluster);
      make();
      assert(!made.includes('layerGroup'), 'layerGroup has no getBounds(), the map cannot fit its venues');
    }
  });

  test('whatever it returns exposes getBounds()', () => {
    for (const withCluster of [true, false]) {
      const { make } = loadMakeLayer(withCluster);
      assert(typeof make().getBounds === 'function', 'layer must support getBounds()');
    }
  });

  test('the map asks the API only for venues it can place', () => {
    assert(/lat IS NOT NULL AND lng IS NOT NULL/.test(
      fs.readFileSync(path.join(REPO_ROOT, 'api/_band/venues.js'), 'utf8')),
      'the ?all= payload should skip venues without coordinates');
  });

  // CARTO's basemaps started answering keyless requests with an
  // "API KEY REQUIRED" image; the map stays on OSM's free tiles.
  test('tiles come from OpenStreetMap, not a provider that needs a key', () => {
    const urls = SRC.match(/L\.tileLayer\('([^']+)'/g) || [];
    assert(urls.length > 0, 'no tile layer found');
    for (const u of urls) assert(u.includes('https://tile.openstreetmap.org/'), `unexpected tile source: ${u}`);
  });

  const total = passed + failed;
  console.log(`\n${B('─'.repeat(40))}`);
  console.log(`${G(`${passed} passed`)}  ${failed ? R(`${failed} failed`) : D('0 failed')}`);
  if (failures.length) {
    console.log(R('\nFailed:'));
    failures.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.error}`));
  }
  assert(total > 0, 'no tests ran');
  process.exit(failed > 0 ? 1 : 0);
})();
