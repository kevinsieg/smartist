# Self-service account deletion — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone delete their own smartist account and everything that
belongs only to them, from `/profile`, confirmed by an emailed link.

**Architecture:** A new `api/_domain/deletion.js` holds the whole decision and
the whole destruction, in four named functions that can be tested apart.
`api/config.js` gains three actions that call it — no new serverless function,
so the count stays at 11 of 12. Files are enumerated from the database before
any row is deleted, then removed from R2 afterwards, outside the transaction.

**Tech Stack:** postgres.js, Cloudflare R2 via `api/_r2.js`, Resend via
`api/_email.js`, plain-JS front end, `node tests/unit.js` for tests.

**Spec:** `docs/2026-09-23-account-deletion-design.md` — read it first. The
blast-radius reasoning in its testing section is the point of this feature.

## Global Constraints

- **Nothing outside the account may be deleted.** `smartist-kevin` holds both
  salb and klang; a statement without `artist_id` reaches the other band. This
  has happened before in this repo.
- **Never delete R2 by prefix.** `audio/`, `sheets/`, `playback/` are one flat
  namespace shared by every tenant. Enumerate from the database.
- **One blocker blocks everything** — no partial deletions.
- **`wrap(handler)` on every handler**; `_domain/*` files do not count toward the
  12-function limit.
- **Slug-independent auth** is `verifyUserToken(bearer)` → `claim.userId`, as in
  `myArtists` (`api/config.js:130`). `requireAuth` needs a slug and is wrong here.
- **i18n:** every new string gets a key in `app/i18n/{en,fr,de}.json`; bump
  `I18N_VERSION` in `app/js/i18n.js` and the `i18n.js?v=` query on every page.
  Currently 20. FR/DE are machine-translated first passes; flag for review.
- **Commit after each task.** Do not push; the user pushes.
- **No mail-configured gating.** The design proposed hiding the button where
  transactional mail is dead (klang, salmons). That is no longer needed: the
  Resend domain is being verified separately. Do not build the gate.

---

### Task 1: Schema — the two token columns

**Files:**
- Modify: `scripts/schema.sql` (the "Future migrations" block at the end)

**Interfaces:**
- Produces: `users.delete_token_hash TEXT`, `users.delete_token_expires TIMESTAMPTZ`

- [ ] **Step 1: Add the migration**

Append to the future-migrations block at the bottom of `scripts/schema.sql`:

```sql
-- 2026-09-23: self-service account deletion. The emailed confirmation link is
-- single-use and short-lived; the hash is stored, never the token. Mirrors
-- invite_token_hash / invite_expires_at directly above.
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_token_hash    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_token_expires TIMESTAMPTZ;
```

- [ ] **Step 2: Apply to dev and confirm it is idempotent**

```bash
node scripts/apply_schema.js        # answer y at the hostname prompt
node scripts/apply_schema.js        # run twice — IF NOT EXISTS must make this a no-op
```

Expected: second run completes with no error.

- [ ] **Step 3: Commit**

```bash
git add scripts/schema.sql
git commit -m "Add the columns an account-deletion link needs"
```

**Production note for the runbook, not this task:** apply to **both** production
databases — `smartist-kevin` (salb + klang) and `smartist` (public) — before the
endpoint ships. Task 7 adds this to the docs.

---

### Task 2: `planDeletion` — decide what would happen

**Files:**
- Create: `api/_domain/deletion.js`
- Test: `tests/unit/deletion.js`
- Modify: `tests/unit.js` (register the new file)

**Interfaces:**
- Produces: `planDeletion(email, sql)` → `Promise<{ destroy, leave, blocked }>`
  where each is an array of `{ artistId, slug, name }`. `destroy` = workspaces
  where this is the only member. `leave` = other members exist and this person is
  not the sole admin. `blocked` = other members exist and this person is the
  only admin.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/deletion.js`:

```js
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
```

Register it in `tests/unit.js` after `require('./unit/oauth_callback'),`:

```js
  require('./unit/deletion'),
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/unit/deletion.js`
Expected: FAIL — `Cannot find module '.../api/_domain/deletion'`

- [ ] **Step 3: Write the implementation**

Create `api/_domain/deletion.js`:

```js
// Deleting a person, not a workspace.
//
// getArtistsForUser joins on email, so one person is several users rows tied
// together by their address. Every decision here is made across those rows.
'use strict';

