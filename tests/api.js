#!/usr/bin/env node
// API integration tests — runs against a live server (local or deployed).
//
// Usage:
//   npm test                                    # needs vercel dev running
//   BASE_URL=https://yourapp.example.com npm test    # against production
//   ARTIST_EMAIL=… ARTIST_PASSWORD=… npm test     # enables reads and write tests

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

/** Load KEY=val lines; only sets `process.env` if unset. Strips quotes like `vercel env pull`. */
function loadEnvFile(absPath) {
  try {
    fs.readFileSync(absPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    });
  } catch { /* missing file is fine */ }
}

// `.env` fills keys not already set from `.env.local` (each line only applies if env[key] is still undefined)
loadEnvFile(path.join(REPO_ROOT, '.env.local'));
loadEnvFile(path.join(REPO_ROOT, '.env'));

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SLUG     = process.env.ARTIST_SLUG;
// Without ?slug= the server answers for its own default band (its ARTIST_SLUG),
// which need not be the one under test.
const CONFIG_URL = `/api/config?slug=${encodeURIComponent(SLUG || '')}`;
const PASSWORD = process.env.ARTIST_PASSWORD;
// The suite logs in as this user and runs on the session token.
const EMAIL    = process.env.ARTIST_EMAIL;
const R2_BASE  = process.env.R2_PUBLIC_URL;

// Workspaces are private: every read below runs with a session. main() logs in
// and sets it when ARTIST_EMAIL and ARTIST_PASSWORD are both given.
let TOKEN = null;
const AUTH = { get token() { return TOKEN; } };

// Vercel Deployment Protection answers every request to a protected preview
// with its own 401 before the app sees it. Its "Protection Bypass for
// Automation" secret, sent as this header, lets the suite through.
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
  : {};

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const G  = s => `\x1b[32m${s}\x1b[0m`;
const R  = s => `\x1b[31m${s}\x1b[0m`;
const Y  = s => `\x1b[33m${s}\x1b[0m`;
const D  = s => `\x1b[2m${s}\x1b[0m`;
const B  = s => `\x1b[1m${s}\x1b[0m`;

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function test(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`  ${G('✓')} ${name} ${D(`${Date.now() - t}ms`)}`);
    passed++;
  } catch (e) {
    console.log(`  ${R('✗')} ${name} ${D(`${Date.now() - t}ms`)}`);
    console.log(`      ${R(e.message)}`);
    failures.push({ name, error: e.message });
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ${D('–')} ${name} ${D(`(${reason})`)}`);
  skipped++;
}

// ── Assertions ───────────────────────────────────────────────────────────────
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertStatus(res, json, expected) {
  if (res.status !== expected)
    throw new Error(`Expected ${expected}, got ${res.status} — ${JSON.stringify(json).slice(0, 120)}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', ...BYPASS };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}

const GET    = (path, opts)       => req('GET',    path, opts);
const POST   = (path, body, opts) => req('POST',   path, { body, ...opts });
const PUT    = (path, body, opts) => req('PUT',    path, { body, ...opts });
const PATCH  = (path, body, opts) => req('PATCH',  path, { body, ...opts });
const DELETE = (path, opts)       => req('DELETE', path, opts);

// Feature keys match resource names (venues, organizers, gigs); gated endpoints return 402 when the plan lacks them.
const planHas = (config, feature) => !!config.plan?.features?.includes(feature);

// Mail the local harness kept instead of sending (tests/harness/server.js), or
// null against a deployment, which sends it for real.
async function outbox(to) {
  const res = await fetch(`${BASE_URL}/__outbox?to=${encodeURIComponent(to.toLowerCase())}`, { headers: BYPASS })
    .catch(() => null);
  const json = res?.ok ? await res.json().catch(() => null) : null;
  return Array.isArray(json?.outbox) ? json.outbox : null;
}

// ── Test sections ─────────────────────────────────────────────────────────────

async function testConfig() {
  console.log(B('\n/api/config'));
  let result = null;

  await test('returns band slug and name', async () => {
    const { res, json } = await GET(CONFIG_URL);
    assertStatus(res, json, 200);
    assert(typeof json.slug === 'string' && json.slug, 'missing slug');
    assert(typeof json.name === 'string' && json.name, 'missing name');
    result = json;
  });

  await test('anonymous config ships songs only for a public catalogue', async () => {
    const { res, json } = await GET(CONFIG_URL);
    assertStatus(res, json, 200);
    if (json.config?.publicCatalogue === true)
      assert(Array.isArray(json.songs), 'public catalogue should ship songs');
    else
      assert(json.songs === undefined, 'a private workspace must not ship songs anonymously');
  });

  await test('anonymous config hides private config keys', async () => {
    const { res, json } = await GET(CONFIG_URL);
    assertStatus(res, json, 200);
    for (const k of ['gemaIpNameNumber', 'upgradedAt'])
      assert(!(k in (json.config || {})), `${k} leaked to an anonymous visitor`);
  });

  if (TOKEN) {
    await test('authenticated config ships the songs array', async () => {
      const { res, json } = await GET(CONFIG_URL, AUTH);
      assertStatus(res, json, 200);
      assert(Array.isArray(json.songs), 'songs not an array');
    });
  }

  await test('unauthenticated config reports role null', async () => {
    const { res, json } = await GET(CONFIG_URL);
    assertStatus(res, json, 200);
    assert('role' in json, 'role field missing');
    assert(json.role === null, `expected role null, got ${JSON.stringify(json.role)}`);
  });

  return result;
}

// ── Anonymous access ─────────────────────────────────────────────────────────
// A workspace is private: without a session every read answers 401, except
// what the band opted into (publicCatalogue, publicStage — both off by default).
async function testPrivacy(slug, config) {
  console.log(B('\nAnonymous access'));
  const cfg = config.config || {};
  const catalogue = cfg.publicCatalogue === true;
  const stage     = cfg.publicStage === true;

  const cases = [
    ['GET songs',              `/api/${slug}/songs`,              catalogue ? 200 : 401],
    ['GET songs/:id',          `/api/${slug}/songs/999999999`,    (stage || catalogue) ? 404 : 401],
    ['GET song-logs',          `/api/${slug}/song-logs`,          401],
    ['GET gigs',               `/api/${slug}/gigs`,               catalogue ? 200 : 401],
    ['GET gigs?format=ics',    `/api/${slug}/gigs?format=ics`,    catalogue ? 200 : 401],
    ['GET gigs?slim=1',        `/api/${slug}/gigs?slim=1`,        401],
    ['GET setlists',           `/api/${slug}/setlists`,           401],
    ['GET setlists/:id',       `/api/${slug}/setlists/999999999`, stage ? 404 : 401],
    ['GET venues',             `/api/${slug}/venues`,             401],
    ['GET songs/:id/gema',     `/api/${slug}/songs/1/gema`,       401],
  ];
  for (const [label, url, want] of cases) {
    await test(`${label} without token → ${want}`, async () => {
      const res = await fetch(`${BASE_URL}${url}`, { headers: BYPASS });
      assert(res.status === want, `Expected ${want}, got ${res.status}`);
    });
  }
}

async function testSongs(slug) {
  console.log(B(`\n/api/${slug}/songs`));
  let firstSong = null;

  // Signed in, the list is the whole catalogue as a plain array; paging
  // ({rows,total,limit}) is only the public-catalogue view.
  await test('GET songs returns the full list with play stats', async () => {
    const { res, json } = await GET(`/api/${slug}/songs`, AUTH);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'expected an array');
    if (json.length) {
      firstSong = json[0];
      assert('play_count' in json[0], 'missing play_count');
      assert('last_played_at' in json[0], 'missing last_played_at');
    }
  });

  if (firstSong) {
    await test('GET /:id returns single song with arrangements → 200', async () => {
      const { res, json } = await GET(`/api/${slug}/songs/${firstSong.id}`, AUTH);
      assertStatus(res, json, 200);
      assert(json.id === firstSong.id, 'id mismatch');
      assert(Array.isArray(json.arrangements), 'missing arrangements array');
    });

    await test('GET /:id/setlists returns appearances', async () => {
      const { res, json } = await GET(`/api/${slug}/songs/${firstSong.id}/setlists`, AUTH);
      assertStatus(res, json, 200);
      assert(Array.isArray(json), 'not an array');
    });
  }

  await test('GET /:id not found → 404', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/999999999`, AUTH);
    assertStatus(res, json, 404);
  });

  await test('GET /:id/setlists with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/0/setlists`, AUTH);
    assertStatus(res, json, 400);
  });

  await test('GET /:id/setlists with non-integer id → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/abc/setlists`, AUTH);
    assertStatus(res, json, 400);
  });

  return firstSong;
}

async function testArrangements(slug, firstSong) {
  console.log(B(`\n/api/${slug}/songs/:id/arrangements`));

  if (!firstSong) {
    skip('arrangement tests', 'no songs available');
    return;
  }

  const sid = firstSong.id;

  await test('GET /:id/arrangements returns array', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/${sid}/arrangements`, AUTH);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'not an array');
  });

  await test('GET /:id/arrangements with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/0/arrangements`, AUTH);
    assertStatus(res, json, 400);
  });

  await test('GET /:id/arrangements with non-integer id → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/abc/arrangements`, AUTH);
    assertStatus(res, json, 400);
  });

  await test('POST /:id/arrangements without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${sid}/arrangements`, { name: 'Test' });
    assertStatus(res, json, 401);
  });

  await test('PUT /:id/arrangements/:arrId without token → 401', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/${sid}/arrangements/1`, { rows: [] });
    assertStatus(res, json, 401);
  });

  await test('DELETE /:id/arrangements/:arrId without token → 401', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/${sid}/arrangements/1`);
    assertStatus(res, json, 401);
  });
}

