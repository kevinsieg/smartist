#!/usr/bin/env node
// API integration tests — runs against a live server (local or deployed).
//
// Usage:
//   npm test                                    # needs vercel dev running
//   BASE_URL=https://yourapp.example.com npm test    # against production
//   BAND_PASSWORD=xxx npm test                  # enables write tests

const fs = require('fs');

// Load .env.local — works from repo root or from tests/
function loadEnv(path) {
  try {
    fs.readFileSync(path, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    });
    return true;
  } catch { return false; }
}
loadEnv('.env.local') || loadEnv('../.env.local');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SLUG     = process.env.BAND_SLUG;
const PASSWORD = process.env.BAND_PASSWORD;
const R2_BASE  = process.env.R2_PUBLIC_URL;

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
  const headers = { 'Content-Type': 'application/json' };
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

// ── Test sections ─────────────────────────────────────────────────────────────

async function testConfig() {
  console.log(B('\n/api/config'));
  let result = null;

  await test('returns band slug, name, and songs array', async () => {
    const { res, json } = await GET('/api/config');
    assertStatus(res, json, 200);
    assert(typeof json.slug === 'string' && json.slug, 'missing slug');
    assert(typeof json.name === 'string' && json.name, 'missing name');
    assert(Array.isArray(json.songs), 'songs not an array');
    result = json;
  });

  return result;
}

async function testSongs(slug) {
  console.log(B(`\n/api/${slug}/songs`));
  let firstSong = null;

  await test('GET returns array with play stats', async () => {
    const { res, json } = await GET(`/api/${slug}/songs`);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'not an array');
    if (json.length) {
      firstSong = json[0];
      assert('play_count' in json[0], 'missing play_count');
      assert('last_played_at' in json[0] || json[0].last_played_at === null, 'missing last_played_at');
    }
  });

  if (firstSong) {
    await test('GET /:id/setlists returns appearances', async () => {
      const { res, json } = await GET(`/api/${slug}/songs/${firstSong.id}/setlists`);
      assertStatus(res, json, 200);
      assert(Array.isArray(json), 'not an array');
    });
  }

  await test('GET /:id/setlists with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/0/setlists`);
    assertStatus(res, json, 400);
  });

  await test('GET /:id/setlists with non-integer id → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/songs/abc/setlists`);
    assertStatus(res, json, 400);
  });

  return firstSong;
}

async function testSongLogs(slug) {
  console.log(B(`\n/api/${slug}/song-logs`));

  let firstLog = null;
  await test('GET returns recent log entries', async () => {
    const { res, json } = await GET(`/api/${slug}/song-logs`);
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
      const { res, json } = await GET(`/api/${slug}/song-logs?songId=${firstLog.song_id}`);
      assertStatus(res, json, 200);
      assert(Array.isArray(json), 'not an array');
      json.forEach(l => assert(l.song_id === firstLog.song_id,
        `unexpected song_id ${l.song_id} in filtered results`));
    });
  }

  await test('GET ?songId=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/song-logs?songId=0`);
    assertStatus(res, json, 400);
  });

  await test('GET ?songId=abc → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/song-logs?songId=abc`);
    assertStatus(res, json, 400);
  });
}

async function testGigs(slug) {
  console.log(B(`\n/api/${slug}/gigs`));
  let firstGig = null;

  await test('GET returns array', async () => {
    const { res, json } = await GET(`/api/${slug}/gigs`);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'not an array');
    if (json.length) firstGig = json[0];
  });

  if (firstGig) {
    await test('GET /:id returns gig', async () => {
      const { res, json } = await GET(`/api/${slug}/gigs/${firstGig.id}`);
      assertStatus(res, json, 200);
      assert(json.id === firstGig.id, 'id mismatch');
      assert('name' in json, 'missing name');
    });
  }

  await test('GET /:id with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/gigs/0`);
    assertStatus(res, json, 400);
  });

  return firstGig;
}

async function testSetlists(slug) {
  console.log(B(`\n/api/${slug}/setlists`));
  let firstSetlist = null;

  await test('GET returns array with song_count', async () => {
    const { res, json } = await GET(`/api/${slug}/setlists`);
    assertStatus(res, json, 200);
    assert(Array.isArray(json), 'not an array');
    if (json.length) {
      firstSetlist = json[0];
      assert('song_count' in json[0], 'missing song_count');
    }
  });

  if (firstSetlist) {
    await test('GET /:id returns setlist with ordered songs', async () => {
      const { res, json } = await GET(`/api/${slug}/setlists/${firstSetlist.id}`);
      assertStatus(res, json, 200);
      assert(json.id === firstSetlist.id, 'id mismatch');
      assert(Array.isArray(json.songs), 'songs not an array');
    });
  }

  await test('GET /:id with id=0 → 400', async () => {
    const { res, json } = await GET(`/api/${slug}/setlists/0`);
    assertStatus(res, json, 400);
  });

  await test('GET /:id not found → 404', async () => {
    const { res, json } = await GET(`/api/${slug}/setlists/999999999`);
    assertStatus(res, json, 404);
  });

  return firstSetlist;
}