// What deleting this address would do to each of its workspaces.
//   destroy — nobody else is in it; it goes entirely, rows and files
//   leave   — others are in it and someone else can still administer it
//   blocked — others are in it and this is the only admin
async function planDeletion(email, sql) {
  const addr = String(email).toLowerCase();

  const mine = await sql`
    SELECT u.artist_id, a.slug, a.name, u.role
    FROM users u
    JOIN artists a ON a.id = u.artist_id
    WHERE u.email = ${addr}
    ORDER BY a.name
  `;
  if (!mine.length) return { destroy: [], leave: [], blocked: [] };

  const artistIds = mine.map(r => r.artist_id);
  const members = await sql`
    SELECT artist_id, email, role FROM users WHERE artist_id = ANY(${artistIds})
  `;

  const out = { destroy: [], leave: [], blocked: [] };
  for (const row of mine) {
    const here   = members.filter(m => m.artist_id === row.artist_id);
    const others = here.filter(m => String(m.email).toLowerCase() !== addr);
    const entry  = { artistId: row.artist_id, slug: row.slug, name: row.name };

    if (others.length === 0)                           out.destroy.push(entry);
    else if (others.some(m => m.role === 'admin'))     out.leave.push(entry);
    else                                               out.blocked.push(entry);
  }
  return out;
}

module.exports = { planDeletion };
```

- [ ] **Step 4: Run the tests**

Run: `node tests/unit/deletion.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add api/_domain/deletion.js tests/unit/deletion.js tests/unit.js
git commit -m "Work out what deleting an account would destroy"
```

---

### Task 3: `collectR2Urls` — find every file before the rows go

**Files:**
- Modify: `api/_domain/deletion.js`
- Modify: `tests/unit/deletion.js`

**Interfaces:**
- Consumes: nothing from Task 2 beyond the module.
- Produces: `collectR2Urls(artistIds, sql)` → `Promise<string[]>` — public URLs,
  de-duplicated, for every file belonging to those artists.

- [ ] **Step 1: Write the failing test**

Append inside `run(r)` in `tests/unit/deletion.js`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/unit/deletion.js`
Expected: FAIL — `collectR2Urls is not a function`

- [ ] **Step 3: Write the implementation**

Add to `api/_domain/deletion.js`, above `module.exports`:

```js
// Every R2 object belonging to these artists, gathered BEFORE any row is
// deleted — once the rows are gone there is nothing left to enumerate from.
//
// Never do this by key prefix. _media.js writes song media as
// `audio/<uuid>-<name>`, `sheets/…`, `playback/…` — one flat namespace shared
// by every tenant — so a prefix delete would take every band's recordings.
// Only gigs/<slug>/ and bands/<slug>/ carry a slug, and even those are not
// worth the inconsistency.
async function collectR2Urls(artistIds, sql) {
  if (!artistIds.length) return [];

  // deleted songs included on purpose: soft-deleted rows still own their files.
  const songs = await sql`
    SELECT extra FROM songs WHERE artist_id = ANY(${artistIds})
  `;
  const gigs = await sql`
    SELECT poster_url, thumb_url FROM gigs WHERE artist_id = ANY(${artistIds})
  `;
  const bands = await sql`
    SELECT config FROM artists WHERE id = ANY(${artistIds})
  `;

  const urls = new Set();
  const add  = (u) => { if (u && typeof u === 'string') urls.add(u); };

  for (const s of songs) {
    const e = s.extra || {};
    add(e.listenUrl); add(e.sheetUrl); add(e.playbackUrl);
  }
  for (const g of gigs) { add(g.poster_url); add(g.thumb_url); }
  for (const b of bands) { add((b.config || {}).logoUrl); }

  return [...urls];
}
```