async function testArrangementWrite(slug, token, song) {
  console.log(B(`\n/api/${slug}/songs/:id/arrangements (write)`));

  const sid = song.id;
  let arr;

  await test('POST /:id/arrangements creates blank version → 201', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${sid}/arrangements`,
      { name: 'Test version' }, { token });
    assertStatus(res, json, 201);
    assert(json.id > 0, 'missing id');
    assert(json.name === 'Test version', 'name mismatch');
    assert(Array.isArray(json.rows),
      `rows not array — typeof=${typeof json.rows} value=${JSON.stringify(json.rows)} full=${JSON.stringify(json)}`);
    assert(typeof json.is_active === 'boolean', 'missing is_active');
    arr = json;
  });

  if (!arr) { skip('arrangement write tests', 'create failed'); return; }

  await test('GET /:id/arrangements returns created version', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/${sid}/arrangements`, AUTH);
    assertStatus(res, json, 200);
    assert(json.some(v => v.id === arr.id), 'created version not in list');
  });

  await test('PUT /:id/arrangements/:arrId updates rows → 200', async () => {
    const rows = [{ structure: 'C1', part: 'A', lead: 'Test', lead_type: 'person',
      harmony: [], licks: '', parts: {}, comment: '' }];
    const { res, json } = await PUT(`/api/${slug}/songs/${sid}/arrangements/${arr.id}`,
      { rows }, { token });
    assertStatus(res, json, 200);
    assert(Array.isArray(json.rows) && json.rows.length === 1, 'rows not updated');
    arr = json;
  });

  await test('PUT /:id/arrangements/:arrId with empty body → 400', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/${sid}/arrangements/${arr.id}`,
      {}, { token });
    assertStatus(res, json, 400);
    assert(json.error, 'missing error message');
  });

  await test('POST /:id/arrangements copy_from duplicates rows → 201', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${sid}/arrangements`,
      { name: 'Copy', copy_from: arr.id }, { token });
    assertStatus(res, json, 201);
    assert(json.id !== arr.id, 'copy has same id');
    assert(json.rows.length === arr.rows.length, 'rows not copied');
  });

  await test('POST /:id/arrangements/:arrId/activate sets is_active → 200', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${sid}/arrangements/${arr.id}/activate`,
      undefined, { token });
    assertStatus(res, json, 200);
    assert(json.is_active === true, 'is_active not set');
  });

  // Clean up all created versions
  await test('DELETE /:id/arrangements/:arrId removes version → 204', async () => {
    const { res, json: list } = await GET(`/api/${slug}/songs/${sid}/arrangements`, AUTH);
    assertStatus(res, list, 200);
    let lastStatus;
    for (const v of list) {
      const r = await DELETE(`/api/${slug}/songs/${sid}/arrangements/${v.id}`, { token });
      lastStatus = r.res.status;
    }
    assert(lastStatus === 204, `Expected 204 on last delete, got ${lastStatus}`);
  });

  await test('GET /:id/arrangements returns empty after all deleted', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/${sid}/arrangements`, AUTH);
    assertStatus(res, json, 200);
    assert(json.length === 0, `expected 0 versions, got ${json.length}`);
  });
}

async function testSongLogs(slug) {
  console.log(B(`\n/api/${slug}/song-logs`));

  let firstLog = null;
  await test('GET returns recent log entries', async () => {
    const { res, json } = await GET(`/api/${slug}/song-logs`, AUTH);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'not an array');
    if (json.length) {
      assert('action' in json[0], 'missing action field');
      assert('song_data' in json[0], 'missing song_data field');
      firstLog = json[0];
    }
  });

  if (firstLog) {
    await test('GET ?songId filters to file actions for that song', async () => {
      const { res, json } = await GET(`/api/${slug}/song-logs?songId=${firstLog.song_id}`, AUTH);
      assertStatus(res, json, 200);
      assert(Array.isArray(json), 'not an array');
      json.forEach(l => assert(l.song_id === firstLog.song_id,
        `unexpected song_id ${l.song_id} in filtered results`));
    });
  }

  await test('GET ?songId=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/song-logs?songId=0`, AUTH);
    assertStatus(res, json, 400);
  });

  await test('GET ?songId=abc → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/song-logs?songId=abc`, AUTH);
    assertStatus(res, json, 400);
  });
}

async function testGigs(slug) {
  console.log(B(`\n/api/${slug}/gigs`));
  let firstGig = null;

  await test('GET gigs returns paginated shape', async () => {
    const { res, json } = await GET(`/api/${slug}/gigs`, AUTH);
    assertStatus(res, json, 200);
    assert(Array.isArray(json.rows), 'json.rows not an array');
    assert(json.rows.length <= json.limit, `expected ≤${json.limit} rows, got ${json.rows?.length}`);
    assert(typeof json.total === 'number', 'json.total not a number');
    assert(typeof json.limit === 'number', 'json.limit not a number');
    assert(typeof json.offset === 'number', 'json.offset not a number');
    if (json.rows.length) firstGig = json.rows[0];
  });

  await test('GET ?limit=1&offset=0 unauthenticated returns paginated shape', async () => {
    const { res, json } = await GET(`/api/${slug}/gigs?limit=1&offset=0`, AUTH);
    assertStatus(res, json, 200);
    assert(Array.isArray(json.rows), 'json.rows not an array');
    assert(typeof json.total === 'number', 'json.total not a number');
    assert(typeof json.limit === 'number', 'json.limit not a number');
  });

  if (firstGig) {
    await test('GET /:id returns gig', async () => {
      const { res, json } = await GET(`/api/${slug}/gigs?id=${firstGig.id}`, AUTH);
      assertStatus(res, json, 200);
      assert(json.id === firstGig.id, 'id mismatch');
      assert('title' in json, 'missing title');
    });

    await test('GET /:id?refs=1 returns gig with setlists/venue/organizer', async () => {
      const { res, json } = await GET(`/api/${slug}/gigs?id=${firstGig.id}&refs=1`, AUTH);
      assertStatus(res, json, 200);
      assert('gig' in json && 'refs' in json, 'missing gig or refs');
      assert(Array.isArray(json.refs.setlists), 'refs.setlists should be array');
      assert('venue' in json.refs, 'missing refs.venue');
      assert('organizer' in json.refs, 'missing refs.organizer');
    });
  }

  // Pickers and filters: every gig, unpaged (the paged list stops at 200).
  await test('GET ?slim=1 returns every gig as a plain array', async () => {
    const [{ res, json }, paged] = await Promise.all([
      GET(`/api/${slug}/gigs?slim=1`, AUTH),
      GET(`/api/${slug}/gigs?limit=1`, AUTH),
    ]);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'slim should return a plain array');
    assert(json.length === paged.json.total, `expected ${paged.json.total} gigs, got ${json.length}`);
    for (const g of json.slice(0, 5)) {
      assert(typeof g.deleted === 'boolean', 'each gig says whether it is deleted');
      assert(!('comment' in g), 'slim rows carry no comment');
    }
  });

  await test('GET /:id with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/gigs?id=0`, AUTH);
    assertStatus(res, json, 400);
  });

  await test('GET /:id not found → 404', async () => {
    const { res, json } = await GET(`/api/${slug}/gigs?id=999999999`, AUTH);
    assertStatus(res, json, 404);
  });

  await test('GET ?format=ics returns iCalendar → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/${slug}/gigs?format=ics`,
      { headers: { ...BYPASS, Authorization: `Bearer ${TOKEN}` } });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert(ct.includes('text/calendar'), `expected text/calendar, got: ${ct}`);
    const body = await res.text();
    assert(body.startsWith('BEGIN:VCALENDAR'), 'not a valid iCalendar response');
  });

  return firstGig;
}

async function testVenues(slug, config) {
  console.log(B(`\n/api/${slug}/venues`));

  if (!planHas(config, 'venues')) {
    await test(`GET on ${config.plan?.key} plan → 402 upgrade_required`, async () => {
      const { res, json } = await GET(`/api/${slug}/venues`, AUTH);
      assertStatus(res, json, 402);
      assert(json.error === 'upgrade_required' && json.feature === 'venues', 'expected upgrade_required for venues');
    });

    await test(`GET /:id on ${config.plan?.key} plan → 402 upgrade_required`, async () => {
      const { res, json } = await GET(`/api/${slug}/venues/999999999`, AUTH);
      assertStatus(res, json, 402);
      assert(json.error === 'upgrade_required' && json.feature === 'venues', 'expected upgrade_required for venues');
    });
    return;
  }

  let firstVenue = null;

  await test('GET returns paginated shape', async () => {
    const { res, json } = await GET(`/api/${slug}/venues`, AUTH);
    assertStatus(res, json, 200);
    assert(Array.isArray(json.rows), 'json.rows not an array');
    assert(typeof json.total === 'number', 'json.total not a number');
    if (json.rows.length) firstVenue = json.rows[0];
  });

  await test('GET ?slim=1 still returns plain array', async () => {
    const { res, json } = await GET(`/api/${slug}/venues?slim=1`, AUTH);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'slim should return plain array');
  });

  await test('GET ?q= filters results', async () => {
    const { res, json } = await GET(`/api/${slug}/venues?q=zzznomatch`, AUTH);
    assertStatus(res, json, 200);
    assert(json.rows.length === 0, 'expected 0 rows for non-matching query');
    assert(json.total === 0, 'expected total 0 for non-matching query');
  });

  if (firstVenue) {
    await test('GET /:id returns venue', async () => {
      const { res, json } = await GET(`/api/${slug}/venues/${firstVenue.id}`, AUTH);
      assertStatus(res, json, 200);
      assert(json.id === firstVenue.id, 'id mismatch');
      assert('name' in json, 'missing name');
    });

    await test('GET /:id?refs=1 returns venue with refs', async () => {
      const { res, json } = await GET(`/api/${slug}/venues/${firstVenue.id}?refs=1`, AUTH);
      assertStatus(res, json, 200);
      assert('venue' in json && 'refs' in json, 'missing venue or refs');
      assert(Array.isArray(json.refs.gigs), 'refs.gigs should be an array');
      if (json.refs.gigs.length > 0) {
        const g = json.refs.gigs[0];
        assert('id' in g && 'title' in g && 'date' in g, 'gig missing id/title/date');
      }
    });
  }

  await test('GET /:id with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/venues/0`, AUTH);
    assertStatus(res, json, 400);
  });

  await test('GET /:id not found → 404', async () => {
    const { res, json } = await GET(`/api/${slug}/venues/999999999`, AUTH);
    assertStatus(res, json, 404);
  });
}