async function testAuth(slug) {
  console.log(B('\nAuth'));

  await test('POST /auth wrong password → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/auth`, { password: '__wrong__' });
    assertStatus(res, json, 401);
  });

  await test('POST /auth empty body → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/auth`, {});
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

  await test('POST /setlists/1/share without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/setlists/1/share`, { email: 'test@example.com' });
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

  await test('PUT /songs/1/lyrics without token → 401', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/1/lyrics`, { lyrics: 'x' });
    assertStatus(res, json, 401);
  });
  await test('DELETE /songs/1/lyrics without token → 401', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/1/lyrics`);
    assertStatus(res, json, 401);
  });
  await test('POST /songs/1/lyrics-suggest without token → 401', async () => {
    const { res, json } = await POST(`/api/${slug}/songs/1/lyrics-suggest`, {});
    assertStatus(res, json, 401);
  });
}

// ── File endpoint tests ───────────────────────────────────────────────────────

async function testFileIdValidation(slug) {
  console.log(B('\nFile endpoint ID validation'));

  for (const type of ['audio', 'sheet', 'playback', 'lyrics']) {
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
    await test('PUT /audio valid prefix, nonexistent song → 404', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/999999999/audio`,
        { publicUrl: `${R2_BASE}/audio/fake.mp3` }, { token });
      assertStatus(res, json, 404);
    });

    await test('PUT /sheet wrong key prefix → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/${songId}/sheet`,
        { publicUrl: `${R2_BASE}/audio/fake.pdf` }, { token });
      assertStatus(res, json, 400);
    });
    await test('PUT /sheet valid prefix, nonexistent song → 404', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/999999999/sheet`,
        { publicUrl: `${R2_BASE}/sheets/fake.pdf` }, { token });
      assertStatus(res, json, 404);
    });

    await test('PUT /playback wrong key prefix → 400', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/${songId}/playback`,
        { publicUrl: `${R2_BASE}/audio/fake.mp3` }, { token });
      assertStatus(res, json, 400);
    });
    await test('PUT /playback valid prefix, nonexistent song → 404', async () => {
      const { res, json } = await PUT(`/api/${slug}/songs/999999999/playback`,
        { publicUrl: `${R2_BASE}/playback/fake.mp3` }, { token });
      assertStatus(res, json, 404);
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
  await test('PUT /lyrics wrong body key → 400', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/${songId}/lyrics`,
      { text: 'wrong key' }, { token });
    assertStatus(res, json, 400);
  });
  await test('PUT /lyrics too long → 400', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/${songId}/lyrics`,
      { lyrics: 'x'.repeat(20001) }, { token });
    assertStatus(res, json, 400);
  });
  await test('DELETE /lyrics nonexistent song → 404', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/999999999/lyrics`, { token });
    assertStatus(res, json, 404);
  });

  // Full round-trip
  const testLyrics = 'Verse 1\nSecond line\n\nChorus\nSing along';

  await test('PUT /lyrics saves text → 200', async () => {
    const { res, json } = await PUT(`/api/${slug}/songs/${songId}/lyrics`,
      { lyrics: testLyrics }, { token });
    assertStatus(res, json, 200);
    assert(json.ok === true, 'expected ok:true');
  });

  await test('GET /songs reflects saved lyrics in extra.lyrics', async () => {
    const { res, json } = await GET(`/api/${slug}/songs`);
    assertStatus(res, json, 200);
    const song = json.find(s => s.id === songId);
    assert(song, 'test song not found in GET /songs');
    assert(song.extra?.lyrics === testLyrics.trim(),
      `lyrics mismatch — got: ${JSON.stringify(song.extra?.lyrics)}`);
  });

  await test('DELETE /lyrics clears field → 200', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/${songId}/lyrics`, { token });
    assertStatus(res, json, 200);
    assert(json.ok === true, 'expected ok:true');
  });

  await test('GET /songs confirms lyrics removed', async () => {
    const { res, json } = await GET(`/api/${slug}/songs`);
    assertStatus(res, json, 200);
    const song = json.find(s => s.id === songId);
    assert(song, 'test song not found');
    assert(!song.extra?.lyrics,
      `expected no lyrics, got: ${JSON.stringify(song.extra?.lyrics)}`);
  });

  await test('DELETE /lyrics again (already empty) → 200', async () => {
    const { res, json } = await DELETE(`/api/${slug}/songs/${songId}/lyrics`, { token });
    assertStatus(res, json, 200);
    assert(json.ok === true, 'expected ok:true');
  });
}