Change the export line to:

```js
module.exports = { planDeletion, collectR2Urls };
```

- [ ] **Step 4: Run the tests**

Run: `node tests/unit/deletion.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add api/_domain/deletion.js tests/unit/deletion.js
git commit -m "Find an account's files while its rows still exist"
```

---

### Task 4: `executeDeletion` — the destruction, scoped

**Files:**
- Modify: `api/_domain/deletion.js`
- Modify: `tests/unit/deletion.js`

**Interfaces:**
- Consumes: `planDeletion`, `collectR2Urls` from Tasks 2 and 3.
- Produces: `executeDeletion(email, sql, { deleteFromR2, logger })` →
  `Promise<{ ok: true, destroyed: string[], left: string[] }>` or
  `Promise<{ ok: false, blocked: [{ slug, name }] }>`.
  `deleteFromR2` and `logger` are injected so tests can observe them.

- [ ] **Step 1: Write the failing test**

Append inside `run(r)` in `tests/unit/deletion.js`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/unit/deletion.js`
Expected: FAIL — `executeDeletion is not a function`

- [ ] **Step 3: Write the implementation**

Add to `api/_domain/deletion.js`:

```js
// Delete the account. Refuses entirely if any workspace is blocked — a
// half-deleted account is a state nobody can reason about afterwards.
//
// deleteFromR2 and logger are injected so the tests can watch them; production
// passes the real ones from api/_r2 and api/_logger.
async function executeDeletion(email, sql, { deleteFromR2, logger }) {
  const addr = String(email).toLowerCase();
  const plan = await planDeletion(addr, sql);

  if (plan.blocked.length) {
    return { ok: false, blocked: plan.blocked.map(b => ({ slug: b.slug, name: b.name })) };
  }

  const destroyIds = plan.destroy.map(a => a.artistId);

  // Enumerated first: once the rows are gone there is nothing to enumerate.
  const urls = await collectR2Urls(destroyIds, sql);

  await sql.begin(async (tx) => {
    if (destroyIds.length) {
      // gigs.venue_id / organizer_id are ON DELETE RESTRICT — nullify first, and
      // only for these artists. Same ordering as scripts/delete_artist.js.
      await tx`UPDATE gigs SET venue_id = NULL, organizer_id = NULL WHERE artist_id = ANY(${destroyIds})`;
      // setlist_songs.song_id has no cascade, so setlists go before songs.
      await tx`DELETE FROM setlists WHERE artist_id = ANY(${destroyIds})`;
      // artists cascades songs, gigs, venues, organizers, users, logs.
      await tx`DELETE FROM artists WHERE id = ANY(${destroyIds})`;
    }
    // Workspaces that survive: drop only this person's membership.
    await tx`DELETE FROM users WHERE email = ${addr}`;
  });

  // Outside the transaction on purpose: R2 has no rollback. An orphaned file is
  // a storage leak behind an unguessable UUID in a non-listable bucket; a row
  // deleted to match a failed file delete would be worse. Log every failure —
  // scripts/plans.js --recount is the reconciliation pass.
  for (const url of urls) {
    try {
      await deleteFromR2(url);
    } catch (err) {
      await logger.error('account_delete_file_orphaned', { url, error: err.message });
    }
  }

  await logger.info('account_deleted', {
    email: addr,
    destroyed: plan.destroy.map(a => a.slug),
    left:      plan.leave.map(a => a.slug),
    files:     urls.length,
  });

  return { ok: true, destroyed: plan.destroy.map(a => a.slug), left: plan.leave.map(a => a.slug) };
}
```

Change the export line to:

```js
module.exports = { planDeletion, collectR2Urls, executeDeletion };
```

- [ ] **Step 4: Run the tests**

Run: `node tests/unit/deletion.js` then `node tests/unit.js`
Expected: PASS, 11 tests in the file; the suite stays green.

- [ ] **Step 5: Commit**

```bash
git add api/_domain/deletion.js tests/unit/deletion.js
git commit -m "Delete the account, and nothing next to it"
```

---

### Task 5: A static guard over the deletion SQL

**Files:**
- Modify: `tests/unit/deletion.js`

**Interfaces:** none — this reads source text.

**Why:** fixtures only catch what they model. This catches an unscoped `DELETE`
or `UPDATE` added to the module next year, when nobody remembers that one
database holds two bands.

- [ ] **Step 1: Write the test**

Append inside `run(r)` in `tests/unit/deletion.js`:

```js
  console.log(B('\ndeletion.js — every write is scoped'));

  const { test } = r;
  test('no DELETE or UPDATE runs without naming its rows', () => {
    const fs  = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '../../api/_domain/deletion.js'), 'utf8');

    // Template-literal SQL, statement by statement.
    const stmts = [...src.matchAll(/(DELETE\s+FROM|UPDATE)\s+[\s\S]*?`/gi)].map(m => m[0]);
    assert(stmts.length > 0, 'found no write statements — has the module moved?');

    const unscoped = stmts.filter(s =>
      !/artist_id\s*=/i.test(s) &&
      !/\bid\s*=\s*ANY/i.test(s) &&
      !/email\s*=\s*\$\{addr\}/.test(s));

    assert(unscoped.length === 0,
      'these writes name no artist, and one database holds two bands:\n      ' +
      unscoped.map(s => s.replace(/\s+/g, ' ').slice(0, 90)).join('\n      '));
  });
```

- [ ] **Step 2: Run it**

Run: `node tests/unit/deletion.js`
Expected: PASS. To prove it bites, temporarily change the `DELETE FROM setlists`
line to `DELETE FROM setlists` with no `WHERE`, re-run, see it fail, then revert.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/deletion.js
git commit -m "Fail the build if a deletion statement forgets its filter"
```

---

### Task 6: The three endpoints

**Files:**
- Modify: `api/config.js`
- Create: `api/_domain/deletion_handlers.js`
- Test: `tests/unit/deletion_handlers.js`
- Modify: `tests/unit.js`

**Interfaces:**
- Consumes: `planDeletion`, `executeDeletion` from `./deletion`.
- Produces: `preflight(req,res)`, `requestDeletion(req,res)`, `confirmDeletion(req,res)`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/deletion_handlers.js`. Mock `_db`, `_ratelimit`, `_email`,
`_r2` and `_logger` in the require cache — copy the `load()` shape from
`tests/unit/oauth_callback.js`, **including the `_token` eviction**, which that
file explains at length. Reuse the `recordingSql(rows, media)` helper written in
Task 4 rather than inventing a second fake; move it to the top of
`tests/unit/deletion.js` and export it if that is easier than copying.

The three fixtures the tests below name:

```js
// A: deletable — one workspace, nobody else in it
const A = [{ artist_id: 1, slug: 'mine', name: 'Mine', email: VICTIM, role: 'admin' }];

// B: blocked — sole admin, another member present
const B = [
  { artist_id: 1, slug: 'band', name: 'Band', email: VICTIM,    role: 'admin'  },
  { artist_id: 1, slug: 'band', name: 'Band', email: NEIGHBOUR, role: 'member' },
];

// A session for VICTIM. verifyUserToken is the real one (the _token stub is
// evicted), so mint a token with the real generateUserToken for userId 7 and
// have the users-by-id query return VICTIM's address.
function authed(body = {}) {
  return { headers: { authorization: 'Bearer ' + token }, body, query: {} };
}
function withToken(raw) { return { headers: {}, body: { token: raw }, query: {} }; }
```

Cover:

```js
  await testAsync('requesting deletion without a session is 401', async () => {
    const res = mockRes();
    await handlers.requestDeletion({ headers: {}, body: {} }, res);
    assertEq(res._status, 401);
  });

  await testAsync('a blocked account is told which workspaces block it', async () => {
    // fixture: victim is sole admin of a band with another member
    const res = mockRes();
    await handlers.requestDeletion(authed(), res);
    assertEq(res._status, 409);
    assertEq(res._body.blocked[0].slug, 'band');
    assertEq(sent.length, 0);           // no email for a request that cannot proceed
  });

  await testAsync('a valid request stores only a hash and emails a link', async () => {
    const res = mockRes();
    await handlers.requestDeletion(authed(), res);
    assertEq(res._status, 200);
    assertEq(sent.length, 1);
    const stored = writes.find(w => /delete_token_hash/.test(w.text));
    assert(stored, 'no token stored');
    const raw = sent[0].html.match(/token=([a-f0-9]+)/)[1];
    assert(!JSON.stringify(stored.values).includes(raw), 'the raw token was stored');
  });

  await testAsync('the confirm link works once', async () => {
    const res1 = mockRes(); await handlers.confirmDeletion(withToken(raw), res1);
    assertEq(res1._status, 200);
    const res2 = mockRes(); await handlers.confirmDeletion(withToken(raw), res2);
    assertEq(res2._status, 400);
  });

  await testAsync('an expired token is refused', async () => {
    // fixture row with delete_token_expires in the past
    const res = mockRes(); await handlers.confirmDeletion(withToken(raw), res);
    assertEq(res._status, 400);
  });

  // The preflight answer is stale by the time the link is clicked.
  await testAsync('confirm re-checks the blockers rather than trusting the request', async () => {
    // fixture: unblocked at request time, blocked by the time confirm runs
    const res = mockRes(); await handlers.confirmDeletion(withToken(raw), res);
    assertEq(res._status, 409);
    assertEq(deleted.length, 0);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/unit/deletion_handlers.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handlers**

Create `api/_domain/deletion_handlers.js`:

```js
'use strict';
const crypto = require('crypto');
const { getDb } = require('../_db');
const { verifyUserToken } = require('../_token');
const { checkRateLimit, clientIp } = require('../_ratelimit');
const { deleteFromR2 } = require('../_r2');
const { sendEmail } = require('../_email');
const logger = require('../_logger');
const { origin } = require('./http');
const { planDeletion, executeDeletion } = require('./deletion');

const TOKEN_TTL_MS = 30 * 60 * 1000;

// Slug-independent: deletion spans every workspace, so there is no slug to
// authenticate against. Same shape as myArtists in api/config.js.
async function _sessionEmail(req, sql) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claim  = verifyUserToken(bearer);
  if (!claim) return null;
  const [row] = await sql`SELECT email FROM users WHERE id = ${claim.userId} LIMIT 1`;
  return row ? String(row.email).toLowerCase() : null;
}

// GET ?action=deletion-preflight — what would happen, in the person's own words.
async function preflight(req, res) {
  const sql   = getDb();
  const email = await _sessionEmail(req, sql);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });
  const plan = await planDeletion(email, sql);
  return res.json({
    email,
    destroy: plan.destroy.map(a => ({ slug: a.slug, name: a.name })),
    leave:   plan.leave.map(a => ({ slug: a.slug, name: a.name })),
    blocked: plan.blocked.map(a => ({ slug: a.slug, name: a.name })),
  });
}

