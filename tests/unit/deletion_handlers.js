'use strict';

// The three HTTP endpoints in front of api/_domain/deletion.js. The domain
// module is already tested (tests/unit/deletion.js) against a stateless fake
// sql — here the fake sql must be stateful, because a request stores a token
// hash on a row and a later confirm call has to see it, exactly like the real
// users table.

const crypto = require('crypto');
const path = require('path');
const { stubLogger } = require('./_runner');
stubLogger();

process.env.APP_SECRET = process.env.APP_SECRET || 'unit-test-secret-32-bytes-okayy!';

const VICTIM    = 'player@example.com';
const NEIGHBOUR = 'other@example.com';

// A: deletable — one workspace, nobody else in it
const A = [{ id: 7, artist_id: 1, slug: 'mine', name: 'Mine', email: VICTIM, role: 'admin' }];

// BLOCKED: sole admin, another member present. (Not named B — run()
// destructures the runner's bold-text helper as B, which would shadow it.)
const BLOCKED = [
  { id: 7, artist_id: 1, slug: 'band', name: 'Band', email: VICTIM,    role: 'admin'  },
  { id: 8, artist_id: 1, slug: 'band', name: 'Band', email: NEIGHBOUR, role: 'member' },
];

// Mirrors real Postgres: an exact-string column compares case-sensitively
// unless the SQL text itself wraps the column in lower(...).
function emailMatches(queryText, rowEmail, paramValue) {
  return /lower\s*\(/i.test(queryText)
    ? rowEmail.toLowerCase() === String(paramValue).toLowerCase()
    : rowEmail === paramValue;
}

// A stateful fake `users` table. Unlike deletion.js's fakeSql (one query in,
// one answer out), this one is mutated by the write statements the handlers
// and executeDeletion issue, so a confirm call sees what an earlier request
// call wrote — and a second confirm sees the row a first confirm removed.
function makeDb(rows) {
  let users = rows.map(r => ({ delete_token_hash: null, delete_token_expires: null, invited_by: null, ...r }));
  const writes = [];

  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    writes.push({ text, values });

    // _sessionEmail: who is the bearer token's userId.
    if (/SELECT email FROM users WHERE id =/i.test(text)) {
      const row = users.find(u => u.id === values[0]);
      return Promise.resolve(row ? [{ email: row.email }] : []);
    }
    // confirmDeletion: look the raw token's hash up.
    if (/SELECT email FROM users\s+WHERE delete_token_hash =/i.test(text)) {
      const [hash] = values;
      const now = new Date();
      const row = users.find(u =>
        u.delete_token_hash === hash && u.delete_token_expires && new Date(u.delete_token_expires) > now);
      return Promise.resolve(row ? [{ email: row.email }] : []);
    }
    // requestDeletion: store the hash on the requester's row(s).
    if (/UPDATE users SET delete_token_hash/i.test(text)) {
      const [hash, expires, email] = values;
      // Same lower(email) matching as the real column — a bare === here would
      // let this fake pass even without the fix, since it would silently
      // agree with a bug that matches nothing for a mixed-case stored address.
      const matched = users.filter(u => emailMatches(text, u.email, email));
      matched.forEach(u => { u.delete_token_hash = hash; u.delete_token_expires = expires; });
      return Promise.resolve(matched.map(u => ({ id: u.id })));
    }
    // planDeletion: this address's own memberships.
    if (/JOIN artists/i.test(text)) {
      const [email] = values;
      return Promise.resolve(
        users.filter(u => emailMatches(text, u.email, email))
             .map(u => ({ artist_id: u.artist_id, slug: u.slug, name: u.name, role: u.role }))
      );
    }
    // planDeletion: everyone else sharing those workspaces.
    if (/SELECT artist_id, email, role FROM users/i.test(text)) {
      const ids = values[0] || [];
      return Promise.resolve(
        users.filter(u => ids.includes(u.artist_id))
             .map(u => ({ artist_id: u.artist_id, email: u.email, role: u.role }))
      );
    }
    // collectR2Urls — no media fixtures in these tests.
    if (/FROM songs/i.test(text))               return Promise.resolve([]);
    if (/FROM gigs/i.test(text))                 return Promise.resolve([]);
    if (/SELECT config FROM artists/i.test(text)) return Promise.resolve([]);
    if (/UPDATE gigs SET venue_id/i.test(text))  return Promise.resolve([]);
    if (/DELETE FROM setlists/i.test(text))      return Promise.resolve([]);
    // executeDeletion's transaction: destroying a workspace cascades its users.
    if (/DELETE FROM artists WHERE id = ANY/i.test(text)) {
      const ids = values[0] || [];
      users = users.filter(u => !ids.includes(u.artist_id));
      return Promise.resolve([]);
    }
    if (/UPDATE users SET invited_by = NULL/i.test(text)) return Promise.resolve([]);
    if (/DELETE FROM users WHERE/i.test(text)) {
      const [addr] = values;
      users = users.filter(u => !emailMatches(text, u.email, addr));
      return Promise.resolve([]);
    }
    if (/DELETE FROM subscribers/i.test(text))   return Promise.resolve([]);
    return Promise.resolve([]);
  };
  sql.begin = async (cb) => cb(sql);
  return { sql, writes, get users() { return users; } };
}