async function testOrganizers(slug) {
  console.log(B(`\n/api/${slug}/organizers`));

  // Organizer records are private CRM data — every read requires auth.
  await test('GET without token → 401', async () => {
    const { res, json } = await GET(`/api/${slug}/organizers`);
    assertStatus(res, json, 401);
  });

  await test('GET ?slim=1 without token → 401', async () => {
    const { res, json } = await GET(`/api/${slug}/organizers?slim=1`);
    assertStatus(res, json, 401);
  });

  await test('GET /:id without token → 401', async () => {
    const { res, json } = await GET(`/api/${slug}/organizers/999999999`);
    assertStatus(res, json, 401);
  });

  await test('GET /:id with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/organizers/0`);
    assertStatus(res, json, 400);
  });
}

async function testSetlists(slug) {
  console.log(B(`\n/api/${slug}/setlists`));
  let firstSetlist = null;

  await test('GET setlists returns array with song_count', async () => {
    const { res, json } = await GET(`/api/${slug}/setlists`, AUTH);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'not an array');
    if (json.length) {
      firstSetlist = json[0];
      assert('song_count' in json[0], 'missing song_count');
    }
  });

  if (firstSetlist) {
    await test('GET /:id returns setlist with ordered songs', async () => {
      const { res, json } = await GET(`/api/${slug}/setlists/${firstSetlist.id}`, AUTH);
      assertStatus(res, json, 200);
      assert(json.id === firstSetlist.id, 'id mismatch');
      assert(Array.isArray(json.songs), 'songs not an array');
    });
  }

  await test('GET /:id with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/setlists/0`, AUTH);
    assertStatus(res, json, 400);
  });

  await test('GET /:id not found → 404', async () => {
    const { res, json } = await GET(`/api/${slug}/setlists/999999999`, AUTH);
    assertStatus(res, json, 404);
  });

  return firstSetlist;
}

async function testAuth(slug) {
  console.log(B('\nAuth'));

  await test('POST /login wrong password → 401', async () => {
    const { res, json } = await POST('/api/login', { email: 'nobody@example.test', password: '__wrong__' });
    assertStatus(res, json, 401);
  });

  // The shared band password is retired: a password alone is no login, and
  // never a bearer token.
  await test('POST /login with a password and no email → 400', async () => {
    const { res, json } = await POST('/api/login', { password: '__anything__' });
    assertStatus(res, json, 400);
  });

  // Signing in goes through /api/login alone; the band's members endpoint only
  // manages its members.
  await test('POST /members without an action is not a login → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/members`, { email: 'nobody@example.test', password: '__wrong__' });
    assertStatus(res, json, 401);
  });

  if (PASSWORD) await test('a password as the bearer token → 401', async () => {
    const { res, json } = await GET(`/api/${slug}/songs`, { token: PASSWORD });
    assertStatus(res, json, 401);
  });

  // The signed-in path ends the shared test user's sessions, so it is covered
  // by tests/unit/login_handler.js, not here.
  await test('POST logout-everywhere without token → 401', async () => {
    const { res, json } = await POST('/api/config', { action: 'logout-everywhere' });
    assertStatus(res, json, 401);
  });

  await test('POST /login empty body → 400', async () => {
    const { res, json } = await POST('/api/login', {});
    assertStatus(res, json, 400);
  });

  await test('POST /songs without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/songs`, { title: 'x' });
    assertStatus(res, json, 401);
  });

  await test('PATCH /songs without token → 401', async () => {
    const { res, json } = await PATCH(`/api/${slug}/songs`, [{ id: 1, title: 'x' }]);
    assertStatus(res, json, 401);
  });

  await test('DELETE /songs/:id without token → 401', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/1`);
    assertStatus(res, json, 401);
  });

  await test('POST /setlists without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/setlists`, { song_ids: [1] });
    assertStatus(res, json, 401);
  });

  await test('GET /export without token → 401', async () => {
    const { res, json } = await GET(`/api/${slug}/export`);
    assertStatus(res, json, 401);
  });

  await test('POST /setlists/:id/share without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/setlists/1/share`, { email: 'test@example.com' });
    assertStatus(res, json, 401);
  });

  await test('PUT /setlists/:id without token → 401', async () => {
    const { res, json } = await PUT(`/api/${slug}/setlists/1`, { title: 'x', song_ids: [] });
    assertStatus(res, json, 401);
  });

  // File endpoints auth
  for (const type of ['audio', 'sheet', 'playback']) {
    await test(`POST /songs/1/${type} without token → 401`, async () => {
      const { res, json } = await POST(`/api/${slug}/songs/1/${type}`, { filename: 'x.mp3' });
      assertStatus(res, json, 401);
    });
    await test(`PUT /songs/1/${type} without token → 401`, async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/1/${type}`, { publicUrl: 'x' });
      assertStatus(res, json, 401);
    });
    await test(`DELETE /songs/1/${type} without token → 401`, async () => {
      const { res, json } = await DELETE(`/api/${slug}/songs/1/${type}`);
      assertStatus(res, json, 401);
    });
  }

  await test('PUT /songs/:id/lyrics without token → 401', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/1/lyrics`, { lyrics: 'x' });
    assertStatus(res, json, 401);
  });
  await test('DELETE /songs/:id/lyrics without token → 401', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/1/lyrics`);
    assertStatus(res, json, 401);
  });
  await test('POST /songs/:id/lyrics/suggest without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/1/lyrics/suggest`);
    assertStatus(res, json, 401);
  });

  // Gigs, venues, organizers auth. A single gig is addressed as ?id=N — gigs.js serves
  // the collection and the item in one serverless function.
  for (const resource of ['gigs', 'venues', 'organizers']) {
    const body = resource === 'gigs' ? { title: 'x' } : { name: 'x' };
    const itemUrl = resource === 'gigs' ? `/api/${slug}/gigs?id=1` : `/api/${slug}/${resource}/1`;
    await test(`POST /${resource} without token → 401`, async () => {
      const { res, json } = await POST(`/api/${slug}/${resource}`, body);
      assertStatus(res, json, 401);
    });
    await test(`PUT /${resource} item without token → 401`, async () => {
      const { res, json } = await PUT(itemUrl, body);
      assertStatus(res, json, 401);
    });
    await test(`DELETE /${resource} item without token → 401`, async () => {
      const { res, json } = await DELETE(itemUrl);
      assertStatus(res, json, 401);
    });
  }

  // Setlist DELETE auth
  await test('DELETE /setlists/:id without token → 401', async () => {
    const { res, json } = await DELETE(`/api/${slug}/setlists/1`);
    assertStatus(res, json, 401);
  });

  // Config PATCH auth
  await test('PATCH /config without token → 401', async () => {
    const { res, json } = await PATCH(CONFIG_URL, { name: 'x' });
    assertStatus(res, json, 401);
  });

  // Email change: request needs a session, confirm needs a valid token.
  await test('POST request-email-change without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/members/request-email-change`,
      { currentPassword: 'x'.repeat(8), newEmail: 'someone@example.com' });
    assertStatus(res, json, 401);
  });

  await test('POST confirm-email-change without a token → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/members/confirm-email-change`, {});
    assertStatus(res, json, 400);
  });

  await test('POST confirm-email-change with a garbage token → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/members/confirm-email-change`,
      { token: 'e'.repeat(64) });
    assertStatus(res, json, 400);
  });
}

// ── Multi-user auth ──────────────────────────────────────────────────────────