// POST ?action=request-deletion — store a hash, email the link.
async function requestDeletion(req, res) {
  const sql   = getDb();
  const email = await _sessionEmail(req, sql);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  if (await checkRateLimit(`delete-req:${clientIp(req)}`, 3, 3600))
    return res.status(429).json({ error: 'Too many requests — try again later' });

  const plan = await planDeletion(email, sql);
  if (plan.blocked.length)
    return res.status(409).json({ blocked: plan.blocked.map(a => ({ slug: a.slug, name: a.name })) });
  if (!plan.destroy.length && !plan.leave.length)
    return res.status(404).json({ error: 'No account found' });

  const raw     = crypto.randomBytes(32).toString('hex');
  const hash    = crypto.createHash('sha256').update(raw).digest('hex');
  const expires = new Date(Date.now() + TOKEN_TTL_MS);
  await sql`
    UPDATE users SET delete_token_hash = ${hash}, delete_token_expires = ${expires}
    WHERE email = ${email}
  `;

  const link = `${origin(req)}/profile#delete-token=${raw}`;
  try {
    await sendEmail({
      to: email,
      subject: 'Confirm deleting your smartist account',
      html:
        `<p>Click to delete your smartist account. This cannot be undone.</p>` +
        `<p><a href="${link}">Delete my account</a> — valid for 30 minutes.</p>` +
        `<p>If you did not ask for this, ignore this email and nothing happens.</p>`,
    });
  } catch (err) {
    await logger.error('account_delete_email_failed', { email, error: err.message });
    return res.status(500).json({ error: 'Failed to send email — try again later' });
  }
  await logger.info('account_delete_requested', { email });
  return res.json({ ok: true });
}

