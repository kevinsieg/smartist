'use strict';
// Deciding what deleting an account would destroy. The fixture always contains
// a second band in the same database, because that is the failure that cannot
// be undone: smartist-shared holds both bandone and bandtwo.
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
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
module.exports = run;