async function testMultiUserAuth(slug, token) {
  console.log(B('\nMulti-user auth'));

  const TEST_EMAIL = '[TEST]user_' + Date.now() + '@example.com';
  let _testUserId = null;

  // GET /members — list users (bootstrap admin can access)
  await test('GET /members lists users', async () => {
    const { res, json } = await GET(`/api/${slug}/members`, { token });
    assertStatus(res, json, 200);
    assert(Array.isArray(json.users), 'users is an array');
  });

  // POST /members/invite — create pending user
  await test('POST /members/invite creates pending user → 201', async () => {
    const { res, json } = await POST(`/api/${slug}/members/invite`,
      { email: TEST_EMAIL, role: 'member' }, { token });
    // 500 "Failed to send invite email" = email not configured locally; user is rolled back
    if (res.status === 500 && json?.error === 'Failed to send invite email') {
      console.log('    (email not configured locally — invite rolled back, skipping invite flow)');
      return;
    }
    assertStatus(res, json, 201);
    _testUserId = json.user?.id;
    assert(_testUserId, 'invite returns user id');
  });

  await test('POST invite duplicate email → 409', async () => {
    if (!_testUserId) { console.log('    (skipped — no pending user)'); return; }
    const { res, json } = await POST(`/api/${slug}/members/invite`,
      { email: TEST_EMAIL, role: 'member' }, { token });
    assertStatus(res, json, 409);
  });

  if (_testUserId) {
    await test('POST resend-invite → 200', async () => {
      const { res, json } = await POST(`/api/${slug}/members/resend-invite`,
        { userId: _testUserId }, { token });
      assertStatus(res, json, 200);
    });
  }

  await test('POST resend-invite non-existent userId → 404', async () => {
    const { res, json } = await POST(`/api/${slug}/members/resend-invite`,
      { userId: 999999 }, { token });
    assertStatus(res, json, 404);
  });

  // accept-invite with garbage token → 400
  await test('POST /members/accept-invite with garbage token → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/members/accept-invite`,
      { token: 'garbage', password: 'somepassword' });
    assertStatus(res, json, 400);
  });

  await test('POST accept-invite short password → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/members/accept-invite`,
      { token: 'any', password: 'short' });
    assertStatus(res, json, 400);
  });

  // PUT — update role
  if (_testUserId) {
    await test('PUT updates user role → 200', async () => {
      const { res, json } = await PUT(`/api/${slug}/members`,
        { userId: _testUserId, role: 'viewer' }, { token });
      assertStatus(res, json, 200);
      assert(json.user?.role === 'viewer', 'role updated');
    });
  }

  // Login email is the cross-workspace identity — admins must not be able to rewrite it.
  await test('PUT with email → 400', async () => {
    const { res, json } = await PUT(`/api/${slug}/members`,
      { userId: _testUserId || 999999, email: 'hijack@example.com' }, { token });
    assertStatus(res, json, 400);
  });

  await test('PUT without role → 400', async () => {
    const { res, json } = await PUT(`/api/${slug}/members`,
      { userId: 999999 }, { token });
    assertStatus(res, json, 400);
  });

  // POST /members/change-password
  await test('POST change-password without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/members/change-password`,
      { currentPassword: 'a'.repeat(8), newPassword: 'b'.repeat(8) });
    assertStatus(res, json, 401);
  });

  await test('POST change-password short newPassword → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/members/change-password`,
      { currentPassword: 'a'.repeat(8), newPassword: 'short' }, { token });
    assertStatus(res, json, 400);
  });

  await test('POST change-password missing fields → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/members/change-password`,
      {}, { token });
    assertStatus(res, json, 400);
  });

  // POST login with email — wrong password → 401
  await test('POST email login rejects bad credentials → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/members`,
      { email: 'nobody@example.com', password: 'wrongpassword' });
    assertStatus(res, json, 401);
  });

  await test('POST email login missing password → 400', async () => {
    const { res, json } = await POST('/api/login', { email: 'test@example.com' });
    assertStatus(res, json, 400);
  });

  await test('GET /members without token → 401', async () => {
    const { res, json } = await GET(`/api/${slug}/members`);
    assertStatus(res, json, 401);
  });

  await test('POST invite without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/members/invite`,
      { email: 'x@example.com', role: 'member' });
    assertStatus(res, json, 401);
  });

  await test('PUT role without token → 401', async () => {
    const { res, json } = await PUT(`/api/${slug}/members`,
      { userId: 1, role: 'viewer' });
    assertStatus(res, json, 401);
  });

  await test('DELETE without token → 401', async () => {
    const { res, json } = await DELETE(`/api/${slug}/members`,
      { body: { userId: 1 } });
    assertStatus(res, json, 401);
  });

  await test('POST invite missing email → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/members/invite`,
      { role: 'member' }, { token });
    assertStatus(res, json, 400);
  });

  await test('POST invite invalid role → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/members/invite`,
      { email: 'x@example.com', role: 'superuser' }, { token });
    assertStatus(res, json, 400);
  });

  // DELETE — clean up test user
  if (_testUserId) {
    await test('DELETE removes test user → 200', async () => {
      const { res, json } = await DELETE(`/api/${slug}/members`,
        { body: { userId: _testUserId }, token });
      assertStatus(res, json, 200);
    });
  }
}

// The feed calendar apps subscribe to: a timed and an all-day gig, dates in
// the iCalendar form (YYYYMMDD), text escaped.
async function testIcsFeed(slug, token) {
  console.log(B('\niCalendar feed'));
  const made = [];
  await test('GET ?format=ics lists upcoming gigs with iCalendar dates', async () => {
    for (const body of [
      { title: '[TEST] Club, Night; late', date: '2099-12-31', time_start: '20:30' },
      { title: '[TEST] All day', date: '2099-12-31' },
    ]) {
      const { res, json } = await POST(`/api/${slug}/gigs`, body, { token });
      assertStatus(res, json, 201);
      made.push(json.id);
    }
    const res = await fetch(`${BASE_URL}/api/${slug}/gigs?format=ics`,
      { headers: { ...BYPASS, Authorization: `Bearer ${token}` } });
    const ics = await res.text();
    const event = id => (ics.split('BEGIN:VEVENT').find(e => e.includes(`UID:gig-${id}@`)) || '');
    const [timed, allDay] = made.map(event);
    assert(timed.includes('DTSTART:20991231T203000\r\n'), `timed start: ${timed.slice(0, 120)}`);
    assert(timed.includes('DTEND:20991231T223000\r\n'), 'timed end is two hours later');
    assert(timed.includes('SUMMARY:[TEST] Club\\, Night\\; late'), 'summary not escaped');
    assert(allDay.includes('DTSTART;VALUE=DATE:20991231\r\n'), `all-day start: ${allDay.slice(0, 120)}`);
    assert(allDay.includes('DTEND;VALUE=DATE:21000101\r\n'), 'all-day end is the next day');
  });
  for (const id of made)
    await DELETE(`/api/${slug}/gigs?id=${id}`, { body: { hard: true }, token });
}

// ── Sessions, roles and tenancy on the real database ──────────────────────────
// The unit suites stub the membership query; these run it. They need a second
// person with a password, so they invite one — which takes the mailed link, so
// only on the local stack (outbox). Never the admin the suite signs in as: the
// last steps end every session of the account.
async function testSessions(slug, adminToken) {
  console.log(B('\nSessions, roles and tenancy'));

  const email = `[test]member_${Date.now()}@example.test`;
  if (!await outbox(email)) return skip('sessions, roles and tenancy', 'needs the local stack\'s mail outbox');

  const pw1 = 'first-password-1', pw2 = 'second-password-2';
  const songs = t => GET(`/api/${slug}/songs`, { token: t });
  const login = password => POST('/api/login', { email, password });
  let userId, first, second;

  await test('an invited member accepts the mailed link and is signed in', async () => {
    const inv = await POST(`/api/${slug}/members/invite`, { email, role: 'member' }, { token: adminToken });
    assertStatus(inv.res, inv.json, 201);
    userId = inv.json.user.id;
    const [mail] = await outbox(email);
    const link = /#invite=([\w-]+)/.exec(mail?.html || '');
    assert(link, 'no invite link in the mail');
    const { res, json } = await POST(`/api/${slug}/members/accept-invite`, { token: link[1], password: pw1 });
    assertStatus(res, json, 200);
    first = json.token;
    const r = await songs(first);
    assertStatus(r.res, r.json, 200);
  });
  if (!first) return;

  await test('a member is refused the admin endpoints → 403', async () => {
    const users = await GET(`/api/${slug}/members`, { token: first });
    assertStatus(users.res, users.json, 403);
    const cfg = await PATCH(CONFIG_URL, { config: { _test: null } }, { token: first });
    assertStatus(cfg.res, cfg.json, 403);
  });

  await test('the role comes from the database, not the token', async () => {
    const down = await PUT(`/api/${slug}/members`, { userId, role: 'viewer' }, { token: adminToken });
    assertStatus(down.res, down.json, 200);
    const { res, json } = await POST(`/api/${slug}/songs`, { title: '[TEST] viewer write' }, { token: first });
    const up = await PUT(`/api/${slug}/members`, { userId, role: 'member' }, { token: adminToken });
    assertStatus(res, json, 403);
    assertStatus(up.res, up.json, 200);
  });

  const other = process.env.DEMO_ARTIST_SLUG || 'demo';
  if ((await GET(`/api/config?slug=${other}`)).json?.slug !== other) {
    skip('sessions of one band open no other band', `no band "${other}" here`);
  } else {
    await test('sessions of one band open no other band → 401', async () => {
      for (const t of [first, adminToken]) {
        const read = await GET(`/api/${other}/songs`, { token: t });
        assertStatus(read.res, read.json, 401);
        const write = await POST(`/api/${other}/songs`, { title: '[TEST] cross-band' }, { token: t });
        assertStatus(write.res, write.json, 401);
      }
    });
  }

  await test('a password change ends the old session and the old password', async () => {
    const { res, json } = await POST(`/api/${slug}/members/change-password`,
      { currentPassword: pw1, newPassword: pw2 }, { token: first });
    assertStatus(res, json, 200);
    second = json.token;
    assertStatus((await songs(first)).res, null, 401);
    assertStatus((await songs(second)).res, null, 200);
    assertStatus((await login(pw1)).res, null, 401);
  });

  await test('log out everywhere ends every session, a new sign-in works', async () => {
    const signedIn = await login(pw2);
    assertStatus(signedIn.res, signedIn.json, 200);
    const { res, json } = await POST('/api/config', { action: 'logout-everywhere' }, { token: second });
    assertStatus(res, json, 200);
    assertStatus((await songs(second)).res, null, 401);
    assertStatus((await songs(signedIn.json.token)).res, null, 401);
    const again = await login(pw2);
    assertStatus(again.res, again.json, 200);
    second = again.json.token;
    assertStatus((await songs(second)).res, null, 200);
  });

  await test('a removed member\'s session opens nothing → 401', async () => {
    const { res, json } = await DELETE(`/api/${slug}/members`, { body: { userId }, token: adminToken });
    assertStatus(res, json, 200);
    assertStatus((await songs(second)).res, null, 401);
  });
}