// POST ?action=confirm-deletion — the link. Authenticated by the token alone,
// because it may well be opened in a different browser from the one that asked.
async function confirmDeletion(req, res) {
  const raw = req.body?.token || req.query?.token;
  if (!raw) return res.status(400).json({ error: 'Invalid or expired link' });

  const sql  = getDb();
  const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
  const [row] = await sql`
    SELECT email FROM users
    WHERE delete_token_hash = ${hash} AND delete_token_expires > now()
    LIMIT 1
  `;
  if (!row) return res.status(400).json({ error: 'Invalid or expired link' });

  const out = await executeDeletion(String(row.email).toLowerCase(), sql, { deleteFromR2, logger });
  if (!out.ok) return res.status(409).json({ blocked: out.blocked });
  return res.json({ ok: true, destroyed: out.destroyed, left: out.left });
}

module.exports = { preflight, requestDeletion, confirmDeletion };
```

- [ ] **Step 4: Wire the router**

In `api/config.js`, add near the other domain requires:

```js
const deletion = require('./_domain/deletion_handlers');
```

In the POST block, before `if (req.body?.source === 'contact')`:

```js
    if (action === 'request-deletion') return deletion.requestDeletion(req, res);
    if (action === 'confirm-deletion') return deletion.confirmDeletion(req, res);
