'use strict';
// Deciding what deleting an account would destroy. The fixture always contains
// a second band in the same database, because that is the failure that cannot
// be undone: smartist-kevin holds both salb and klang.
const path = require('path');
const { stubLogger } = require('./_runner');
stubLogger();

const VICTIM    = 'player@example.com';
const NEIGHBOUR = 'other@example.com';

// rows: [{ artist_id, slug, name, email, role }]
function fakeSql(rows) {
  return (strings, ...values) => {
    const text = strings.join('?');
    if (/FROM users u\s+JOIN artists a/i.test(text) || /JOIN artists/i.test(text)) {
      const email = values[0];
      return Promise.resolve(rows.filter(r => r.email === email)
        .map(r => ({ artist_id: r.artist_id, slug: r.slug, name: r.name, role: r.role })));
    }
    if (/FROM users/i.test(text)) {
      const artistIds = values[0];
      return Promise.resolve(rows.filter(r => artistIds.includes(r.artist_id)));
    }
    return Promise.resolve([]);
  };
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;
  const { planDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));

  console.log(B('\nplanDeletion'));

  await testAsync('a workspace with no one else in it is destroyed', async () => {
    const sql = fakeSql([
      { artist_id: 1, slug: 'mine',  name: 'Mine',  email: VICTIM,    role: 'admin' },
      { artist_id: 2, slug: 'other', name: 'Other', email: NEIGHBOUR, role: 'admin' },
    ]);
    const p = await planDeletion(VICTIM, sql);
    assertEq(p.destroy.map(a => a.slug).join(','), 'mine');
    assertEq(p.leave.length, 0);
    assertEq(p.blocked.length, 0);
  });

  await testAsync('a workspace with other members and another admin is only left', async () => {
    const sql = fakeSql([
      { artist_id: 1, slug: 'band', name: 'Band', email: VICTIM,    role: 'admin' },
      { artist_id: 1, slug: 'band', name: 'Band', email: NEIGHBOUR, role: 'admin' },
    ]);
    const p = await planDeletion(VICTIM, sql);
    assertEq(p.leave.map(a => a.slug).join(','), 'band');
    assertEq(p.destroy.length, 0);
    assertEq(p.blocked.length, 0);
  });

  await testAsync('sole admin with other members blocks', async () => {
    const sql = fakeSql([
      { artist_id: 1, slug: 'band', name: 'Band', email: VICTIM,    role: 'admin'  },
      { artist_id: 1, slug: 'band', name: 'Band', email: NEIGHBOUR, role: 'member' },
    ]);
    const p = await planDeletion(VICTIM, sql);
    assertEq(p.blocked.map(a => a.slug).join(','), 'band');
    assertEq(p.destroy.length, 0);
  });

  // The lookup is by exact address. kev@x.com must never take kevin@x.com.
  await testAsync('a similar address is not swept in', async () => {
    const sql = fakeSql([
      { artist_id: 1, slug: 'mine', name: 'Mine', email: 'kevin@x.com', role: 'admin' },
      { artist_id: 2, slug: 'thrs', name: 'Thrs', email: 'kev@x.com',   role: 'admin' },
    ]);
    const p = await planDeletion('kev@x.com', sql);
    assertEq(p.destroy.map(a => a.slug).join(','), 'thrs');
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
module.exports = run;