// ── File endpoint tests ───────────────────────────────────────────────────────

// The public demo gate hands anybody a member session on the demo band. It
// may edit songs, but nothing that reaches outside the band: no email to an
// arbitrary address, no files in the bucket.
async function testDemoGate() {
  console.log(B('\nDemo gate'));
  const { json: gate } = await POST('/api/config', { email: `demo-${Date.now()}@example.test`, source: 'demo' });
  if (!gate?.token) return skip('demo gate', 'no demo band on this deployment');
  const demo = gate.slug, token = gate.token;
  const { json: songs } = await GET(`/api/${demo}/songs`, { token });
  const songId = Array.isArray(songs) ? songs[0]?.id : songs?.rows?.[0]?.id;
  await test('demo session can read the demo band', async () => {
    assert(songId, 'no song visible to the demo session');
  });
  await test('demo session cannot email a setlist → 403 demo_readonly', async () => {
    const { res, json } = await POST(`/api/${demo}/setlists/1/share`, { email: 'someone@example.test' }, { token });
    assertStatus(res, json, 403);
    assert(json.code === 'demo_readonly', `expected demo_readonly, got ${json.code}`);
  });
  await test('demo session cannot get an upload URL → 403 demo_readonly', async () => {
    const { res, json } = await POST(`/api/${demo}/songs/${songId}/sheet`,
      { filename: 'x.pdf', size: 1000 }, { token });
    assertStatus(res, json, 403);
  });
  await test('demo session is not an admin: settings stay closed → 403', async () => {
    const { res, json } = await PATCH(`/api/config?slug=${encodeURIComponent(demo)}`, { name: 'Hijacked' }, { token });
    assertStatus(res, json, 403);
  });
}

// Band logo and favicon: the band comes from ?slug= (a multi-tenant deployment
// has no ARTIST_SLUG), and the size is required because it is signed into the
// upload URL — these images do not count towards the storage cap.
async function testImageUploadUrls(slug) {
  console.log(B('\nImage upload URLs'));
  if (!R2_BASE) return skip('photo/favicon upload URLs', 'R2_PUBLIC_URL not set');
  const url = (action, q) => `/api/config?action=${action}&slug=${encodeURIComponent(slug)}${q}`;
  await test('photo-url without size → 400', async () => {
    const { res, json } = await GET(url('photo-url', '&type=image/png'), AUTH);
    assertStatus(res, json, 400);
  });
  await test('photo-url over 5 MB → 400', async () => {
    const { res, json } = await GET(url('photo-url', `&type=image/png&size=${6 * 1024 * 1024}`), AUTH);
    assertStatus(res, json, 400);
  });
  await test('favicon-url with type and size → 200 with an upload URL', async () => {
    const { res, json } = await GET(url('favicon-url', '&type=image/png&size=2048'), AUTH);
    assertStatus(res, json, 200);
    assert(json.uploadUrl && json.publicUrl, 'expected uploadUrl and publicUrl');
  });
}

async function testFileIdValidation(slug) {
  console.log(B('\nFile endpoint ID validation'));

  for (const type of ['audio', 'sheet', 'playback']) {
    await test(`POST /songs/0/${type} → 400`, async () => {
      const { res, json } = await POST(`/api/${slug}/songs/0/${type}`, {});
      assertStatus(res, json, 400);
    });
    await test(`DELETE /songs/abc/${type} → 400`, async () => {
      const { res, json } = await DELETE(`/api/${slug}/songs/abc/${type}`);
      assertStatus(res, json, 400);
    });
  }
}

async function testFileValidation(slug, token, songId) {
  console.log(B('\nFile upload validation'));

  // ── audio ──────────────────────────────────────────────────────────────────
  await test('POST /audio missing filename → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/audio`,
      { contentType: 'audio/mpeg', size: 1000 }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /audio unsupported extension → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/audio`,
      { filename: 'track.exe', contentType: 'audio/mpeg', size: 1000 }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /audio wrong contentType → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/audio`,
      { filename: 'track.mp3', contentType: 'video/mp4', size: 1000 }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /audio missing size → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/audio`,
      { filename: 'track.mp3', contentType: 'audio/mpeg' }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /audio size too large → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/audio`,
      { filename: 'track.mp3', contentType: 'audio/mpeg', size: 100 * 1024 * 1024 }, { token });
    assertStatus(res, json, 400);
  });

  // ── sheet ──────────────────────────────────────────────────────────────────
  await test('POST /sheet missing filename → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/sheet`,
      { size: 1000 }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /sheet wrong extension → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/sheet`,
      { filename: 'chords.docx', size: 1000 }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /sheet missing size → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/sheet`,
      { filename: 'chords.pdf' }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /sheet size too large → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/sheet`,
      { filename: 'chords.pdf', size: 30 * 1024 * 1024 }, { token });
    assertStatus(res, json, 400);
  });

  // ── playback ───────────────────────────────────────────────────────────────
  await test('POST /playback missing filename → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/playback`,
      { contentType: 'audio/mpeg', size: 1000 }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /playback unsupported extension → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/playback`,
      { filename: 'track.mp4', contentType: 'audio/mpeg', size: 1000 }, { token });
    assertStatus(res, json, 400);
  });
  await test('POST /playback missing size → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/${songId}/playback`,
      { filename: 'backing.mp3', contentType: 'audio/mpeg' }, { token });
    assertStatus(res, json, 400);
  });

  // ── PUT publicUrl validation (needs R2_PUBLIC_URL to construct valid-looking URLs) ──
  if (R2_BASE) {
    await test('PUT /audio non-R2 publicUrl → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/${songId}/audio`,
        { publicUrl: 'https://evil.example.com/malware.exe' }, { token });
      assertStatus(res, json, 400);
    });
    await test('PUT /audio wrong key prefix → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/${songId}/audio`,
        { publicUrl: `${R2_BASE}/sheets/fake.mp3` }, { token });
      assertStatus(res, json, 400);
    });
    // Keys are scoped to the band (`audio/<artist id>/…`); an unscoped key is
    // refused before the song is even looked up.
    await test('PUT /audio unscoped key → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/999999999/audio`,
        { publicUrl: `${R2_BASE}/audio/fake.mp3` }, { token });
      assertStatus(res, json, 400);
    });

    await test('PUT /sheet wrong key prefix → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/${songId}/sheet`,
        { publicUrl: `${R2_BASE}/audio/fake.pdf` }, { token });
      assertStatus(res, json, 400);
    });
    // Keys are scoped to the band (`sheets/<artist id>/…`); an unscoped key is
    // refused before the song is even looked up.
    await test('PUT /sheet unscoped key → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/999999999/sheet`,
        { publicUrl: `${R2_BASE}/sheets/fake.pdf` }, { token });
      assertStatus(res, json, 400);
    });

    await test('PUT /playback wrong key prefix → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/${songId}/playback`,
        { publicUrl: `${R2_BASE}/audio/fake.mp3` }, { token });
      assertStatus(res, json, 400);
    });
    // Keys are scoped to the band (`playback/<artist id>/…`); an unscoped key is
    // refused before the song is even looked up.
    await test('PUT /playback unscoped key → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/999999999/playback`,
        { publicUrl: `${R2_BASE}/playback/fake.mp3` }, { token });
      assertStatus(res, json, 400);
    });

    // Presigned URL generation — verifies R2 client is wired correctly
    await test('POST /audio valid params → 200 with uploadUrl + publicUrl', async () => {
      const { res, json } = await POST(`/api/${slug}/songs/${songId}/audio`,
        { filename: 'test.mp3', contentType: 'audio/mpeg', size: 1000 }, { token });
      assertStatus(res, json, 200);
      assert(typeof json.uploadUrl === 'string' && json.uploadUrl.startsWith('https://'), 'bad uploadUrl');
      assert(json.publicUrl.startsWith(`${R2_BASE}/audio/`), 'publicUrl has wrong prefix');
    });
    await test('POST /sheet valid params → 200 with uploadUrl + publicUrl', async () => {
      const { res, json } = await POST(`/api/${slug}/songs/${songId}/sheet`,
        { filename: 'chords.pdf', size: 1000 }, { token });
      assertStatus(res, json, 200);
      assert(typeof json.uploadUrl === 'string' && json.uploadUrl.startsWith('https://'), 'bad uploadUrl');
      assert(json.publicUrl.startsWith(`${R2_BASE}/sheets/`), 'publicUrl has wrong prefix');
    });
    await test('POST /playback valid params → 200 with uploadUrl + publicUrl', async () => {
      const { res, json } = await POST(`/api/${slug}/songs/${songId}/playback`,
        { filename: 'backing.mp3', contentType: 'audio/mpeg', size: 1000 }, { token });
      assertStatus(res, json, 200);
      assert(typeof json.uploadUrl === 'string' && json.uploadUrl.startsWith('https://'), 'bad uploadUrl');
      assert(json.publicUrl.startsWith(`${R2_BASE}/playback/`), 'publicUrl has wrong prefix');
    });

    // DELETE on a song with no file — idempotent, always 200
    await test('DELETE /audio on song without file → 200', async () => {
      const { res, json } = await DELETE(`/api/${slug}/songs/${songId}/audio`, { token });
      assertStatus(res, json, 200);
      assert(json.ok === true, 'expected ok:true');
    });
    await test('DELETE /sheet on song without file → 200', async () => {
      const { res, json } = await DELETE(`/api/${slug}/songs/${songId}/sheet`, { token });
      assertStatus(res, json, 200);
      assert(json.ok === true, 'expected ok:true');
    });
    await test('DELETE /playback on song without file → 200', async () => {
      const { res, json } = await DELETE(`/api/${slug}/songs/${songId}/playback`, { token });
      assertStatus(res, json, 200);
      assert(json.ok === true, 'expected ok:true');
    });
  } else {
    skip('PUT /audio|sheet|playback URL validation', 'R2_PUBLIC_URL not set');
    skip('POST /audio|sheet|playback presigned URL', 'R2_PUBLIC_URL not set');
    skip('DELETE /audio|sheet|playback idempotent', 'R2_PUBLIC_URL not set');
  }
}

