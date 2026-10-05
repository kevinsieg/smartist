'use strict';

// Resetting a password without naming a band.
//
// /api/:artist/request-reset needs the slug in the URL. At the root of a
// multi-tenant deployment there is none, so the form posted to
// /api//request-reset — a 308 to a 404, and no mail ever sent. Someone who
// signed up with Google on app.smartist.studio therefore had no route back into
// their account at all: no password to remember, and nothing to reset.
//
// The same address can own several users rows with DIFFERENT password hashes
// (see api/_domain/login.js). A reset sets one password across all of them, so
// the per-workspace hashes stay the invisible artifact they already are.

const path = require('path');
const { stubLogger } = require('./_runner');

stubLogger();

process.env.APP_SECRET = process.env.APP_SECRET || 'unit-test-secret-32-bytes-okayy!';

const VICTIM    = 'player@example.com';
const NEIGHBOUR = 'someone@else.com';

let sentMail = null;

// rows: every users row in the database, across every address.
function load({ rows = [], artists = [{ slug: 'band', name: 'Band', role: 'admin' }], tokens = {} } = {}) {
  const dbPath    = require.resolve(path.join(__dirname, '../../api/_db'));
  const rlPath    = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
  const emailPath = require.resolve(path.join(__dirname, '../../api/_email'));
  const tokenPath = require.resolve(path.join(__dirname, '../../api/_token'));
  const bcryptPath  = require.resolve('bcryptjs');
  const configPath  = require.resolve(path.join(__dirname, '../../api/_config'));

  [dbPath, configPath, tokenPath].forEach(p => delete require.cache[p]);
  const domainDir = path.join(__dirname, '../../api/_domain');
  require('fs').readdirSync(domainDir).filter(f => f.endsWith('.js')).forEach(f => {
    try { delete require.cache[require.resolve(path.join(domainDir, f))]; } catch {}
  });

  const queries = [];
  const sql = (strings, ...values) => {
    const text = Array.isArray(strings) ? strings.join('?').replace(/\s+/g, ' ').trim() : String(strings);
    queries.push({ text, values });
    if (/JOIN artists/i.test(text)) return Promise.resolve(artists);
    if (/UPDATE users/i.test(text)) return Promise.resolve([]);
    if (/FROM users/i.test(text)) {
      const addr = values.find(v => typeof v === 'string' && v.includes('@'));
      const hit  = rows.filter(r => String(r.email).toLowerCase() === addr);
      // Model ORDER BY rather than returning fixture order: the anchor row is
      // chosen by it, so a fake that ignored it would let the code depend on
      // however the rows happened to be written in the test.
      if (/ORDER BY id/i.test(text)) hit.sort((a, b) => a.id - b.id);
      return Promise.resolve(hit);
    }
    return Promise.resolve([]);
  };
  sql.queries = queries;

  require.cache[rlPath] = {
    id: rlPath, filename: rlPath, loaded: true,
    exports: { loginLocked: async () => false, countLoginFailure: async () => {}, checkRateLimit: async () => false, clientIp: () => '127.0.0.1', loginOkPrefix: e => `login-ok:${e} ` },
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async slug => ({ id: 1, slug, name: 'Test', config: {} }),
      getSlug: () => '',
      insertAuditLog: async () => {}, trimSongLogs: async () => {},
    },
  };
  require.cache[emailPath] = {
    id: emailPath, filename: emailPath, loaded: true,
    exports: { sendEmail: async (mail) => { sentMail = mail; } },
  };
  require.cache[bcryptPath] = {
    id: bcryptPath, filename: bcryptPath, loaded: true,
    exports: { hash: async (pw, cost) => `hashed:${pw}:${cost}`, compare: async () => false },
  };
  if (Object.keys(tokens).length) {
    const real = require(tokenPath);
    require.cache[tokenPath] = {
      id: tokenPath, filename: tokenPath, loaded: true,
      exports: Object.assign({}, real, tokens),
    };
  }

  sentMail = null;
  return { handler: require(configPath), sql };
}

function mockRes() {
  const r = { _status: 200 };
  r.status = (s) => { r._status = s; return r; };
  r.json   = (b) => { r._body = b; return r; };
  return r;
}

// The action rides in the query, where the route table puts it.
const post = ({ action, ...body }) => ({ method: 'POST', body, headers: { host: 'app.smartist.studio' }, query: { action } });

