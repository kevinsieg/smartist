'use strict';
// Deciding what deleting an account would destroy. The fixture always contains
// a second band in the same database, because that is the failure that cannot
// be undone: one database can hold several bands.
const path = require('path');
const { stubLogger } = require('./_runner');
stubLogger();

const VICTIM    = 'player@example.com';
const NEIGHBOUR = 'other@example.com';

// Mirrors real Postgres: an exact-string column compares case-sensitively
// unless the SQL text itself wraps the column in lower(...). This is what
// catches an implementation that forgets the lower() and silently matches
// nothing for a mixed-case stored address.
function emailMatches(queryText, rowEmail, paramValue) {
  return /lower\s*\(/i.test(queryText) ? rowEmail.toLowerCase() === paramValue : rowEmail === paramValue;
}

// rows: [{ artist_id, slug, name, email, role }]
function fakeSql(rows) {
  return (strings, ...values) => {
    const text = strings.join('?');
    if (/JOIN artists/i.test(text)) {
      const email = values[0];
      return Promise.resolve(rows.filter(r => emailMatches(text, r.email, email))
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

  // oauth.js and registration.js insert whatever the provider/form sent, not
  // a lowercased address — the lookup must fold case or this address is
  // simply never found, and executeDeletion would report success for a
  // no-op (see the "not found" tests below).
  await testAsync('a mixed-case stored address is still matched', async () => {
    const sql = fakeSql([
      { artist_id: 1, slug: 'mine', name: 'Mine', email: 'Jane@EXAMPLE.com', role: 'admin' },
    ]);
    const p = await planDeletion('jane@example.com', sql);
    assertEq(p.destroy.map(a => a.slug).join(','), 'mine');
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

  // config.js also uploads a band favicon (config.faviconUrl) alongside the
  // logo. Unlike the UUID-keyed song files, its R2 key is slug-derived and
  // therefore guessable — leaving it behind after deletion is a real gap.
  await testAsync('the band favicon is collected alongside the logo', async () => {
    const { collectR2Urls } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = fakeMediaSql({
      artists: [{ id: 1, config: { logoUrl: 'logo.png', faviconUrl: 'fav.png' } }],
    });
    const urls = await collectR2Urls([1], sql);
    assertEq([...urls].sort().join(','), 'fav.png,logo.png');
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
  // `subs` tracks a fake subscribers table so tests can assert a neighbour's
  // row survives a DELETE FROM subscribers, not just that one was issued.
  function recordingSql(rows, media = {}, subs = []) {
    let subscribers = subs.slice();
    const issued = [];
    const fn = (strings, ...values) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      issued.push({ text, values });
      if (/JOIN artists/i.test(text)) {
        const email = values[0];
        return Promise.resolve(rows.filter(r => emailMatches(text, r.email, email))
          .map(r => ({ artist_id: r.artist_id, slug: r.slug, name: r.name, role: r.role })));
      }
      if (/SELECT artist_id, email, role FROM users/i.test(text)) {
        const ids = values[0] || [];
        return Promise.resolve(rows.filter(r => ids.includes(r.artist_id)));
      }
      if (/FROM songs/i.test(text))   return Promise.resolve(media.songs   || []);
      if (/FROM gigs/i.test(text))    return Promise.resolve(media.gigs    || []);
      if (/FROM artists/i.test(text)) return Promise.resolve(media.artists || []);
      if (/DELETE FROM subscribers/i.test(text)) {
        const addr = values[0];
        subscribers = subscribers.filter(s => !emailMatches(text, s.email, addr));
      }
      return Promise.resolve([]);
    };
    fn.begin = async (cb) => cb(fn);
    fn.issued = issued;
    Object.defineProperty(fn, 'subscribers', { get: () => subscribers });
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

  // Real assertion, not a presence test: every artist id in every write's
  // values must be one this deletion is allowed to touch, and every
  // email-shaped value must be exactly the victim's — not "contains the
  // digit 1" and "doesn't contain the digit 9", which a coincidental id
  // could satisfy or dodge by accident.
  await testAsync('every write is scoped to the artists being destroyed and the victim alone', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql([
      { artist_id: 1, slug: 'mine',  name: 'Mine',  email: VICTIM,    role: 'admin' },
      { artist_id: 9, slug: 'other', name: 'Other', email: NEIGHBOUR, role: 'admin' },
    ]);
    await executeDeletion(VICTIM, sql, {
      deleteFromR2: async () => true,
      logger: { info: async () => {}, error: async () => {} },
    });
    const destroySet = new Set([1]); // artist 1 is VICTIM's only workspace and it's solo
    const writes = sql.issued.filter(q => /^(DELETE|UPDATE)/i.test(q.text));
    assert(writes.length > 0, 'nothing was deleted');
    for (const w of writes) {
      for (const v of w.values) {
        if (Array.isArray(v)) {
          for (const id of v) assert(destroySet.has(id),
            `a write named an artist outside the destroy set: ${w.text} ${JSON.stringify(w.values)}`);
        } else if (typeof v === 'number') {
          assert(destroySet.has(v),
            `a write named an artist outside the destroy set: ${w.text} ${JSON.stringify(w.values)}`);
        } else if (typeof v === 'string' && v.includes('@')) {
          assertEq(v, VICTIM, `a write used the wrong email: ${w.text} ${JSON.stringify(w.values)}`);
        }
      }
    }
  });

  await testAsync('the file list is logged before the transaction, then files are removed only after the rows are gone', async () => {
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
      logger: {
        info: async (event) => { if (event === 'account_delete_files_pending') order.push('logged'); },
        error: async () => {},
      },
    });
    assertEq(order.join(','), 'logged,tx,r2:f1');
  });

  // Alice (admin) invites Bob into her band; Bob becomes admin too, so
  // deleting Alice's account only leaves that workspace (Bob stays). Bob's
  // users row has invited_by = Alice's user id, and that FK has no ON DELETE
  // clause — without clearing it first, deleting Alice's row throws
  // users_invited_by_fkey and nobody who ever invited a teammate could ever
  // delete their own account.
  await testAsync('invited_by is cleared before the inviting row is removed', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql([
      { artist_id: 1, slug: 'band', name: 'Band', email: VICTIM,    role: 'admin' },
      { artist_id: 1, slug: 'band', name: 'Band', email: NEIGHBOUR, role: 'admin' },
    ]);
    await executeDeletion(VICTIM, sql, {
      deleteFromR2: async () => true,
      logger: { info: async () => {}, error: async () => {} },
    });
    const texts          = sql.issued.map(q => q.text);
    const invitedByIdx   = texts.findIndex(t => /invited_by\s*=\s*NULL/i.test(t));
    const deleteUsersIdx = texts.findIndex(t => /^DELETE FROM users\b/i.test(t));
    assert(invitedByIdx !== -1, 'invited_by was never nulled: ' + texts.join(' | '));
    assert(deleteUsersIdx !== -1, "the victim's membership row was never deleted");
    assert(invitedByIdx < deleteUsersIdx,
      'invited_by must be cleared before the row it references is deleted');
  });

  // The DB stores whatever case a provider or the signup form sent — the
  // deletes must fold case the same way the lookup does, or a row that
  // planDeletion found is left behind by the write that's supposed to remove it.
  await testAsync('the row deletes match the stored email regardless of case', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql([
      { artist_id: 1, slug: 'mine', name: 'Mine', email: VICTIM, role: 'admin' },
    ]);
    await executeDeletion(VICTIM, sql, {
      deleteFromR2: async () => true,
      logger: { info: async () => {}, error: async () => {} },
    });
    const deleteUsers = sql.issued.find(q => /^DELETE FROM users\b/i.test(q.text));
    const deleteSubs  = sql.issued.find(q => /^DELETE FROM subscribers\b/i.test(q.text));
    assert(deleteUsers && /lower\(/i.test(deleteUsers.text),
      'DELETE FROM users must match case-insensitively: ' + (deleteUsers && deleteUsers.text));
    assert(deleteSubs && /lower\(/i.test(deleteSubs.text),
      'DELETE FROM subscribers must match case-insensitively: ' + (deleteSubs && deleteSubs.text));
  });

  // "delete my account" includes the mailing-list/contact-form row, matched
  // by exact address — and only that address, not the rest of that table.
  await testAsync('deleting the account removes only its own subscribers row', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql(
      [{ artist_id: 1, slug: 'mine', name: 'Mine', email: VICTIM, role: 'admin' }],
      {},
      [{ email: VICTIM }, { email: NEIGHBOUR }],
    );
    await executeDeletion(VICTIM, sql, {
      deleteFromR2: async () => true,
      logger: { info: async () => {}, error: async () => {} },
    });
    assert(!sql.subscribers.some(s => s.email === VICTIM), "the victim's subscriber row survived");
    assert(sql.subscribers.some(s => s.email === NEIGHBOUR), "a different address's subscriber row was removed");
  });

  // The HTTP handler needs to tell "nothing to delete" from "deleted" apart —
  // and an address that was never here must not open a transaction or be
  // logged as an account that got deleted.
  await testAsync('an address with no workspaces reports not found, and writes nothing', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql([
      { artist_id: 1, slug: 'mine', name: 'Mine', email: NEIGHBOUR, role: 'admin' },
    ]);
    const logged = [];
    const out = await executeDeletion(VICTIM, sql, {
      deleteFromR2: async () => true,
      logger: { info: async (e) => { logged.push(e); }, error: async () => {} },
    });
    assertEq(out.ok, true);
    assertEq(out.found, false);
    assertEq(out.destroyed.length, 0);
    assertEq(out.left.length, 0);
    assert(!sql.issued.some(q => /DELETE|UPDATE/i.test(q.text)),
      'an unknown address still wrote: ' + sql.issued.map(q => q.text).join(' | '));
    assert(!logged.includes('account_deleted'), 'an unknown address was logged as deleted');
  });

  // This is what the real dependency does: api/_r2.js's deleteFromR2 catches
  // its own errors and reports failure by RETURNING FALSE — it never throws. A
  // test that only makes the injected double throw asserts a contract the real
  // module does not honour, and the orphan log stays unreachable in production.
  await testAsync('a file delete that reports false is logged as orphaned', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const sql = recordingSql(
      [{ artist_id: 1, slug: 'mine', name: 'Mine', email: VICTIM, role: 'admin' }],
      { songs: [{ extra: { listenUrl: 'boom' } }] },
    );
    const logged = [];
    const out = await executeDeletion(VICTIM, sql, {
      deleteFromR2: async () => false,   // exactly what api/_r2.js returns on failure
      logger: { info: async () => {}, error: async (e, d) => { logged.push({ e, d }); } },
    });
    assertEq(out.ok, true);
    const orphan = logged.find(l => l.e === 'account_delete_file_orphaned');
    assert(orphan, 'a file delete that returned false was not logged: ' + JSON.stringify(logged));
    assertEq(orphan.d.url, 'boom');
  });

  // The throw path is kept as well — a future _r2 implementation, or any other
  // injected deleter, may throw rather than return false.
  await testAsync('a throwing file delete does not undo the row deletion, and is logged', async () => {
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

  // One await per file runs a Pro band's few hundred media files past the
  // function's time limit AFTER the transaction has committed — the rows are
  // gone, the client sees a connection error, and the retry answers "invalid
  // link" for a deletion that actually succeeded. The pool must be bounded too:
  // firing all of them at once is the other way to fall over.
  await testAsync('files are removed with bounded concurrency, and none is skipped', async () => {
    const { executeDeletion } = require(path.join(__dirname, '../../api/_domain/deletion'));
    const songs = Array.from({ length: 40 }, (_, i) => ({ extra: { listenUrl: 'f' + i } }));
    const sql = recordingSql(
      [{ artist_id: 1, slug: 'mine', name: 'Mine', email: VICTIM, role: 'admin' }],
      { songs },
    );
    let inFlight = 0, peak = 0;
    const removed = [];
    await executeDeletion(VICTIM, sql, {
      deleteFromR2: async (u) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r2 => setTimeout(r2, 1));
        inFlight--; removed.push(u);
        return true;
      },
      logger: { info: async () => {}, error: async () => {} },
    });
    assertEq(removed.length, 40, 'not every file was deleted');
    assert(peak > 1, 'the deletes ran one at a time — a few hundred files would time out');
    assert(peak <= 8, `the pool was unbounded: ${peak} deletes in flight at once`);
  });

  console.log(B('\ndeletion.js + deletion_handlers.js — every write is scoped'));

  const { test } = r;
  // Both files, not just the domain module: deletion_handlers.js issues an
  // `UPDATE users` of its own (the delete-token hash), and a guard that reads
  // only one of the two files silently stops covering the feature the moment a
  // write moves across the seam.
  const WRITE_SOURCES = ['deletion.js', 'deletion_handlers.js'];
  for (const file of WRITE_SOURCES) test(`${file}: no DELETE or UPDATE runs without naming its rows`, () => {
    const fs  = require('fs');
    const raw = fs.readFileSync(path.join(__dirname, '../../api/_domain/', file), 'utf8');
    // Strip line comments first — these files keep none inside their SQL, but a
    // stray "DELETE FROM" in prose should never be able to count as a write.
    const src = raw.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

    // Not preceded by a dot: `crypto.createHash(…).update(raw)` is a method
    // call, not a statement, and counting it makes the "did this check see
    // every write?" reconciliation below fail on a file that is perfectly fine.
    const KEYWORD = /(?<![.\w])(DELETE\s+FROM|UPDATE)\b/i;
    const countKeywords = (text) => (text.match(new RegExp(KEYWORD.source, 'gi')) || []).length;
    const totalKeywords = countKeywords(src);
    assert(totalKeywords > 0, 'found no write statements — has the module moved?');

    // Match whole self-terminated strings (template literal or quoted) rather
    // than hunting forward from the keyword for the next backtick: the old
    // approach let a write with no closing backtick after it — e.g.
    // `tx.unsafe('DELETE FROM users')` as the last statement in the file —
    // run the lazy match past end of scope into unrelated code, or off the
    // end of the file entirely, producing zero matches for that statement.
    // Anchoring both delimiters means such a statement is still captured
    // (as a quoted string containing the keyword) instead of vanishing.
    const STRING = /`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
    const strings = src.match(STRING) || [];
    const stmts = strings.filter(s => KEYWORD.test(s));

    // If every keyword occurrence in the source landed inside one of the
    // strings above, nothing was dropped. A mismatch means a write exists
    // outside any self-terminated string — the exact "vanished" case — and
    // that must fail loudly rather than silently pass with fewer statements.
    const keywordsInStmts = stmts.reduce((n, s) => n + countKeywords(s), 0);
    assert(keywordsInStmts === totalKeywords,
      `${totalKeywords - keywordsInStmts} write statement(s) are not inside a single ` +
      'self-terminated string, so this check cannot see them — a delimiter is probably missing');

    // Checked against the statement's own text only, not the source span
    // around it, so a comment sitting near a write can't satisfy this by
    // coincidence — and only against the part from WHERE onwards, because
    // scoping is what the WHERE clause does. `UPDATE gigs SET artist_id = …`
    // with no WHERE at all writes every band's rows while still containing the
    // string `artist_id =`, and the old check accepted it.
    const whereOf = (s) => {
      const i = s.search(/\bWHERE\b/i);
      return i === -1 ? '' : s.slice(i);
    };
    const scoped = (s) => {
      const w = whereOf(s);
      return /artist_id\s*=/i.test(w) ||
        /\bid\s*=\s*any\s*\(/i.test(w) ||
        // The victim's own address, bound as a parameter, against one of the
        // two columns that carry it: `email` on users/subscribers, `key` on
        // rate_limits (whose keys are `<prefix>:<address>`).
        (/\$\{(addr|email)\}/.test(w) && /\b(email|key)\b/i.test(w));
    };

    const unscoped = stmts.filter(s => !scoped(s));
    assert(unscoped.length === 0,
      'these writes name no artist and no victim email, and one database holds two bands:\n      ' +
      unscoped.map(s => s.replace(/\s+/g, ' ').slice(0, 90)).join('\n      '));
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
module.exports = run;