async function testLyricsLifecycle(slug, token, songId) {
  console.log(B('\nLyrics lifecycle'));

  // Validation
  await test('PUT /songs/:id/lyrics wrong body key → 400', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/${songId}/lyrics`,
      { text: 'wrong key' }, { token });
    assertStatus(res, json, 400);
  });
  await test('PUT /songs/:id/lyrics too long → 400', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/${songId}/lyrics`,
      { lyrics: 'x'.repeat(20001) }, { token });
    assertStatus(res, json, 400);
  });
  await test('DELETE /songs/:id/lyrics nonexistent song → 404', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/999999999/lyrics`, { token });
    assertStatus(res, json, 404);
  });

  // Full round-trip
  const testLyrics = 'Verse 1\nSecond line\n\nChorus\nSing along';

  await test('PUT /songs/:id/lyrics saves text → 200', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/${songId}/lyrics`,
      { lyrics: testLyrics }, { token });
    assertStatus(res, json, 200);
    assert(json.ok === true, 'expected ok:true');
  });

  await test('GET /songs/:id reflects saved lyrics', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/${songId}`, AUTH);
    assertStatus(res, json, 200);
    assert(json.lyrics === testLyrics.trim(),
      `lyrics mismatch — got: ${JSON.stringify(json.lyrics)}`);
    assert(json.has_lyrics === true, 'has_lyrics should be true');
    assert(!json.extra?.lyrics, 'lyrics must not be stored in extra any more');
  });

  await test('GET /songs list carries has_lyrics, not the text', async () => {
    const { res, json } = await GET(`/api/${slug}/songs`, AUTH);
    assertStatus(res, json, 200);
    const row = json.find(s => s.id === songId);
    assert(row, 'song missing from list');
    assert(row.has_lyrics === true, 'has_lyrics should be true in the list');
    assert(row.lyrics === undefined && !row.extra?.lyrics, 'list must not carry lyrics text');
  });

  await test('GET /songs?lyrics=1 adds the text (CSV export)', async () => {
    const { res, json } = await GET(`/api/${slug}/songs?lyrics=1`, AUTH);
    assertStatus(res, json, 200);
    const row = json.find(s => s.id === songId);
    assert(row?.lyrics === testLyrics.trim(), `lyrics mismatch — got: ${JSON.stringify(row?.lyrics)}`);
  });

  await test('lyrics edits are in the audit log', async () => {
    const { res, json } = await GET(`/api/${slug}/song-logs`, AUTH);
    assertStatus(res, json, 200);
    assert(json.some(l => l.song_id === songId && l.action === 'lyrics_update'),
      'expected a lyrics_update entry');
  });

  await test('PATCH /songs writes language as a column', async () => {
    const { res, json } = await PATCH(`/api/${slug}/songs`, [{ id: songId, language: 'fr' }], { token });
    assertStatus(res, json, 200);
    const { json: song } = await GET(`/api/${slug}/songs/${songId}`, AUTH);
    assert(song.language === 'FR', `language — got: ${JSON.stringify(song.language)}`);
    assert(!song.extra?.language, 'language must not be stored in extra');
  });

  await test('PATCH /songs accepts language inside extra from older clients', async () => {
    const { res, json } = await PATCH(`/api/${slug}/songs`, [{ id: songId, extra: { language: 'DE' } }], { token });
    assertStatus(res, json, 200);
    const { json: song } = await GET(`/api/${slug}/songs/${songId}`, AUTH);
    assert(song.language === 'DE', `language — got: ${JSON.stringify(song.language)}`);
    assert(!song.extra?.language, 'language must not be stored in extra');
  });

  await test('DELETE /songs/:id/lyrics clears field → 200', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/${songId}/lyrics`, { token });
    assertStatus(res, json, 200);
    assert(json.ok === true, 'expected ok:true');
  });

  await test('GET /songs/:id confirms lyrics removed', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/${songId}`, AUTH);
    assertStatus(res, json, 200);
    assert(!json.lyrics && json.has_lyrics === false,
      `expected no lyrics, got: ${JSON.stringify(json.lyrics)}`);
  });

  await test('DELETE /songs/:id/lyrics again (already empty) → 200', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/${songId}/lyrics`, { token });
    assertStatus(res, json, 200);
    assert(json.ok === true, 'expected ok:true');
  });
}

async function testSetlistShareValidation(slug, token, setlistId) {
  console.log(B('\nSetlist share validation'));

  await test('POST /setlists/:id/share + invalid email → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/setlists/${setlistId}/share`,
      { email: 'not-an-email' }, { token });
    assertStatus(res, json, 400);
  });

  await test('POST /setlists/:id/share + unknown setlist → 404', async () => {
    const { res, json } = await POST(`/api/${slug}/setlists/999999999/share`,
      { email: 'test@example.com' }, { token });
    assertStatus(res, json, 404);
  });

  if (!await outbox('share@example.test')) return skip('setlist share mail', 'mail is sent for real here');
  await test('POST /setlists/:id/share mails the setlist as a PDF → 200', async () => {
    const { res, json } = await POST(`/api/${slug}/setlists/${setlistId}/share`,
      { email: 'share@example.test' }, { token });
    assertStatus(res, json, 200);
    const [mail] = (await outbox('share@example.test')).slice(-1);
    const pdf = Buffer.from(mail?.attachments?.[0]?.content || '', 'base64');
    assert(pdf.subarray(0, 5).toString() === '%PDF-', 'attachment is not a PDF');
    assert(/^1\. /m.test(mail.text), 'mail text does not list the songs');
  });
}

// CSV import: a file is only checked; a commit is refused while a row needs
// attention and writes the rest once it is skipped.
async function testSongImport(slug, token, firstSong, atLimit) {
  const csv = `title,key,length\n[TEST] Import,Bb,3:30\n[TEST] Bad key,Q,\n${firstSong ? `"${firstSong.title.replace(/"/g, '""')}",,` : ''}\n`;
  let rows;
  await test('POST /songs/import {csv} → 200, checked, nothing written', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/import`, { csv }, { token });
    assertStatus(res, json, 200);
    assert(json.rows[0].status === 'ready' && json.rows[0].values.key === 'B♭', `row 1 — got ${JSON.stringify(json.rows[0])}`);
    assert(json.rows[1].errors.key?.code === 'key', 'bad key flagged');
    if (firstSong) assert(json.rows[2].duplicate?.of === 'song', 'existing title flagged as duplicate');
    rows = json.rows;
  });
  if (!rows) return;
  await test('POST /songs/import commit with a flagged row → 422', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/import`, { rows, commit: true }, { token });
    assertStatus(res, json, 422);
  });
  if (atLimit) { skip('POST /songs/import commit → 201', 'band at song limit'); return; }
  await test('POST /songs/import commit, flagged rows skipped → 201', async () => {
    const send = rows.map(r => ({ line: r.line, values: r.values, skip: r.status !== 'ready' }));
    const { res, json } = await POST(`/api/${slug}/songs/import`, { rows: send, commit: true }, { token });
    assertStatus(res, json, 201);
    assert(json.imported === 1, `imported — got ${json.imported}`);
    const { json: list } = await GET(`/api/${slug}/songs`, { token });
    const song = list.find(x => x.title === '[TEST] Import');
    assert(song && song.key === 'B♭' && Number(song.length_min) === 3.5, `stored — got ${JSON.stringify(song)}`);
    await DELETE(`/api/${slug}/songs/${song.id}`, { token });
  });
}

