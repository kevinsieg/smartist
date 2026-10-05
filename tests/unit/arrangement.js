// Unit tests for arrangement helper logic (pure functions only).
function run(r) {
  const { test, assertEq, assert } = r;

  console.log('\narrangement helpers');

  // _arrHarmDisplay: converts member name array → abbreviation string
  function _arrHarmDisplay(harmony, members) {
    if (!harmony || !harmony.length) return '';
    const abbrMap = {};
    (members || []).forEach(m => { abbrMap[m.name] = m.abbr; });
    return harmony.map(name => abbrMap[name] || name).join('+');
  }

  test('_arrHarmDisplay: empty → empty string', () => assertEq(_arrHarmDisplay([], []), ''));
  test('_arrHarmDisplay: maps names to abbrs', () => {
    const members = [{ name: 'Sam', abbr: 'S' }, { name: 'Robin', abbr: 'R' }];
    assertEq(_arrHarmDisplay(['Sam', 'Robin'], members), 'S+R');
  });
  test('_arrHarmDisplay: falls back to name if no abbr', () => {
    assertEq(_arrHarmDisplay(['Unknown'], []), 'Unknown');
  });

  // _arrVisibleInstruments: config instruments minus hidden, plus orphan keys from rows
  function _arrVisibleInstruments(configInstruments, hiddenInstruments, rows) {
    const hidden = new Set(hiddenInstruments || []);
    const visible = (configInstruments || [])
      .filter(inst => !hidden.has(inst.key))
      .map(inst => ({ key: inst.key, label: inst.label || inst.key, orphan: false }));
    const configKeys = new Set((configInstruments || []).map(i => i.key));
    const orphanKeys = new Set();
    (rows || []).forEach(row => {
      Object.keys(row.parts || {}).forEach(k => {
        if (!configKeys.has(k) && !hidden.has(k)) orphanKeys.add(k);
      });
    });
    orphanKeys.forEach(k => visible.push({ key: k, label: k, orphan: true }));
    return visible;
  }

  test('_arrVisibleInstruments: returns all when nothing hidden', () => {
    const cfg = [{ key: 'BANJO', label: 'Banjo' }, { key: 'MANDO', label: 'Mando' }];
    const v = _arrVisibleInstruments(cfg, [], []);
    assertEq(v.length, 2);
    assertEq(v[0].key, 'BANJO');
  });
  test('_arrVisibleInstruments: excludes hidden', () => {
    const cfg = [{ key: 'BANJO', label: 'Banjo' }, { key: 'MANDO', label: 'Mando' }];
    const v = _arrVisibleInstruments(cfg, ['BANJO'], []);
    assertEq(v.length, 1);
    assertEq(v[0].key, 'MANDO');
  });
  test('_arrVisibleInstruments: includes orphan keys from rows', () => {
    const cfg = [{ key: 'BANJO', label: 'Banjo' }];
    const rows = [{ parts: { BANJO: 'ROLL', VIOLIN: 'SOLO' } }];
    const v = _arrVisibleInstruments(cfg, [], rows);
    assertEq(v.length, 2);
    assert(v.find(x => x.key === 'VIOLIN' && x.orphan), 'VIOLIN should be orphan');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r);
  process.exit(r.summary() > 0 ? 1 : 0);
}

module.exports = run;