async function testSetlistShareValidation(slug, token, setlistId) {
  console.log(B('\nSetlist share validation'));

  await test('POST /setlists/:id/share invalid email → 400', async () => {
    const { res, json } = await POST(`/api/${slug}/setlists/${setlistId}/share`,
      { email: 'not-an-email' }, { token });
    assertStatus(res, json, 400);
  });

  await test('POST /setlists/:id/share unknown setlist → 404', async () => {
    const { res, json } = await POST(`/api/${slug}/setlists/999999999/share`,
      { email: 'test@example.com' }, { token });
    assertStatus(res, json, 404);
  });
}

async function testWrite(slug, token, firstSong) {
  console.log(B('\nWrite ops'));

  // Verify password
  let authed = false;
  await test('POST /auth with correct password → 200', async () => {
    const { res, json } = await POST(`/api/${slug}/auth`, { password: token });
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

  if (song) {
    await test('PATCH /songs updates song → 200', async () => {
      const { res, json } = await PATCH(`/api/${slug}/songs`,
        [{ ...song, title: '[TEST] Updated', key: 'D' }], { token });
      assertStatus(res, json, 200);
      assert(json.ok === true, 'expected ok:true');
    });

    await test('POST /songs/:id/lyrics-suggest without artist → 400', async () => {
      const { res, json } = await POST(`/api/${slug}/songs/${song.id}/lyrics-suggest`, {}, { token });
      assertStatus(res, json, 400);
      assert(json.error?.includes('No artist'), `unexpected error: ${JSON.stringify(json)}`);
    });

    // File and lyrics tests run on the temp song so production data is untouched
    await testLyricsLifecycle(slug, token, song.id);
    await testFileValidation(slug, token, song.id);

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

    // Final cleanup — leave DB clean
    await test('DELETE /songs/:id cleanup → 204', async () => {
      const { res } = await DELETE(`/api/${slug}/songs/${song.id}`, { token });
      assert(res.status === 204, `Expected 204, got ${res.status}`);
    });
  }

  // Setlist operations (creates [TEST] entries that persist — no delete endpoint)
  if (firstSong) {
    let setlist;

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

      await test('POST /setlists/:id/duplicate → 201', async () => {
        const { res, json } = await POST(
          `/api/${slug}/setlists/${setlist.id}/duplicate`, undefined, { token });
        assertStatus(res, json, 201);
        assert(json.id !== setlist.id, 'duplicate has same id as original');
      });
    }
  } else {
    skip('setlist write tests', 'no existing songs to reference');
  }

  // Export
  await test('GET /export returns JSON attachment', async () => {
    const res = await fetch(`${BASE_URL}/api/${slug}/export`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const cd = res.headers.get('content-disposition') || '';
    assert(cd.includes('attachment'), `expected attachment disposition, got: ${cd}`);
    const body = await res.json();
    assert(Array.isArray(body.songs), 'missing songs array');
    assert(Array.isArray(body.setlists), 'missing setlists array');
    assert(Array.isArray(body.gigs), 'missing gigs array');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(B('Band Tools — API Tests'));
  console.log(D(`${BASE_URL}`));
  if (!R2_BASE) console.log(Y('  R2_PUBLIC_URL not set — R2-dependent tests will be skipped'));

  if (!SLUG) {
    console.log(R('\nBAND_SLUG not set. Add it to .env.local or set it in the environment.'));
    process.exit(1);
  }

  const config = await testConfig();
  if (!config) { printSummary(); return; }

  const { slug } = config;

  const [firstSong] = await Promise.all([
    testSongs(slug),
    testSongLogs(slug),
    testGigs(slug),
    testSetlists(slug),
    testAuth(slug),
    testFileIdValidation(slug),
  ]);

  if (PASSWORD) {
    await testWrite(slug, PASSWORD, firstSong);
  } else {
    console.log(B('\nWrite ops'));
    console.log(D('  Set BAND_PASSWORD=<password> to enable write tests'));
  }

  printSummary();
}

function printSummary() {
  const total = passed + failed;
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