async function testWrite(slug, token, firstSong, config) {
  console.log(B('\nWrite ops'));

  // Verify password
  let authed = false;
  await test('POST /login with correct password → 200', async () => {
    const { res, json } = await POST('/api/login', { email: EMAIL, password: PASSWORD });
    assertStatus(res, json, 200);
    assert(json.ok === true, 'expected ok:true');
    authed = true;
  });

  if (!authed) {
    console.log(R('  Aborting write tests — password rejected'));
    return;
  }

  // Song lifecycle — fully reversible
  let song;

  const songLimit = config.plan?.limits?.songs;
  if (songLimit != null && config.usage?.songs >= songLimit) {
    await test(`POST /songs at ${songLimit}-song limit → 402 song_limit`, async () => {
      const { res, json } = await POST(`/api/${slug}/songs`,
        { title: '[TEST] Temporary', key: 'G', active: false }, { token });
      assertStatus(res, json, 402);
      assert(json.error === 'song_limit' && json.limit === songLimit, 'expected song_limit');
    });
    skip('POST /songs creates song → 201', 'band at song limit');
    skip('POST /songs missing title → 400', 'band at song limit');
  } else {
    await test('POST /songs creates song → 201', async () => {
      const { res, json } = await POST(`/api/${slug}/songs`,
        { title: '[TEST] Temporary', key: 'G', active: false }, { token });
      assertStatus(res, json, 201);
      assert(json.id > 0, 'missing id');
      assert(json.title === '[TEST] Temporary', 'title mismatch');
      song = json;
    });

    await test('POST /songs missing title → 400', async () => {
      const { res, json } = await POST(`/api/${slug}/songs`, { key: 'G' }, { token });
      assertStatus(res, json, 400);
      assert(json.error, 'missing error message');
    });
  }

  if (song) {
    await test('PATCH /songs updates song → 200', async () => {
      const { res, json } = await PATCH(`/api/${slug}/songs`,
        [{ ...song, title: '[TEST] Updated', key: 'D' }], { token });
      assertStatus(res, json, 200);
      assert(json.ok === true, 'expected ok:true');
    });

    await test('POST /songs/:id/lyrics/suggest without artist → 400', async () => {
      const { res, json } = await POST(`/api/${slug}/songs/${song.id}/lyrics/suggest`, undefined, { token });
      assertStatus(res, json, 400);
      assert(json.error?.includes('No artist'), `unexpected error: ${JSON.stringify(json)}`);
    });

    // File, lyrics, and arrangement tests run on the temp song
    await testLyricsLifecycle(slug, token, song.id);
    await testFileValidation(slug, token, song.id);
    await testArrangementWrite(slug, token, song);

    await test('DELETE /songs/:id soft-deletes → 204', async () => {
      const { res } = await DELETE(`/api/${slug}/songs/${song.id}`, { token });
      assert(res.status === 204, `Expected 204, got ${res.status}`);
    });

    await test('DELETE /songs/:id again (already deleted) → 404', async () => {
      const { res, json } = await DELETE(`/api/${slug}/songs/${song.id}`, { token });
      assertStatus(res, json, 404);
    });

    await test('POST /songs/:id/restore → 201', async () => {
      const { res, json } = await POST(`/api/${slug}/songs/${song.id}/restore`, undefined, { token });
      assertStatus(res, json, 201);
      assert(json.id, 'missing id on restored song');
    });

    await test('POST /songs with lyrics and language → stored as columns', async () => {
      const { res, json } = await POST(`/api/${slug}/songs`,
        { title: '[TEST] With lyrics', active: false, language: 'en', extra: { lyrics: 'Line one\nLine two' } }, { token });
      assertStatus(res, json, 201);
      assert(json.has_lyrics === true, 'has_lyrics should be true');
      assert(json.language === 'EN', `language — got ${JSON.stringify(json.language)}`);
      assert(!json.extra?.lyrics, 'lyrics must not land in extra');
      const { json: detail } = await GET(`/api/${slug}/songs/${json.id}`, AUTH);
      assert(detail.lyrics === 'Line one\nLine two', `lyrics — got ${JSON.stringify(detail.lyrics)}`);
      // Soft delete keeps lyrics and arrangements, so a restore brings them back.
      await DELETE(`/api/${slug}/songs/${json.id}`, { token });
      await POST(`/api/${slug}/songs/${json.id}/restore`, undefined, { token });
      const { json: back } = await GET(`/api/${slug}/songs/${json.id}`, AUTH);
      assert(back.lyrics === 'Line one\nLine two', 'lyrics lost across delete + restore');
      await DELETE(`/api/${slug}/songs/${json.id}`, { token });
    });

    // Final cleanup — leave DB clean
    await test('DELETE /songs/:id cleanup → 204', async () => {
      const { res } = await DELETE(`/api/${slug}/songs/${song.id}`, { token });
      assert(res.status === 204, `Expected 204, got ${res.status}`);
    });
  }

  await testSongImport(slug, token, firstSong, songLimit != null && config.usage?.songs >= songLimit);

  // Setlist operations
  if (firstSong) {
    let setlist;
    let duplicate;

    await test('POST /setlists creates setlist → 201', async () => {
      const { res, json } = await POST(`/api/${slug}/setlists`,
        { title: '[TEST]', song_ids: [firstSong.id] }, { token });
      assertStatus(res, json, 201);
      assert(json.id > 0, 'missing id');
      setlist = json;
    });

    if (setlist) await testSetlistShareValidation(slug, token, setlist.id);

    await test('POST /setlists missing song_ids → 400', async () => {
      const { res, json } = await POST(`/api/${slug}/setlists`, { title: 'x' }, { token });
      assertStatus(res, json, 400);
    });

    if (setlist) {
      await test('PUT /setlists/:id updates metadata + songs → 200', async () => {
        const { res, json } = await PUT(`/api/${slug}/setlists/${setlist.id}`,
          { title: '[TEST] updated', song_ids: [firstSong.id] }, { token });
        assertStatus(res, json, 200);
        assert(json.title === '[TEST] updated', 'title not updated');
      });

      await test('POST /setlists/:id/duplicate → 201 with new id and copied songs', async () => {
        const { res, json } = await POST(`/api/${slug}/setlists/${setlist.id}/duplicate`, undefined, { token });
        assertStatus(res, json, 201);
        assert(json.id !== setlist.id, 'duplicate has same id as original');
        assert(json.song_count === setlist.song_count, `song count mismatch — expected ${setlist.song_count}, got ${json.song_count}`);
        duplicate = json;
      });

      // Cleanup — delete both setlists created above
      await test('DELETE /setlists/:id cleanup original → 200', async () => {
        const { res, json } = await DELETE(`/api/${slug}/setlists/${setlist.id}`, { token });
        assertStatus(res, json, 200);
        assert(json.deleted === true, 'expected deleted:true');
      });

      if (duplicate) {
        await test('DELETE /setlists/:id cleanup duplicate → 200', async () => {
          const { res, json } = await DELETE(`/api/${slug}/setlists/${duplicate.id}`, { token });
          assertStatus(res, json, 200);
          assert(json.deleted === true, 'expected deleted:true');
        });
      }
    }
  } else {
    skip('setlist write tests', 'no existing songs to reference');
  }

  // Config update
  await test('PATCH /config empty name → 400', async () => {
    const { res, json } = await PATCH(CONFIG_URL, { name: '' }, { token });
    assertStatus(res, json, 400);
  });

  await test('PATCH /config valid config update → 200', async () => {
    const { res, json } = await PATCH(CONFIG_URL, { config: { _test: null } }, { token });
    assertStatus(res, json, 200);
    assert(json.ok === true, 'expected ok:true');
  });

  // Private song notes stay private in a public catalogue: every anonymous
  // read of a song (list, /api/config, one song) leaves `comment` out. The
  // switch is restored whatever happens; cache-busting query strings keep a
  // CDN copy of the private variant out of the way on a preview.
  await test('public catalogue never shows a song comment', async () => {
    const before = (await GET(CONFIG_URL, { token })).json?.config?.publicCatalogue === true;
    const { res: cr, json: song } = await POST(`/api/${slug}/songs`,
      { title: '[TEST] public notes', comment: '[TEST] private note', active: true }, { token });
    if (cr.status === 402) return;   // a free band at its song limit
    assertStatus(cr, song, 201);
    try {
      await PATCH(CONFIG_URL, { config: { publicCatalogue: true } }, { token });
      const bust = `_t=${Date.now()}`;
      const list = await GET(`/api/${slug}/songs?limit=30&${bust}`);
      assertStatus(list.res, list.json, 200);
      const cfg  = await GET(`${CONFIG_URL}&${bust}`);
      const one  = await GET(`/api/${slug}/songs/${song.id}?${bust}`);
      assertStatus(one.res, one.json, 200);
      for (const [label, body] of [['list', list.json], ['config', cfg.json], ['song', one.json]])
        assert(!JSON.stringify(body).includes('[TEST] private note'), `comment leaked in anonymous ${label}`);
    } finally {
      await PATCH(CONFIG_URL, { config: { publicCatalogue: before } }, { token });
      await DELETE(`/api/${slug}/songs/${song.id}`, { token });
    }
  });

  // Export
  await test('GET /export returns a ZIP of CSV tables', async () => {
    const res = await fetch(`${BASE_URL}/api/${slug}/export`, {
      headers: { ...BYPASS, 'Authorization': `Bearer ${token}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const cd = res.headers.get('content-disposition') || '';
    assert(cd.includes('attachment') && cd.includes('.zip'), `expected a .zip attachment, got: ${cd}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf.subarray(0, 2).toString() === 'PK', 'not a ZIP archive');
    for (const f of ['artist.csv', 'songs.csv'])
      assert(buf.includes(Buffer.from(f)), `archive has no ${f}`);
  });
}

// ── CRM write lifecycle (venues, organizers, gigs) ───────────────────────────
// Shared factory: create → validate → update → GET verify → soft-delete →
// 409 on modify → hard-delete cleanup. Parameterised on resource + payloads.

// itemUrl: gigs live in the collection handler (one function for both), so a single gig is
// addressed as ?id=N; venues and organizers have their own catch-all and keep /:id.
async function testCrudLifecycle(slug, token, config, { resource, createBody, invalidBody, updateBody, labelField, setHeart,
                                                        badUpdate, clearable = 'comment', linkField,
                                                        itemUrl = (id, qs = '') => `/api/${slug}/${resource}/${id}${qs}` }) {
  console.log(B(`\nWrite ops — ${resource}`));

  if (!planHas(config, resource)) {
    await test(`POST /${resource} on ${config.plan?.key} plan → 402 upgrade_required`, async () => {
      const { res, json } = await POST(`/api/${slug}/${resource}`, createBody, { token });
      assertStatus(res, json, 402);
      assert(json.error === 'upgrade_required' && json.feature === resource, 'expected upgrade_required');
    });
    return;
  }

  let item;

  await test(`POST /${resource} creates → 201`, async () => {
    const { res, json } = await POST(`/api/${slug}/${resource}`, createBody, { token });
    assertStatus(res, json, 201);
    assert(json.id > 0, 'missing id');
    assert(json[labelField] === createBody[labelField], `${labelField} mismatch`);
    item = json;
  });

  await test(`POST /${resource} missing required field → 400`, async () => {
    const { res, json } = await POST(`/api/${slug}/${resource}`, invalidBody, { token });
    assertStatus(res, json, 400);
  });

  if (!item) return;

  await test(`PUT /${resource}/:id updates → 200`, async () => {
    const { res, json } = await PUT(itemUrl(item.id), updateBody, { token });
    assertStatus(res, json, 200);
    assert(json[labelField] === updateBody[labelField], `${labelField} not updated`);
    item = json;
  });

  await test(`GET /${resource}/:id reflects update → 200`, async () => {
    // Authenticated read: venue/organizer GET-by-id is owner-scoped (CRM data),
    // and public venue reads require a public status the [TEST] row doesn't set.
    const { res, json } = await GET(itemUrl(item.id), { token });
    assertStatus(res, json, 200);
    assert(json[labelField] === updateBody[labelField], `${labelField} not reflected`);
  });

  if (badUpdate) {
    await test(`PUT /${resource}/:id with an invalid value → 400, not 500`, async () => {
      const { res, json } = await PUT(itemUrl(item.id), badUpdate, { token });
      assertStatus(res, json, 400);
    });
  }

  await test(`PUT /${resource}/:id: only sent fields change, null clears one`, async () => {
    const set = await PUT(itemUrl(item.id), { [clearable]: '[TEST] note' }, { token });
    assertStatus(set.res, set.json, 200);
    assert(set.json[labelField] === updateBody[labelField], `${labelField} changed by a partial update`);
    const cleared = await PUT(itemUrl(item.id), { [clearable]: null }, { token });
    assertStatus(cleared.res, cleared.json, 200);
    assert(cleared.json[clearable] === null, `${clearable} not cleared: ${JSON.stringify(cleared.json[clearable])}`);
  });

  if (linkField) {
    await test(`PUT /${resource}/:id: a typed link becomes https, a script link is refused`, async () => {
      const ok = await PUT(itemUrl(item.id), { [linkField]: 'www.example.com/x' }, { token });
      assertStatus(ok.res, ok.json, 200);
      assert(ok.json[linkField] === 'https://www.example.com/x', `got ${ok.json[linkField]}`);
      const bad = await PUT(itemUrl(item.id), { [linkField]: 'javascript:alert(1)' }, { token });
      assertStatus(bad.res, bad.json, 400);
    });
  }

  if (setHeart) {
    await test(`${resource}: heart must be a boolean`, async () => {
      assert(!(await setHeart(item, 'yes')), 'string heart accepted');
    });

    await test(`${resource}: heart set → favourite=1 lists it first`, async () => {
      assert(await setHeart(item, true), 'heart save failed');
      const q = encodeURIComponent('[TEST]');
      const fav = await GET(`/api/${slug}/${resource}?favourite=1&q=${q}`, { token });
      assertStatus(fav.res, fav.json, 200);
      assert(fav.json.rows.some(r => r.id === item.id), 'favourite missing from favourite=1');
      assert(fav.json.rows.every(r => r.heart === true), 'favourite=1 returned a non-favourite');
      const all = await GET(`/api/${slug}/${resource}?q=${q}`, { token });
      const firstPlain = all.json.rows.findIndex(r => !r.heart && !r.deleted);
      const mine = all.json.rows.findIndex(r => r.id === item.id);
      assert(firstPlain === -1 || mine < firstPlain, 'favourite not listed before non-favourites');
    });

    await test(`${resource}: heart cleared → gone from favourite=1`, async () => {
      assert(await setHeart(item, false), 'heart clear failed');
      const fav = await GET(`/api/${slug}/${resource}?favourite=1&q=${encodeURIComponent('[TEST]')}`, { token });
      assert(!fav.json.rows.some(r => r.id === item.id), 'unfavourited row still listed');
    });
  }

  await test(`DELETE /${resource}/:id soft-delete → 200`, async () => {
    const { res, json } = await DELETE(itemUrl(item.id), { token });
    assertStatus(res, json, 200);
    assert(json.deleted === true, 'expected deleted:true on soft-deleted row');
  });

  await test(`PUT /${resource}/:id after soft-delete → 409`, async () => {
    const { res, json } = await PUT(itemUrl(item.id), updateBody, { token });
    assertStatus(res, json, 409);
  });

  await test(`DELETE /${resource}/:id hard cleanup → 200`, async () => {
    const { res, json } = await DELETE(itemUrl(item.id), { body: { hard: true }, token });
    assertStatus(res, json, 200);
    assert(json.deleted === true && json.hard === true, 'expected deleted+hard:true');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(B('smartist — API tests'));
  console.log(D(`${BASE_URL}`));
  if (!R2_BASE) console.log(Y('  R2_PUBLIC_URL not set — R2-dependent tests will be skipped'));

  if (!SLUG) {
    console.log(R('\nARTIST_SLUG not set. Add it to .env.local or set it in the environment.'));
    process.exit(1);
  }

  if (EMAIL && PASSWORD) {
    const { res, json } = await POST('/api/login', { email: EMAIL, password: PASSWORD });
    if (!res.ok || !json?.token) {
      // json.error tells a wrong password apart from Vercel's own answers.
      const why = !json ? `non-JSON response, content-type ${res.headers.get('content-type')}`
        : typeof json.error === 'string' ? json.error : JSON.stringify(json.error ?? json);
      console.log(R(`\nLogin as ${EMAIL} failed (${res.status}: ${why}) — stopping before repeated failures lock the account.`));
      process.exit(1);
    }
    TOKEN = json.token;
  }

  const config = await testConfig();
  if (!config) { printSummary(); return; }

  const { slug } = config;

  await Promise.all([
    testPrivacy(slug, config),
    testOrganizers(slug),
    testAuth(slug),
    testFileIdValidation(slug),
  ]);

  if (!TOKEN) {
    console.log(B('\nAuthenticated reads and write ops'));
    console.log(D('  Set ARTIST_EMAIL and ARTIST_PASSWORD to run them — workspaces are private'));
    printSummary();
    return;
  }

  // Authenticated config carries the plan (for the venue gating checks).
  const authed = (await GET(CONFIG_URL, AUTH)).json || config;

  const [firstSong] = await Promise.all([
    testSongs(slug),
    testSongLogs(slug),
    testGigs(slug),
    testVenues(slug, authed),
    testSetlists(slug),
    testImageUploadUrls(slug),
    testDemoGate(),
  ]);

  await testArrangements(slug, firstSong);

  {
    await testWrite(slug, TOKEN, firstSong, authed);
    await testCrudLifecycle(slug, TOKEN, authed, {
      resource: 'venues',
      labelField: 'name',
      createBody:  { name: '[TEST] Venue',   city: 'Teststadt', country: 'DE' },
      invalidBody: { city: 'x' },
      updateBody:  { name: '[TEST] Venue updated', city: 'Teststadt' },
      badUpdate:   { size: 'big' },
      linkField:   'website',
      setHeart: async (v, heart) => {
        const { res, json } = await PATCH(`/api/${slug}/venues`, [{ id: v.id, heart }], { token: TOKEN });
        return res.ok && json.count === 1 && !(json.rejected || []).length;
      },
    });
    await testCrudLifecycle(slug, TOKEN, authed, {
      resource: 'organizers',
      labelField: 'name',
      createBody:  { name: '[TEST] Organizer',   city: 'Teststadt', country: 'DE' },
      invalidBody: { city: 'x' },
      updateBody:  { name: '[TEST] Organizer updated', city: 'Teststadt' },
      badUpdate:   { last_communication: 'yesterday' },
      linkField:   'website',
      setHeart: async (o, heart) => {
        const { res } = await PUT(`/api/${slug}/organizers/${o.id}`, { name: o.name, heart }, { token: TOKEN });
        return res.ok;
      },
    });
    await testCrudLifecycle(slug, TOKEN, authed, {
      resource: 'gigs',
      labelField: 'title',
      itemUrl: (id, qs = '') => `/api/${slug}/gigs?id=${id}${qs.replace('?', '&')}`,
      createBody:  { title: '[TEST] Gig', date: '2099-12-31' },
      invalidBody: { date: '2099-12-31' },
      updateBody:  { title: '[TEST] Gig updated', date: '2099-12-31' },
      badUpdate:   { date: '2099-13-45' },
      linkField:   'additional_link',
    });
    await testIcsFeed(slug, TOKEN);
    await testMultiUserAuth(slug, TOKEN);
    await testSessions(slug, TOKEN);
  }

  printSummary();
}

function printSummary() {
  console.log(`\n${B('─'.repeat(40))}`);
  console.log(
    `${G(`${passed} passed`)}  ` +
    `${failed ? R(`${failed} failed`) : D('0 failed')}  ` +
    `${skipped ? Y(`${skipped} skipped`) : ''}`
  );
  if (failures.length) {
    console.log(R('\nFailed:'));
    failures.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.error}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(R(e.message)); process.exit(1); });