async function run(r) {
  const { testAsync, assert, assertEq, B } = r;

  console.log(B('\nrequest-reset without a band'));

  await testAsync('a known address is sent a reset link', async () => {
    const { handler } = load({ rows: [{ id: 3, email: VICTIM, role: 'admin', password_hash: 'h' }] });
    const res = mockRes();
    await handler(post({ action: 'request-reset', email: VICTIM }), res);
    assertEq(res._status, 200);
    assert(sentMail, 'no mail sent');
    assert(/#reset=/.test(sentMail.html), `not a reset link: ${sentMail.html}`);
  });

  // An account created through Google has no password hash at all — the very
  // case that sent us here.
  await testAsync('an account with no password gets a link too', async () => {
    const { handler } = load({ rows: [{ id: 3, email: VICTIM, role: 'admin', password_hash: null }] });
    const res = mockRes();
    await handler(post({ action: 'request-reset', email: VICTIM }), res);
    assertEq(res._status, 200);
    assert(sentMail, 'no mail sent to a password-less account');
  });

  // Answering differently for an unknown address turns this into a way to ask
  // which email addresses have accounts here.
  await testAsync('an unknown address answers the same and sends nothing', async () => {
    const { handler } = load({ rows: [] });
    const res = mockRes();
    await handler(post({ action: 'request-reset', email: 'nobody@example.com' }), res);
    assertEq(res._status, 200);
    assertEq(res._body?.ok, true);
    assertEq(sentMail, null);
  });

  console.log(B('\nset-password without a band'));

  await testAsync('the new password reaches every workspace of that address', async () => {
    const { handler, sql } = load({
      rows: [
        { id: 3, email: VICTIM,    role: 'admin',  password_hash: 'h3' },
        { id: 8, email: VICTIM,    role: 'member', password_hash: 'h8' },
        { id: 9, email: NEIGHBOUR, role: 'admin',  password_hash: 'h9' },
      ],
      tokens: { verifyMagicToken: () => true },
    });
    const res = mockRes();
    await handler(post({
      action: 'set-password',
      token: 'tok',
      hint: Buffer.from(VICTIM).toString('base64url'),
      password: 'a-new-password',
    }), res);

    assertEq(res._status, 200);
    assert(res._body?.token, 'no session returned — the person is still locked out');

    const writes = sql.queries.filter(q => /UPDATE users/i.test(q.text));
    assertEq(writes.length, 1);
    const flat = JSON.stringify(writes[0].values);
    assert(flat.includes('hashed:a-new-password'), `stored the raw password: ${flat}`);
    // The statement must name the address, not an artist and not an id — and
    // must not be able to reach the neighbour's row.
    assert(/WHERE email =/i.test(writes[0].text), `write is not scoped by address: ${writes[0].text}`);
    assert(flat.includes(VICTIM), 'write does not name the victim address');
    assert(!flat.includes(NEIGHBOUR), `write names another address: ${flat}`);
  });

  await testAsync('a token that does not verify writes nothing', async () => {
    const { handler, sql } = load({
      rows: [{ id: 3, email: VICTIM, role: 'admin', password_hash: 'h3' }],
      tokens: { verifyMagicToken: () => false },
    });
    const res = mockRes();
    await handler(post({
      action: 'set-password', token: 'bad',
      hint: Buffer.from(VICTIM).toString('base64url'), password: 'a-new-password',
    }), res);
    assertEq(res._status, 400);
    assertEq(sql.queries.filter(q => /UPDATE users/i.test(q.text)).length, 0);
  });

  // The anchor is the lowest id for that address; its hash is the signing seed,
  // which is what makes the link die once a password is set.
  await testAsync('the token is verified against the lowest-id row', async () => {
    let seed = null;
    const { handler } = load({
      rows: [
        { id: 8, email: VICTIM, role: 'member', password_hash: 'h8' },
        { id: 3, email: VICTIM, role: 'admin',  password_hash: 'h3' },
      ],
      tokens: { verifyMagicToken: (_t, s) => { seed = s; return false; } },
    });
    await handler(post({
      action: 'set-password', token: 'tok',
      hint: Buffer.from(VICTIM).toString('base64url'), password: 'a-new-password',
    }), mockRes());
    assertEq(seed, 'h3');
  });

  await testAsync('a short password is refused', async () => {
    const { handler } = load({
      rows: [{ id: 3, email: VICTIM, role: 'admin', password_hash: 'h3' }],
      tokens: { verifyMagicToken: () => true },
    });
    const res = mockRes();
    await handler(post({
      action: 'set-password', token: 'tok',
      hint: Buffer.from(VICTIM).toString('base64url'), password: 'short',
    }), res);
    assertEq(res._status, 400);
  });
}

if (require.main === module) {
  const { makeRunner } = require('./_runner');
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}

module.exports = run;
