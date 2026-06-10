#!/usr/bin/env node
// End-to-end signup flow test — runs against a live server (vercel dev or a
// deployed preview) plus direct DB access to plant the signup token (the real
// flow delivers it by email, which a test can't intercept).
//
// Flow covered: signup token → verify-signup-token → signup (artist + admin
// user created) → session token works on the new workspace → session token is
// REJECTED on a foreign workspace (cross-tenant regression) → cleanup.
//
// Usage:
//   node tests/e2e-signup.js                  # needs vercel dev on :3000 + DATABASE_URL
//   BASE_URL=https://preview.url node tests/e2e-signup.js

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

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
loadEnvFile(path.join(REPO_ROOT, '.env.local'));
loadEnvFile(path.join(REPO_ROOT, '.env'));

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ${G('✓')} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${R('✗')} ${name}\n      ${R(e.message)}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required (set in .env)');
    process.exit(1);
  }
  const postgres = require(path.join(REPO_ROOT, 'node_modules', 'postgres'));
  const sql = postgres(process.env.DATABASE_URL);
  const { createSignupToken } = require(path.join(REPO_ROOT, 'api', '_domain', 'registration'));

  const rand   = Math.random().toString(36).slice(2, 8);
  const email  = `e2e-signup-${rand}@example.invalid`;
  const slug   = `e2e-test-${rand}`;
  let sessionToken = null;

  console.log(B(`\nSignup E2E — ${BASE_URL} (slug: ${slug})`));

  try {
    // Plant the signup token directly (email delivery is out of scope).
    const rawToken = await createSignupToken(email, sql);

    await test('verify-signup-token: valid token → 200 + email', async () => {
      const r = await fetch(`${BASE_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-signup-token', token: rawToken }),
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      const d = await r.json();
      assert(d.email === email, `expected ${email}, got ${d.email}`);
    });

    await test('verify-signup-token: garbage token → 400', async () => {
      const r = await fetch(`${BASE_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify-signup-token', token: 'deadbeef'.repeat(8) }),
      });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('signup: invalid slug → 400', async () => {
      const r = await fetch(`${BASE_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signup', token: rawToken, name: 'E2E Band', slug: 'NO SPACES!!' }),
      });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('signup: valid → 201 + session token + slug', async () => {
      const r = await fetch(`${BASE_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signup', token: rawToken, name: 'E2E Band', slug }),
      });
      const text = await r.text();
      assert(r.status === 201, `expected 201, got ${r.status}: ${text}`);
      const d = JSON.parse(text);
      assert(d.token, 'expected session token');
      assert(d.slug === slug, `expected slug ${slug}, got ${d.slug}`);
      assert(d.role === 'admin', `expected admin role, got ${d.role}`);
      sessionToken = d.token;
    });

    await test('signup token is single-use → second signup 400/409', async () => {
      const r = await fetch(`${BASE_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signup', token: rawToken, name: 'E2E Band 2', slug: `${slug}-2` }),
      });
      assert(r.status === 400 || r.status === 409, `expected 400/409, got ${r.status}`);
    });

    await test('session token authorises the new workspace (organizers GET 200)', async () => {
      const r = await fetch(`${BASE_URL}/api/${slug}/organizers?limit=1`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });

    await test('my-artists lists the new workspace', async () => {
      const r = await fetch(`${BASE_URL}/api/config?action=my-artists`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      const d = await r.json();
      assert((d.artists || []).some(a => a.slug === slug), 'new workspace missing from my-artists');
    });

    const foreignSlug = process.env.ARTIST_SLUG;
    if (foreignSlug && foreignSlug !== slug) {
      await test('cross-tenant: session token REJECTED on foreign workspace → 401', async () => {
        const r = await fetch(`${BASE_URL}/api/${foreignSlug}/organizers?limit=1`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        });
        assert(r.status === 401, `expected 401, got ${r.status} — cross-tenant access not blocked!`);
      });
    }
  } finally {
    // Cleanup: artist row cascades to users; subscriber row holds the token.
    try {
      await sql`DELETE FROM artists WHERE slug = ${slug}`;
      await sql`DELETE FROM subscribers WHERE email = ${email}`;
    } catch (e) { console.log(R(`  cleanup failed: ${e.message}`)); }
    await sql.end();
  }

  console.log(`\n${G(`${passed} passed`)}  ${failed ? R(`${failed} failed`) : '0 failed'}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