```

In the slug-independent GET block, beside `my-artists`:

```js
  if (req.query.action === 'deletion-preflight') return deletion.preflight(req, res);
```

- [ ] **Step 5: Run the tests**

Run: `node tests/unit.js`
Expected: PASS, suite green.

- [ ] **Step 6: Commit**

```bash
git add api/config.js api/_domain/deletion_handlers.js tests/unit/deletion_handlers.js tests/unit.js
git commit -m "Ask by email before deleting an account"
```

---

### Task 7: The danger zone on /profile, and the runbook

**Files:**
- Modify: `app/profile.html` (inline script at the bottom)
- Modify: `app/i18n/en.json`, `app/i18n/fr.json`, `app/i18n/de.json`
- Modify: `app/js/i18n.js` (`I18N_VERSION` 20 → 21)
- Modify: every `app/*.html` (`i18n.js?v=20` → 21, `app.css?v=37` → 38)
- Modify: `app/css/app.css` (danger-zone styles)
- Modify: `docs/tenant-onboarding.md` (the migration runbook)

- [ ] **Step 1: Add the i18n keys**

Add to all three locale files (EN shown; FR/DE are machine-translated first
passes — flag them for a native pass in the commit message):

```json
"profile.dangerTitle": "Delete account",
"profile.dangerIntro": "This removes your account and everything only you can see. It cannot be undone.",
"profile.dangerDestroy": "These workspaces will be deleted entirely, with all their songs, gigs and files:",
"profile.dangerLeave": "You will be removed from these, and they carry on without you:",
"profile.dangerBlocked": "You are the only admin of these, and other people are in them. Promote another admin or remove the members first:",
"profile.dangerExport": "Export your data first",
"profile.dangerButton": "Delete my account",
"profile.dangerSent": "Check your email — we sent a confirmation link to {email}. It expires in 30 minutes.",
"profile.dangerConfirm": "Deleting your account…",
"profile.dangerDone": "Your account and its data have been deleted.",
"profile.dangerFailed": "That link is invalid or has expired."
```

- [ ] **Step 2: Render the danger zone**

In `app/profile.html`'s inline script, after the existing sections load, call
`GET /api/config?action=deletion-preflight` through `apiFetch`, render the three
lists, disable the button when `blocked.length > 0`, and link
`/{slug}/export` for each workspace in `destroy`.

On click: `POST /api/config` with `{ action: 'request-deletion' }`, then show
`profile.dangerSent` with the address.

On load, if `location.hash` carries `delete-token=`, `POST` it as
`{ action: 'confirm-deletion', token }`, strip the hash with
`history.replaceState`, and render done or failed.

- [ ] **Step 3: Style it**

In `app/css/app.css`, beside `.auth-banner`:

```css
/* Danger zone: deliberately visually separated from the settings above it, so
   nothing here can be clicked while skimming. */
