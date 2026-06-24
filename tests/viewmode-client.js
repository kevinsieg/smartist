#!/usr/bin/env node
// Client-side unit tests for view-mode gating of write actions on the
// gigs / venues / organizers list pages. In view mode (no/expired token) the
// list still loads via public GET, but every mutation 401s — so the per-row
// edit/erase buttons (and the edit-modal Delete button) must be omitted.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..');

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

// Evaluate a list-page script with stubbed globals. `ctx.__vm` toggles view
// mode and is read per-render by the isViewMode() stub.
function loadScript(relPath, columnsVar) {
  const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  const ctx = {
    console,
    __vm: false,
    initPage() {},                       // no-op: skip the document-heavy page boot
    isViewMode() { return ctx.__vm; },
    getToken() { return ctx.__vm ? null : 'tok'; },
    t(k) { return k; },
    escHtml(s) { return String(s == null ? '' : s); },
    document: { addEventListener() {}, getElementById() { return null; } },
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: relPath });
  const cols = ctx[columnsVar];
  const actions = cols.find(c => c.actions);
  assert(actions && typeof actions.render === 'function', `${columnsVar}: actions column not found`);
  return { ctx, actions };
}

(async () => {
  console.log(B('\nview-mode write-action gating'));

  // ── gigs ──────────────────────────────────────────────────────────────────
  {
    const { ctx, actions } = loadScript('app/js/gigs.js', 'GIG_COLUMNS');
    const deleted = { id: 7, deleted: true };
    const active  = { id: 8, deleted: false, date: '2099-01-01' };

    test('gigs authed: erase + edit buttons present', () => {
      ctx.__vm = false;
      assert(actions.render(deleted).includes('deleteGigFromPopup'), 'erase missing');
      assert(actions.render(active).includes('openEditModal'), 'edit missing');
    });
    test('gigs view mode: erase + edit hidden, badge kept', () => {
      ctx.__vm = true;
      const del = actions.render(deleted);
      assert(!del.includes('deleteGigFromPopup'), 'erase still present');
      assert(del.includes('gigs.deletedBadge'), 'deleted badge dropped');
      assert(!actions.render(active).includes('openEditModal'), 'edit still present');
    });
  }

  // ── venues ──────────────────────────────────────────────────────────────────
  {
    const { ctx, actions } = loadScript('app/js/venues.js', 'VENUE_COLUMNS');
    const active = { id: 5, deleted: false, category: 'club' };

    test('venues authed: edit button present', () => {
      ctx.__vm = false;
      assert(actions.render(active).includes('openEditModal'), 'edit missing');
    });
    test('venues view mode: edit button hidden', () => {
      ctx.__vm = true;
      assert(!actions.render(active).includes('openEditModal'), 'edit still present');
    });
  }

  // ── organizers ──────────────────────────────────────────────────────────────
  {
    const { ctx, actions } = loadScript('app/js/organizers.js', 'ORGANIZER_COLUMNS');
    const active = { id: 9, deleted: false };

    test('organizers authed: edit button present', () => {
      ctx.__vm = false;
      assert(actions.render(active).includes('openEditModal'), 'edit missing');
    });
    test('organizers view mode: edit button hidden', () => {
      ctx.__vm = true;
      assert(!actions.render(active).includes('openEditModal'), 'edit still present');
    });
  }

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
