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
  console.log(B('\ncollectR2Urls'));

  function fakeMediaSql({ songs = [], gigs = [], artists = [] }) {
    return (strings, ...values) => {
      const text = strings.join('?');
      const ids  = values[0] || [];
      if (/FROM songs/i.test(text))   return Promise.resolve(songs.filter(s => ids.includes(s.artist_id)));
      if (/FROM gigs/i.test(text))    return Promise.resolve(gigs.filter(g => ids.includes(g.artist_id)));
      if (/FROM artists/i.test(text)) return Promise.resolve(artists.filter(a => ids.includes(a.id)));
      return Promise.resolve([]);
    };
  }

  // Soft-deleted songs still have their files sitting in the bucket.
  await testAsync('a deleted song still yields its files', async () => {
    const { collectR2Urls } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = fakeMediaSql({ songs: [
      { artist_id: 1, extra: { listenUrl: 'https://r2/audio/a.mp3' }, deleted: true },
    ]});
    const urls = await collectR2Urls([1], sql);
    assertEq(urls.join(','), 'https://r2/audio/a.mp3');
  });

  await testAsync('songs, gigs and the band logo are all collected', async () => {
    const { collectR2Urls } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = fakeMediaSql({
      songs:   [{ artist_id: 1, extra: { listenUrl: 'u1', sheetUrl: 'u2', playbackUrl: 'u3' } }],
      gigs:    [{ artist_id: 1, poster_url: 'u4', thumb_url: 'u5' }],
      artists: [{ id: 1, config: { logoUrl: 'u6' } }],
    });
    const urls = await collectR2Urls([1], sql);
    assertEq([...urls].sort().join(','), 'u1,u2,u3,u4,u5,u6');
  });

  // The hazard this whole feature has to avoid: audio/ is one namespace shared
  // by every tenant, so a neighbour's file must never appear in this list.
  await testAsync('a neighbouring band\'s files are never collected', async () => {
    const { collectR2Urls } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = fakeMediaSql({
      songs: [
        { artist_id: 1, extra: { listenUrl: 'mine.mp3' } },
        { artist_id: 2, extra: { listenUrl: 'THEIRS.mp3' } },
      ],
      gigs:    [{ artist_id: 2, poster_url: 'THEIRS-poster.jpg' }],
      artists: [{ id: 2, config: { logoUrl: 'THEIRS-logo.png' } }],
    });
    const urls = await collectR2Urls([1], sql);
    assert(!urls.some(u => /THEIRS/.test(u)), `collected another band's files: ${urls.join(', ')}`);
    assertEq(urls.join(','), 'mine.mp3');
  });

  console.log(B('\nexecuteDeletion — and what it must leave alone'));

  // Records every statement so the tests can assert on scope. A deletion bug
  // shows up as a statement whose values do not name the victim's artist.
  function recordingSql(rows, media = {}) {
    const issued = [];
    const fn = (strings, ...values) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      issued.push({ text, values });
      if (/JOIN artists/i.test(text)) {
        const email = values[0];
        return Promise.resolve(rows.filter(r => r.email === email)
          .map(r => ({ artist_id: r.artist_id, slug: r.slug, name: r.name, role: r.role })));
      }
      if (/FROM users/i.test(text)) {
        const ids = values[0] || [];
        return Promise.resolve(rows.filter(r => ids.includes(r.artist_id)));
      }
      if (/FROM songs/i.test(text))   return Promise.resolve(media.songs   || []);
      if (/FROM gigs/i.test(text))    return Promise.resolve(media.gigs    || []);
      if (/FROM artists/i.test(text)) return Promise.resolve(media.artists || []);
      return Promise.resolve([]);
    };
    fn.begin = async (cb) => cb(fn);
    fn.issued = issued;
    return fn;
  }

  await testAsync('a blocked workspace stops the whole deletion', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql([
      { artist_id: 1, slug: 'solo', name: 'Solo', email: VICTIM,    role: 'admin'  },
      { artist_id: 2, slug: 'band', name: 'Band', email: VICTIM,    role: 'admin'  },
      { artist_id: 2, slug: 'band', name: 'Band', email: NEIGHBOUR, role: 'member' },
    ]);
    const removed = [];
    const out = await executeDeletion(VICTIM, sql, {
      deleteFromR2: async (u) => { removed.push(u); return true; },
      logger: { info: async () => {}, error: async () => {} },
    });
    assertEq(out.ok, false);
    assertEq(out.blocked.map(b => b.slug).join(','), 'band');
    // Nothing at all may have happened — not even the workspace that was fine.
    assert(!sql.issued.some(q => /DELETE|UPDATE/i.test(q.text)),
      'a blocked deletion still wrote: ' + sql.issued.map(q => q.text).join(' | '));
    assertEq(removed.length, 0);
  });

  await testAsync('every write names the artists being deleted', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql([
      { artist_id: 1, slug: 'mine',  name: 'Mine',  email: VICTIM,    role: 'admin' },
      { artist_id: 9, slug: 'other', name: 'Other', email: NEIGHBOUR, role: 'admin' },
    ]);
    await executeDeletion(VICTIM, sql, {
      deleteFromR2: async () => true,
      logger: { info: async () => {}, error: async () => {} },
    });
    const writes = sql.issued.filter(q => /^(DELETE|UPDATE)/i.test(q.text));
    assert(writes.length > 0, 'nothing was deleted');
    for (const w of writes) {
      const flat = JSON.stringify(w.values);
      assert(/\b1\b/.test(flat) || /player@example\.com/.test(flat),
        `a write did not name the victim: ${w.text} ${flat}`);
      assert(!/\b9\b/.test(flat),
        `a write named the neighbouring artist: ${w.text} ${flat}`);
    }
  });

  await testAsync('files are removed only after the rows are gone', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const order = [];
    const sql = recordingSql(
      [{ artist_id: 1, slug: 'mine', name: 'Mine', email: VICTIM, role: 'admin' }],
      { songs: [{ extra: { listenUrl: 'f1' } }] },
    );
    const inner = sql;
    inner.begin = async (cb) => { order.push('tx'); return cb(inner); };
    await executeDeletion(VICTIM, sql, {
      deleteFromR2: async (u) => { order.push('r2:' + u); return true; },
      logger: { info: async () => {}, error: async () => {} },
    });
    assertEq(order.join(','), 'tx,r2:f1');
  });

  await testAsync('a failed file delete does not undo the row deletion, and is logged', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql(
      [{ artist_id: 1, slug: 'mine', name: 'Mine', email: VICTIM, role: 'admin' }],
      { songs: [{ extra: { listenUrl: 'boom' } }] },
    );
    const logged = [];
    const out = await executeDeletion(VICTIM, sql, {
      deleteFromR2: async () => { throw new Error('r2 down'); },
      logger: { info: async () => {}, error: async (e, d) => { logged.push({ e, d }); } },
    });
    assertEq(out.ok, true);
    assert(logged.some(l => l.e === 'account_delete_file_orphaned'),
      'an orphaned file was not logged: ' + JSON.stringify(logged));
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
module.exports = run;