.danger-zone {
    border: 1px solid #e3c4bd; border-radius: var(--radius);
    padding: 1rem; margin-top: 2rem; background: #fdf7f5;
}
.danger-zone h3 { color: #7a2a2a; margin-bottom: 0.5rem; }
.danger-zone ul { margin: 0.5rem 0 0.75rem 1.1rem; font-size: var(--text-sm); }
.danger-zone .btn-danger { background: #7a2a2a; color: #fff; border-color: #7a2a2a; }
.danger-zone .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
```

- [ ] **Step 4: Bump the asset versions**

```bash
perl -pi -e 's/i18n\.js\?v=20/i18n.js?v=21/g; s/app\.css\?v=37/app.css?v=38/g' app/*.html
perl -pi -e 's/var I18N_VERSION = 20;/var I18N_VERSION = 21;/' app/js/i18n.js
grep -rn "v=20\|v=37" app/*.html || echo "no stragglers"
```

- [ ] **Step 5: Add the migration to the runbook**

In `docs/tenant-onboarding.md`, under the schema section:

```markdown
### 2026-09-23 — account deletion columns

`users.delete_token_hash` and `users.delete_token_expires`. Apply to **every**
production database before the profile page ships, not just the linked one:

- `smartist-kevin` — serves both salb and klang
- `smartist` — serves app.smartist.studio and the demo

`node scripts/apply_schema.js` against each. The statements are
`ADD COLUMN IF NOT EXISTS`, so re-running is safe.

The feature needs working transactional email. Until `kevinklang.de` is verified
in the Resend account klang and salmons use, the confirmation link never
arrives there.
```

- [ ] **Step 6: Run everything**

```bash
node tests/unit.js
```
Expected: PASS, including `tests/unit/i18n.js` (identical key sets across the
three locales) and `tests/unit/page_scripts.js`.

- [ ] **Step 7: Commit**

```bash
git add app/ docs/tenant-onboarding.md
git commit -m "Let someone delete their account from their profile"
```

---

## After the plan

Manual verification, because none of this has been exercised in a browser:

1. `vercel dev`, sign in, open `/profile`.
2. A sole-member workspace: request, click the emailed link, confirm the rows
   and the R2 files are gone.
3. A workspace with a second admin: confirm it survives and only the membership
   went.
4. A workspace where you are the sole admin with a member: confirm the button
   is disabled and names it.
5. Against the dev database with two artists seeded, confirm the neighbour's row
   counts are unchanged — the assertion the unit tests can only approximate.

Step 5 is the one that matters. The unit tests assert on the statements issued;
only a real database proves nothing else moved.
