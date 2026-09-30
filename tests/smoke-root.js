#!/usr/bin/env node
'use strict';

// Browser smoke test for the root of a multi-tenant deployment: the server runs
// WITHOUT ARTIST_SLUG, as app.smartist.studio does, so no page gets a band from
// the environment. The main suites run with one fixed band and cannot see the
// flows that only exist here: signing in from /login, and the links mailed to
// an address (sign-in, password reset) that name no band of their own.
//
//   DATABASE_URL=… APP_SECRET=… ARTIST_SLUG=ci ARTIST_EMAIL=… ARTIST_PASSWORD=… \
//   node tests/smoke-root.js
//
// It starts its own tests/harness/server.js on ROOT_PORT (3001) with the same
// environment minus ARTIST_SLUG, next to the single-band one. ARTIST_SLUG
// names the seeded band the checks expect to land in.

const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');
const postgres = require('postgres');
const { generateMagicToken } = require('../api/_token');

const PORT     = process.env.ROOT_PORT || '3001';
const BASE     = `http://localhost:${PORT}`;
const SLUG     = process.env.ARTIST_SLUG;
const EMAIL    = (process.env.ARTIST_EMAIL || '').toLowerCase();
const PASSWORD = process.env.ARTIST_PASSWORD;

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ${G('✓')} ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ${R('✗')} ${name}\n      ${R(e.message)}`);
  }
}

function watch(page) {
  const problems = [];
  page.on('pageerror', e => problems.push(`uncaught: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('response', r => {
    if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${r.status()} ${r.url().replace(BASE, '')}`);
  });
  return { take: () => problems.splice(0) };
}

function assertClean(problems, where) {
  if (problems.length) throw new Error(`${where}:\n      ${problems.join('\n      ')}`);
}

const inWorkspace = u => new URL(u).pathname.startsWith(`/${SLUG}/`);
const hint = Buffer.from(EMAIL).toString('base64url');

// The server under test, without the band in its environment.
async function startServer() {
  const env = { ...process.env, PORT };
  delete env.ARTIST_SLUG;
  const child = spawn(process.execPath, [path.join(__dirname, 'harness/server.js')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${BASE}/api/config?action=health`)).ok) return child; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`the root server did not start on :${PORT}`);
}

async function main() {
  if (!SLUG || !EMAIL || !PASSWORD || !process.env.DATABASE_URL || !process.env.APP_SECRET) {
    console.error('DATABASE_URL, APP_SECRET, ARTIST_SLUG, ARTIST_EMAIL and ARTIST_PASSWORD are required.');
    process.exit(1);
  }
  // The links are minted the way the API mints them, from the stored hash.
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const [user] = await sql`SELECT password_hash FROM users WHERE email = ${EMAIL} ORDER BY id LIMIT 1`;
  await sql.end();
  if (!user?.password_hash) { console.error(`no user with a password for ${EMAIL}`); process.exit(1); }

  const server = await startServer();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  console.log(`\nMulti-tenant root smoke test ${D(BASE)}`);

  // A fresh context per check: each one starts signed out.
  async function fresh() {
    const context = await browser.newContext();
    const page = await context.newPage();
    return { page, log: watch(page), close: () => context.close() };
  }

  await check('the server serves no band of its own', async () => {
    const r = await fetch(`${BASE}/api/config`);
    const json = await r.json();
    if (json.singleTenant !== false || json.slug) throw new Error(`root config names a band: ${JSON.stringify(json).slice(0, 120)}`);
  });

  await check('signing in at /login lands on the workspace', async () => {
    const { page, log, close } = await fresh();
    try {
      await page.goto(`${BASE}/login`);
      await page.waitForSelector('#email-input', { timeout: 10000 });
      await page.fill('#email-input', EMAIL);
      await page.fill('#pw-input', PASSWORD);
      await Promise.all([page.waitForURL(inWorkspace, { timeout: 15000 }), page.click('#pw-btn')]);
      assertClean(log.take(), 'root sign-in');
    } finally { await close(); }
  });

  // The "you already have an account" email (api/_domain/signup.js).
  await check('a mailed sign-in link opens the workspace', async () => {
    const { page, log, close } = await fresh();
    try {
      const token = encodeURIComponent(generateMagicToken(user.password_hash, 'login'));
      const next  = encodeURIComponent(`/${SLUG}/dashboard`);
      await page.goto(`${BASE}/login#magic=${token}&hint=${hint}&next=${next}`);
      await page.waitForURL(inWorkspace, { timeout: 15000 });
      assertClean(log.take(), 'sign-in link');
    } finally { await close(); }
  });

  // The root "forgot password" email (api/_domain/reset.js) carries no band.
  await check('a mailed reset link shows the set-password form', async () => {
    const { page, log, close } = await fresh();
    try {
      const token = encodeURIComponent(generateMagicToken(user.password_hash, 'reset'));
      await page.goto(`${BASE}/login#reset=${token}&hint=${hint}`);
      await page.waitForSelector('#pw-new', { timeout: 10000 });
      assertClean(log.take(), 'reset link');
    } finally { await close(); }
  });

  await browser.close();
  server.kill();
  console.log(failed ? R(`\n${failed} failed`) : G('\nroot flows clean'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