function mockRes() {
  const r = {};
  r.status = (c) => { r._status = c; return r; };
  r.json   = (b) => { r._body = b; if (r._status === undefined) r._status = 200; return r; };
  return r;
}

// Fresh module graph per fixture, mirroring tests/unit/oauth_callback.js's
// load(): _db/_ratelimit/_email/_r2/_logger stubbed, _domain files and _token
// evicted so nothing from an earlier test file's stub survives. Deletion is
// authenticated with a real session token (verifyUserToken is the real one),
// so the _token eviction matters directly here — an earlier suite leaves a
// _token stub whose generateUserToken returns a fixed string, and without
// evicting it these tests would mint that fixed string and assert against the
// stub instead of a real token.
function load(rows) {
  const dbPath     = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath     = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const emailPath  = require.resolve(path.join(__dirname, '../../api/_email'));
  const r2Path     = require.resolve(path.join(__dirname, '../../api/_r2'));
  const tokenPath  = require.resolve(path.join(__dirname, '../../api/_token'));

  const domainDir = path.join(__dirname, '../../api/_domain');
  require('fs').readdirSync(domainDir).filter(f => f.endsWith('.js')).forEach(f => {
    try { delete require.cache[require.resolve(path.join(domainDir, f))]; } catch {}
  });
  delete require.cache[dbPath];
  delete require.cache[tokenPath];

  const db = makeDb(rows);
  const sent = [];
  const deletedFiles = [];

  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { getDb: () => db.sql },
  };
  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { checkRateLimit: async () => false, clientIp: () => '127.0.0.1' },
  };
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendEmail: async (mail) => { sent.push(mail); } },
  };
  require.cache[r2Path] = {
    id: r2Path, filename: r2Path, loaded: true,
    exports: { deleteFromR2: async (u) => { deletedFiles.push(u); return true; } },
  };

  return {
    handlers: require(path.join(__dirname, '../../api/_domain/deletion_handlers')),
    token: require(tokenPath),   // the real one, loaded after the eviction above
    db, sent, deletedFiles,
  };
}

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nAccount deletion — the three endpoints'));

  await testAsync('requesting deletion without a session is 401', async () => {
    const { handlers } = load(A);
    const res = mockRes();
    await handlers.requestDeletion({ headers: {}, body: {} }, res);
    assertEq(res._status, 401);
  });

  await testAsync('a blocked account is told which workspaces block it', async () => {
    const { handlers, token, sent } = load(BLOCKED);
    const raw = token.generateUserToken(7, 'admin', 60_000);
    const res = mockRes();
    await handlers.requestDeletion({ headers: { authorization: 'Bearer ' + raw }, body: {}, query: {} }, res);
    assertEq(res._status, 409);
    assertEq(res._body.blocked[0].slug, 'band');
    assertEq(sent.length, 0); // no email for a request that cannot proceed
  });

  // OAuth signup stores whatever casing the provider sent (registration.js
  // inserts verified.email unchanged) — the request path must still find and
  // update that row, or the token is never stored while the handler still
  // mails a link that can never work.
  await testAsync('a mixed-case stored address still gets a deletion token it can use', async () => {
    const mixed = [{ id: 7, artist_id: 1, slug: 'mine', name: 'Mine', email: 'Jane.Doe@Example.com', role: 'admin' }];
    const { handlers, token, sent, db } = load(mixed);
    const sessionToken = token.generateUserToken(7, 'admin', 60_000);
    const res = mockRes();
    await handlers.requestDeletion({ headers: { authorization: 'Bearer ' + sessionToken }, body: {}, query: {} }, res);
    assertEq(res._status, 200);
    assertEq(sent.length, 1);
    const stored = db.users.find(u => u.id === 7);
    assert(stored.delete_token_hash, 'the token was never stored against the mixed-case row');

    const raw = sent[0].html.match(/token=([a-f0-9]+)/)[1];
    const confirmRes = mockRes();
    await handlers.confirmDeletion({ headers: {}, body: { token: raw }, query: {} }, confirmRes);
    assertEq(confirmRes._status, 200);
  });

  // Shared across the next two tests: a request stores a token, and the
  // confirm tests below act on that same stored token.
  let scenario, raw;

  await testAsync('a valid request stores only a hash and emails a link', async () => {
    scenario = load(A);
    const { handlers, token, sent, db } = scenario;
    const sessionToken = token.generateUserToken(7, 'admin', 60_000);
    const res = mockRes();
    await handlers.requestDeletion({ headers: { authorization: 'Bearer ' + sessionToken }, body: {}, query: {} }, res);
    assertEq(res._status, 200);
    assertEq(sent.length, 1);
    const stored = db.writes.find(w => /delete_token_hash/.test(w.text));
    assert(stored, 'no token stored');
    raw = sent[0].html.match(/token=([a-f0-9]+)/)[1];
    assert(!JSON.stringify(stored.values).includes(raw), 'the raw token was stored');
  });

  await testAsync('the confirm link works once', async () => {
    const { handlers } = scenario;
    const res1 = mockRes();
    await handlers.confirmDeletion({ headers: {}, body: { token: raw }, query: {} }, res1);
    assertEq(res1._status, 200);
    const res2 = mockRes();
    await handlers.confirmDeletion({ headers: {}, body: { token: raw }, query: {} }, res2);
    assertEq(res2._status, 400);
  });

  await testAsync('an expired token is refused', async () => {
    const expiredRaw  = crypto.randomBytes(32).toString('hex');
    const expiredHash = crypto.createHash('sha256').update(expiredRaw).digest('hex');
    const { handlers } = load(A.map(u => ({
      ...u, delete_token_hash: expiredHash, delete_token_expires: new Date(Date.now() - 1000),
    })));
    const res = mockRes();
    await handlers.confirmDeletion({ headers: {}, body: { token: expiredRaw }, query: {} }, res);
    assertEq(res._status, 400);
  });

  // The preflight answer is stale by the time the link is clicked: seed a
  // valid token directly onto a row that, at confirm time, is blocked (sole
  // admin, someone else present) — planDeletion is re-run inside
  // executeDeletion rather than trusting whatever the request-time check saw.
  await testAsync('confirm re-checks the blockers rather than trusting the request', async () => {
    const staleRaw  = crypto.randomBytes(32).toString('hex');
    const staleHash = crypto.createHash('sha256').update(staleRaw).digest('hex');
    const rows = BLOCKED.map((u, i) => i === 0
      ? { ...u, delete_token_hash: staleHash, delete_token_expires: new Date(Date.now() + 60_000) }
      : u);
    const { handlers, deletedFiles } = load(rows);
    const res = mockRes();
    await handlers.confirmDeletion({ headers: {}, body: { token: staleRaw }, query: {} }, res);
    assertEq(res._status, 409);
    assertEq(deletedFiles.length, 0);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
