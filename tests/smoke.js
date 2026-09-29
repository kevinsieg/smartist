#!/usr/bin/env node
'use strict';

// Browser smoke test: signs in through the login form, opens every page of a
// workspace, follows the nav the way a visitor does (SPA navigation), and opens
// a stage link. A page fails on an uncaught exception, a console error, or an
// API answer of 500 or above — the breakage that API tests cannot see, such as
// a script calling a helper its page does not load.
//
//   BASE_URL=http://localhost:3000 ARTIST_SLUG=ci ARTIST_EMAIL=… ARTIST_PASSWORD=… node tests/smoke.js
//
// Needs the playwright package and a Chromium (CI installs both; locally set
// PLAYWRIGHT_CHROMIUM to a browser binary if the bundled one is missing).

const { chromium } = require('playwright');

const BASE     = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SLUG     = process.env.ARTIST_SLUG;
const EMAIL    = process.env.ARTIST_EMAIL;
const PASSWORD = process.env.ARTIST_PASSWORD;

const PAGES = [
  'dashboard', 'songs', 'setlist', 'setlist?view=history', 'setlist-history', 'gigs',
  'venues', 'organizers', 'hub', 'pro-import', 'settings', 'profile',
];

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

// Everything a page did wrong since the last reset.
function watch(page) {
  const problems = [];
  page.on('pageerror', e => problems.push(`uncaught: ${e.message}`));
  page.on('console', m => {
    // A missing image or favicon is not a script failure.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('response', r => {
    if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${r.status()} ${r.url().replace(BASE, '')}`);
  });
  return { take: () => problems.splice(0) };
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

function assertClean(problems, where) {
  if (problems.length) throw new Error(`${where}:\n      ${problems.join('\n      ')}`);
}

async function main() {
  if (!SLUG || !EMAIL || !PASSWORD) {
    console.error('ARTIST_SLUG, ARTIST_EMAIL and ARTIST_PASSWORD are required.');
    process.exit(1);
  }
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const page = await browser.newPage();
  const log = watch(page);

  console.log(`\nBrowser smoke test ${D(BASE)}`);

  await check('login page renders', async () => {
    await page.goto(`${BASE}/login`);
    await page.waitForSelector('#email-input', { timeout: 10000 });
    assertClean(log.take(), '/login');
  });

  await check('signing in through the form lands on the workspace', async () => {
    await page.fill('#email-input', EMAIL);
    await page.fill('#pw-input', PASSWORD);
    await Promise.all([
      page.waitForURL(u => new URL(u).pathname.startsWith(`/${SLUG}/`), { timeout: 15000 }),
      page.click('#pw-btn'),
    ]);
    await settle(page);
    assertClean(log.take(), 'after sign-in');
  });

  for (const p of PAGES) {
    await check(`/${SLUG}/${p} loads without errors`, async () => {
      await page.goto(`${BASE}/${SLUG}/${p}`);
      await settle(page);
      // Some pages wrap their content in <main>, others in .app-wrap.
      const content = await page.evaluate(() => [...document.body.children]
        .filter(el => !/^(HEADER|FOOTER|SCRIPT|STYLE)$/.test(el.tagName) && el.id !== 'demo-banner')
        .some(el => el.children.length > 0));
      if (!content) throw new Error('the page rendered no content');
      assertClean(log.take(), p);
    });
  }

  await check('nav links navigate in place (SPA) without errors', async () => {
    await page.goto(`${BASE}/${SLUG}/dashboard`);
    await settle(page);
    log.take();
    for (const [href, file] of [['songs', 'songs'], ['setlist', 'setlist'], ['gigs', 'gigs'], ['songs', 'songs']]) {
      await page.click(`.nav-links a[href="/${SLUG}/${href}"]`);
      await page.waitForURL(`**/${SLUG}/${href}`, { timeout: 10000 });
      await settle(page);
      const loaded = await page.evaluate(f =>
        [...document.querySelectorAll('script[src]')].some(s => s.src.includes(`/app/js/${f}.js`)), file);
      if (!loaded) throw new Error(`${file}.js not loaded after navigating to ${href}`);
      assertClean(log.take(), `SPA → ${href}`);
    }
  });

  await check('a stage link opens a saved setlist', async () => {
    await page.goto(`${BASE}/${SLUG}/dashboard`);
    await settle(page);
    const id = await page.evaluate(async slug => {
      const h = { Authorization: 'Bearer ' + (sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token')),
                  'Content-Type': 'application/json' };
      const songs = await (await fetch(`/api/${slug}/songs`, { headers: h })).json();
      const r = await fetch(`/api/${slug}/setlists`, { method: 'POST', headers: h,
        body: JSON.stringify({ title: '[TEST] smoke', song_ids: songs.slice(0, 2).map(s => s.id) }) });
      return (await r.json()).id;
    }, SLUG);
    if (!id) throw new Error('could not create a setlist');
    try {
      await page.goto(`${BASE}/${SLUG}/stage?id=${id}`);
      await page.waitForSelector('.stage-title', { timeout: 10000 });
      const songs = await page.$$('.stage-song-title');
      if (songs.length < 1) throw new Error('stage lists no songs');
      assertClean(log.take(), 'stage');
    } finally {
      await page.evaluate(async ({ slug, id }) => {
        const t = sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token');
        await fetch(`/api/${slug}/setlists/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
      }, { slug: SLUG, id });
    }
  });

  await browser.close();
  console.log(failed ? R(`\n${failed} failed`) : G('\nall pages clean'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
