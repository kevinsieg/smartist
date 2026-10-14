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

// Accessibility: with axe-core installed (CI installs it next to playwright),
// every page must be free of serious and critical WCAG 2.2 AA violations.
let AXE = null;
try { AXE = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* optional locally */ }

async function assertAccessible(page, where) {
  if (!AXE) return;
  // evaluate() is not subject to the page's CSP, unlike an injected <script>.
  await page.evaluate(AXE);
  const found = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
      .map(v => `${v.id} (${v.nodes.length}): ${v.nodes[0].target.join(' ')}`);
  });
  if (found.length) throw new Error(`${where} accessibility:\n      ${found.join('\n      ')}`);
}

const BASE     = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SLUG     = process.env.ARTIST_SLUG;
const EMAIL    = process.env.ARTIST_EMAIL;
const PASSWORD = process.env.ARTIST_PASSWORD;

const PAGES = [
  'dashboard', 'songs', 'setlist', 'setlist?view=history', 'gigs',
  'venues', 'organizers', 'hub', 'pro-import', 'song-import', 'settings', 'profile',
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
    await assertAccessible(page, '/login');
  });

  // Public pages a visitor reaches before signing in.
  for (const p of ['signup', 'privacy', 'contact', 'confirm-email', 'demo']) {
    await check(`/${p} renders and is accessible`, async () => {
      await page.goto(`${BASE}/${p}`);
      await settle(page);
      assertClean(log.take(), `/${p}`);
      await assertAccessible(page, `/${p}`);
    });
  }

  await check('signing in through the form lands on the workspace', async () => {
    await page.goto(`${BASE}/login`);
    await page.waitForSelector('#email-input', { timeout: 10000 });
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
      await assertAccessible(page, p);
    });
  }

  for (const p of ['profile', 'workspaces']) {
    await check(`/${p} loads without errors`, async () => {
      await page.goto(`${BASE}/${p}`);
      await settle(page);
      assertClean(log.take(), `/${p}`);
      await assertAccessible(page, `/${p}`);
    });
  }

  // What a page-load scan cannot see: the song panel opened from the keyboard
  // takes focus (on phones it covers the list) and passes axe while open.
  await check('a song opened by keyboard moves focus into its panel', async () => {
    await page.goto(`${BASE}/${SLUG}/songs`);
    await settle(page);
    await page.locator('[data-id][tabindex="0"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#view-side-panel .vsp-title', { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('view-side-panel').contains(document.activeElement), null, { timeout: 5000 });
    assertClean(log.take(), 'song panel');
    await assertAccessible(page, 'song panel');
    await page.keyboard.press('Escape');
    const back = await page.evaluate(() => !!document.activeElement.closest('[data-id]'));
    if (!back) throw new Error('Escape did not return focus to the song row');
  });

  // The songs list renders a page of rows (window.LV_RENDER_STEP, 200) and a "Show
  // more" button for the rest; text filters run once typing pauses. The step is
  // set to 1 here so two seeded songs exercise it.
  await check('the songs list shows a page of rows, then more on request', async () => {
    await page.goto(`${BASE}/${SLUG}/songs`);
    await settle(page);
    const rows = () => page.evaluate(() => document.querySelectorAll('#lv-body > [data-id]').length);
    const total = await page.evaluate(() => { window.LV_RENDER_STEP = 1; window.renderTable(); return window._getSongsForFactory({ active: true }).length; });
    try {
      if (total < 2) throw new Error(`needs two active songs, found ${total}`);
      if (await rows() !== 1) throw new Error(`expected 1 row at first, got ${await rows()}`);
      await assertAccessible(page, 'songs list with "Show more"');
      await page.click('#lv-body [data-lv-more]');
      if (await rows() !== Math.min(2, total)) throw new Error(`expected 2 rows after "Show more", got ${await rows()}`);
      const focused = await page.evaluate(() => [...document.querySelectorAll('#lv-body > [data-id]')].indexOf(document.activeElement));
      if (focused !== 1) throw new Error(`focus should move to the first new row, is on row ${focused}`);
      await page.fill('#lv-f-title', 'ci song two');
      await page.waitForFunction(() => document.getElementById('lv-count').textContent.startsWith('1 /'), null, { timeout: 5000 });
      if (await rows() !== 1 || await page.$('#lv-body [data-lv-more]')) throw new Error('the filtered list should show its one row and no button');
      assertClean(log.take(), 'songs list paging');
    } finally {
      await page.evaluate(() => { window.LV_RENDER_STEP = 200; });
    }
  });

  // A panel save reloads that one song, not the whole list (GET /songs).
  await check('saving a song in the panel updates its row without reloading the list', async () => {
    await page.goto(`${BASE}/${SLUG}/songs`);
    await settle(page);
    const id = await page.evaluate(() => window.songs[0].id);
    const listCalls = [];
    const onRequest = req => { if (new URL(req.url()).pathname === `/api/${SLUG}/songs` && req.method() === 'GET') listCalls.push(req.url()); };
    page.on('request', onRequest);
    const before = await page.evaluate(i => window.songs.find(s => s.id === i).comment || '', id);
    try {
      await page.evaluate(i => { window._songsView.select(i); window._openSongEditInPanel(i); }, id);
      // The field sits in a collapsed section; set it as typing would.
      await page.evaluate(() => {
        const el = document.querySelector('#view-side-panel input[data-key="comment"]');
        el.value = '[TEST] smoke comment';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.click('#song-panel-save-btn');
      await page.waitForFunction(i => (window.songs.find(s => s.id === i).comment || '') === '[TEST] smoke comment', id, { timeout: 10000 });
      await page.waitForSelector('#view-side-panel .vsp-title', { timeout: 10000 });
      if (listCalls.length) throw new Error(`the save reloaded the whole list: ${listCalls.join(', ')}`);
      const shown = await page.evaluate(i => !!document.querySelector('#lv-body [data-id="' + i + '"]'), id);
      if (!shown) throw new Error('the saved song is no longer in the list');
      assertClean(log.take(), 'panel save');
    } finally {
      page.off('request', onRequest);
      await page.evaluate(async ({ slug, i, comment }) => {
        const s = window.songs.find(x => x.id === i);
        await window.apiFetch('/api/' + slug + '/songs', 'PATCH', [{ id: i, title: s.title, active: s.active, comment: comment }]);
      }, { slug: SLUG, i: id, comment: before });
    }
  });

  // A song's appearances link to the History tab with that set open.
  await check('an appearance opens its set in the setlist history', async () => {
    await page.goto(`${BASE}/${SLUG}/songs`);
    await settle(page);
    const { id, songId } = await page.evaluate(async slug => {
      const songId = window.songs[0].id;
      const r = await window.apiFetch('/api/' + slug + '/setlists', 'POST', { title: '[TEST] smoke appearances', song_ids: [songId] });
      return { id: (await r.json()).id, songId };
    }, SLUG);
    if (!id) throw new Error('could not create a setlist');
    try {
      await page.evaluate(i => window.openAppearances(i), songId);
      const link = page.locator(`#appearances-list a[href*="set=${id}"]`);
      await link.waitFor({ timeout: 10000 });
      const href = await link.getAttribute('href');
      if (href !== `/${SLUG}/setlist?view=history&set=${id}`) throw new Error(`unexpected link ${href}`);
      await page.goto(`${BASE}${href}`);
      await page.waitForFunction(() => {
        const t = document.querySelector('#view-side-panel.open .vsp-title');
        return t && t.textContent === '[TEST] smoke appearances';
      }, null, { timeout: 10000 });
      assertClean(log.take(), 'appearance link');
    } finally {
      await page.evaluate(async ({ slug, id }) => {
        await window.apiFetch('/api/' + slug + '/setlists/' + id, 'DELETE');
      }, { slug: SLUG, id });
    }
  });

  await check('nav links navigate in place (SPA) without errors', async () => {
    await page.goto(`${BASE}/${SLUG}/dashboard`);
    await settle(page);
    log.take();
    // The Setlists link opens the history of saved sets, not the generator.
    for (const [href, file] of [['songs', 'songs'], ['setlist?view=history', 'setlist'], ['gigs', 'gigs'], ['songs', 'songs']]) {
      await page.click(`.nav-links a[href="/${SLUG}/${href}"]`);
      await page.waitForURL(`**/${SLUG}/${href}`, { timeout: 10000 });
      await settle(page);
      const loaded = await page.evaluate(f =>
        [...document.querySelectorAll('script[src]')].some(s => s.src.includes(`/app/js/${f}.js`)), file);
      if (!loaded) throw new Error(`${file}.js not loaded after navigating to ${href}`);
      const current = await page.getAttribute(`.nav-links a[href="/${SLUG}/${href}"]`, 'aria-current');
      if (current !== 'page') throw new Error(`nav link ${href} not marked as the current page`);
      assertClean(log.take(), `SPA → ${href}`);
    }
  });

  // Already on the setlist page, on the generator tab: the nav link still shows the history.
  await check('the Setlists link shows the history again from the generator tab', async () => {
    await page.goto(`${BASE}/${SLUG}/setlist`);
    await settle(page);
    await page.waitForSelector('.setlist-tab[data-tab="generator"]', { timeout: 10000 });
    await page.click(`.nav-links a[href="/${SLUG}/setlist?view=history"]`);
    await page.waitForURL(`**/${SLUG}/setlist?view=history`, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.setlist-tab--active')?.dataset.tab === 'history', null, { timeout: 10000 });
    await page.click('.setlist-tab[data-tab="generator"]');
    await page.waitForFunction(() => document.querySelector('.setlist-tab--active')?.dataset.tab === 'generator', null, { timeout: 10000 });
    await page.click(`.nav-links a[href="/${SLUG}/setlist?view=history"]`);
    await page.waitForFunction(() => document.querySelector('.setlist-tab--active')?.dataset.tab === 'history', null, { timeout: 10000 });
    assertClean(log.take(), 'setlist nav');
  });

  // Page scripts share one global scope: one that redefines a shared function
  // (PRO's own setStatus once did) breaks every page visited after it.
  await check('after PRO, in-app navigation to Gigs still opens the add-gig form', async () => {
    await page.goto(`${BASE}/${SLUG}/pro-import`);
    await settle(page);
    await page.click(`.nav-links a[href="/${SLUG}/gigs"]`);
    await page.waitForURL(`**/${SLUG}/gigs`, { timeout: 10000 });
    await settle(page);
    await page.click('#gig-add-btn:not([disabled])', { timeout: 10000 });
    await page.waitForSelector('#gig-modal.open', { timeout: 5000 });
    assertClean(log.take(), 'PRO → gigs');
    await page.keyboard.press('Escape');
  });

  // 1.4.10 Reflow: nothing scrolls sideways on a 320 px screen.
  await check('no page scrolls sideways at 320 px', async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    const wide = [];
    try {
      for (const p of PAGES) {
        await page.goto(`${BASE}/${SLUG}/${p}`);
        await settle(page);
        const w = await page.evaluate(() => {
          const el = [...document.body.querySelectorAll('*')].find(e => e.getBoundingClientRect().right > 321);
          return { w: document.documentElement.scrollWidth,
                   el: el && `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).split(' ')[0] : ''}` };
        });
        if (w.w > 320) wide.push(`${p} (${w.w}px, ${w.el})`);
      }
    } finally {
      await page.setViewportSize({ width: 1280, height: 720 });
      log.take();
    }
    if (wide.length) throw new Error(`wider than the screen: ${wide.join(', ')}`);
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
      await assertAccessible(page, 'stage');
    } finally {
      await page.evaluate(async ({ slug, id }) => {
        const t = sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token');
        await fetch(`/api/${slug}/setlists/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
      }, { slug: SLUG, id });
    }
  });

  // Melodies: a melody seeded in the database (uploads need the bucket) shows
  // in the stage view for the chosen voice, and in the song panel's block.
  await check('melodies: the stage shows the chosen voice, the panel lists the melody', async () => {
    if (!process.env.DATABASE_URL) { console.log(D('      (skipped: no DATABASE_URL)')); return; }
    const postgres = require('postgres');
    const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
    await page.goto(`${BASE}/${SLUG}/dashboard`);
    await settle(page);
    const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
      const h = { Authorization: 'Bearer ' + (sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token')),
                  'Content-Type': 'application/json' };
      const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json().catch(() => null) };
    }, { method, path, body });
    const cfgPath = `/api/config?slug=${encodeURIComponent(SLUG)}`;
    const before = (await api('GET', cfgPath)).json.config.arrangementConfig ?? null;
    let songId = null;
    try {
      await api('PATCH', cfgPath, { config: { arrangementConfig: { ...(before ?? {}), instruments: [
        ...((before && before.instruments) || []).filter(i => i.key !== 'TEN'), { key: 'TEN', label: 'Tenor' }] } } });
      // The config is cached for the session; Settings clears it on save, this PATCH does not.
      await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('artist_config_cache')).forEach(k => sessionStorage.removeItem(k)));
      const made = await api('POST', `/api/${SLUG}/songs`, { title: '[TEST] melody smoke' });
      songId = made.json.id;
      await api('PUT', `/api/${SLUG}/songs/${songId}/lyrics`, { lyrics: 'La la la' });
      const [{ id: artistId }] = await sql`SELECT id FROM artists WHERE slug = ${SLUG}`;
      await sql`INSERT INTO song_media (song_id, artist_id, kind, instrument, url, position) VALUES
        (${songId}, ${artistId}, 'sheet', 'TEN', ${BASE + '/app/img/broken-guitar.svg'}, 0),
        (${songId}, ${artistId}, 'sheet', 'TEN', ${BASE + '/app/img/broken-guitar.svg?2'}, 1),
        (${songId}, ${artistId}, 'sheet', NULL, ${BASE + '/app/img/broken-guitar.svg?song'}, 0)`;
      await sql`INSERT INTO song_media (song_id, artist_id, kind, instrument, url) VALUES (${songId}, ${artistId}, 'instrument', 'TEN', ${BASE + '/own.mp3'})`;
      await sql`INSERT INTO song_media (song_id, artist_id, kind, url, waveform) VALUES (${songId}, ${artistId}, 'listen', ${BASE + '/ref.mp3'}, ${'c0'.repeat(100)})`;
      await page.evaluate(() => localStorage.removeItem('stage_melody_voice'));
      await page.goto(`${BASE}/${SLUG}/stage?song=${songId}`);
      // Opens on Listen: its track, no sheets; the voice button reads "My voice".
      await page.waitForSelector('#_stage_audio audio', { timeout: 10000 });
      const src = () => page.getAttribute('#_stage_audio audio', 'src');
      const pressed = () => page.evaluate(() => [...document.querySelectorAll('.stage-controls [data-fk="track"], .stage-controls [data-fk="voice"]')]
        .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent));
      if (!/ref\.mp3$/.test(await src())) throw new Error('did not open on Listen');
      if ((await pressed()).join() !== 'Listen') throw new Error('Listen not highlighted: ' + await pressed());
      // Listen opens on the song's own sheet (one image, no counter); no switch until a voice is chosen.
      await page.waitForSelector('.stage-gallery', { timeout: 5000 });
      if (await page.locator('.stage-gallery-count').count()) throw new Error('unexpected counter on a one-page sheet');
      if (!/Whole song/.test(await page.textContent('.stage-controls [data-fk="sheet"]'))) throw new Error('sheet dropdown does not name the song sheet');
      // My voice opens a menu; choosing Tenor shows its sheets (a gallery) and recording.
      await page.click('.stage-menu-wrap[data-menu="voice"] .stage-menu-btn');
      await page.click('.stage-menu-wrap[data-menu="voice"] .stage-menu button:has-text("Tenor")');
      await page.waitForFunction(() => /1 \/ 2/.test((document.querySelector('.stage-gallery-count') || {}).textContent || ''), null, { timeout: 5000 });
      await page.waitForFunction(() => /own\.mp3$/.test((document.querySelector('#_stage_audio audio') || {}).src || ''), null, { timeout: 5000 });
      if ((await pressed()).join() !== 'Tenor') throw new Error('Tenor not highlighted: ' + await pressed());
      if (await page.locator('.stage-menu-wrap[data-menu="sheet"] .stage-menu button').count() !== 2) throw new Error('sheet dropdown should offer the song and the voice');
      await page.click('.stage-gallery-nav.next');
      await page.waitForFunction(() => /2 \/ 2/.test(document.querySelector('.stage-gallery-count').textContent), null, { timeout: 5000 });
      // Back to Listen: its track again, the voice button keeps "Tenor" but is not highlighted.
      await page.click('.stage-controls [data-fk="track"]');
      await page.waitForFunction(() => /ref\.mp3$/.test(document.querySelector('#_stage_audio audio').src), null, { timeout: 5000 });
      if ((await pressed()).join() !== 'Listen') throw new Error('Listen not highlighted again');
      if (!/Tenor/.test(await page.textContent('.stage-menu-wrap[data-menu="voice"]'))) throw new Error('voice button lost its voice');
      // On Listen the sheet is the song's; the switch brings the voice's sheets without changing the track.
      if (await page.locator('.stage-gallery-count').count()) throw new Error('voice sheets still shown on Listen');
      await page.click('.stage-menu-wrap[data-menu="sheet"] .stage-menu-btn');
      await page.click('.stage-menu-wrap[data-menu="sheet"] .stage-menu button:has-text("Tenor")');
      await page.waitForFunction(() => /1 \/ 2/.test((document.querySelector('.stage-gallery-count') || {}).textContent || ''), null, { timeout: 5000 });
      if (!/ref\.mp3$/.test(await src())) throw new Error('the sheet switch changed the track');
      // One click on the voice button switches back to it.
      await page.click('.stage-controls [data-fk="voice"]');
      await page.waitForFunction(() => /own\.mp3$/.test(document.querySelector('#_stage_audio audio').src), null, { timeout: 5000 });
      await page.waitForSelector('.stage-gallery', { timeout: 5000 });
      // Sheet images: centred, half the screen; the header at most 3/4 of it.
      await page.setViewportSize({ width: 1400, height: 900 });
      const g = await page.evaluate(() => {
        const r = e => document.querySelector(e).getBoundingClientRect();
        return { img: r('.stage-gallery'), head: r('.stage-header'), w: document.documentElement.clientWidth };
      });
      if (Math.abs(g.img.width - g.w / 2) > 4 || Math.abs((g.img.left + g.img.width / 2) - g.w / 2) > 4)
        throw new Error('sheet is not centred at half width: ' + JSON.stringify(g.img));
      if (g.head.width > g.w * 0.75 + 2 || Math.abs((g.head.left + g.head.width / 2) - g.w / 2) > 4)
        throw new Error('header is not centred within 3/4: ' + JSON.stringify(g.head));
      await page.setViewportSize({ width: 1280, height: 720 });
      // A selected button deselects on a second click: the track goes, and the speed with it.
      await page.click('.stage-controls [data-fk="voice"]');
      await page.waitForFunction(() => !document.querySelector('#_stage_audio audio'), null, { timeout: 5000 });
      if (await page.locator('.stage-menu-wrap[data-menu="rate"]').count()) throw new Error('speed still shown without a track');
      if ((await pressed()).length) throw new Error('something still highlighted: ' + await pressed());
      // The sheet picked on purpose stays until it is deselected itself.
      if (!await page.locator('.stage-gallery').count()) throw new Error('a sheet picked on purpose went with the track');
      await page.click('.stage-menu-wrap[data-menu="sheet"] .stage-menu-btn');
      await page.click('.stage-menu-wrap[data-menu="sheet"] .stage-menu button[aria-checked="true"]');
      await page.waitForFunction(() => !document.querySelector('.stage-gallery'), null, { timeout: 5000 });
      // Choosing a track again brings it back, with the sheet that follows it.
      await page.click('.stage-controls [data-fk="track"]');
      await page.waitForFunction(() => /ref\.mp3$/.test((document.querySelector('#_stage_audio audio') || {}).src || ''), null, { timeout: 5000 });
      await page.waitForSelector('.stage-gallery', { timeout: 5000 });
      if (!await page.locator('.stage-menu-wrap[data-menu="rate"]').count()) throw new Error('speed did not come back');
      // The sheet button itself hides the sheet while the track plays on, and shows it again.
      await page.click('.stage-controls [data-fk="sheet"]');
      await page.waitForFunction(() => !document.querySelector('.stage-gallery'), null, { timeout: 5000 });
      if (!await page.locator('#_stage_audio audio').count()) throw new Error('hiding the sheet stopped the track');
      await page.click('.stage-controls [data-fk="sheet"]');
      await page.waitForSelector('.stage-gallery', { timeout: 5000 });
      // The export carries the selection; "All sheets in the export" carries every sheet.
      await page.emulateMedia({ media: 'print' });
      const shown = () => page.evaluate(() => ({
        player: getComputedStyle(document.getElementById('_stage_player')).display,
        gallery: document.querySelector('.stage-gallery') ? getComputedStyle(document.querySelector('.stage-gallery')).display : 'none',
        all: document.querySelector('.stage-print') ? getComputedStyle(document.querySelector('.stage-print')).display : 'none',
        sheets: document.querySelectorAll('.stage-print-sheet').length,
        controls: getComputedStyle(document.querySelector('.stage-controls')).display }));
      let p1 = await shown();
      if (p1.player !== 'none' || p1.controls !== 'none' || p1.gallery !== 'none' || p1.all === 'none' || p1.sheets !== 1) throw new Error('print without the option: ' + JSON.stringify(p1));
      await page.emulateMedia({ media: 'screen' });
      if (await page.locator('.stage-menu-wrap[data-menu="sheet"] .stage-menu button:has-text("All sheets")').count()) throw new Error('the export switch is still in the sheet menu');
      await page.click('#stage-share-btn');
      await page.click('#stage-allsheets-btn');
      if (await page.getAttribute('#stage-allsheets-btn', 'aria-checked') !== 'true') throw new Error('export switch not checked');
      await page.click('#stage-share-btn');
      await page.waitForFunction(() => document.querySelectorAll('.stage-print-sheet').length === 2, null, { timeout: 5000 });
      if (await page.locator('.stage-print').isVisible()) throw new Error('every sheet shows on screen');
      await page.emulateMedia({ media: 'print' });
      p1 = await shown();
      if (p1.all === 'none' || p1.gallery !== 'none' || p1.sheets !== 2) throw new Error('print with the option: ' + JSON.stringify(p1));
      await page.emulateMedia({ media: 'screen' });
      assertClean(log.take(), 'stage melody');

      await page.goto(`${BASE}/${SLUG}/songs`);
      await settle(page);
      // The overview lists what is filled in, the voices included, and has no speed buttons.
      await sql`INSERT INTO song_media (song_id, artist_id, kind, url) SELECT id, artist_id, 'playback', ${BASE + '/pb.mp3'} FROM songs WHERE id = ${songId}`;
      await page.reload();
      await settle(page);
      await page.evaluate(id => window._openSongPanelById(id), songId);
      await page.waitForFunction(id => /Tenor/.test((document.getElementById('vsp-contents-' + id) || {}).textContent || ''), songId, { timeout: 10000 });
      const overview = await page.evaluate(id => ({ text: document.getElementById('vsp-contents-' + id).textContent, speed: document.querySelectorAll('#view-side-panel-inner .audio-speed-btns').length }), songId);
      if (!/Playback/.test(overview.text) || !/Lyrics/i.test(overview.text)) throw new Error('overview misses entries: ' + overview.text);
      if (overview.speed) throw new Error('speed buttons in the overview');
      // New uploads carry their waveform: Playback and a voice's own recording, through the real upload code.
      await page.evaluate(async id => {
        const n = 8000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
        v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 12000 * (i / n)), true);
        const file = new File([buf], 'tone.wav', { type: 'audio/wav' });
        await window._uploadSongMedia(id, 'playback', file);
        await window.melodyUpload(id, 'TEN', 'audio', file);
      }, songId);
      const [pb] = await sql`SELECT waveform AS w FROM song_media WHERE song_id = ${songId} AND kind = 'playback'`;
      const [mw] = await sql`SELECT waveform AS w FROM song_media WHERE song_id = ${songId} AND kind = 'instrument' AND instrument = 'TEN'`;
      if (!pb.w || pb.w.length !== 200) throw new Error('playback upload stored no waveform: ' + pb.w);
      if (!mw.w || mw.w.length !== 200) throw new Error('voice recording upload stored no waveform: ' + mw.w);
      await page.evaluate(id => window._openSongEditInPanel(id), songId);
      await page.waitForSelector('#melodies-body .melody-row', { state: 'attached', timeout: 10000 });
      assertClean(log.take(), 'songs melodies block');
    } finally {
      if (songId) {
        await sql`DELETE FROM songs WHERE id = ${songId}`;
      }
      await api('PATCH', cfgPath, { config: { arrangementConfig: before } });
      await sql.end();
    }
  });

  // Stage: the Listen recording shows its stored waveform, is the only player
  // when the song has melodies, the page uses the full width, and the offline
  // icon downloads and removes the setlist's copy.
  await check('stage: waveform, full width, offline icon', async () => {
    if (!process.env.DATABASE_URL) { console.log(D('      (skipped: no DATABASE_URL)')); return; }
    const postgres = require('postgres');
    const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
    await page.goto(`${BASE}/${SLUG}/dashboard`);
    await settle(page);
    const api = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
      const h = { Authorization: 'Bearer ' + (sessionStorage.getItem('smartist_token') || localStorage.getItem('smartist_token')),
                  'Content-Type': 'application/json' };
      const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json().catch(() => null) };
    }, { method, path, body });
    let songId = null, setId = null;
    try {
      const made = await api('POST', `/api/${SLUG}/songs`, { title: '[TEST] stage smoke' });
      songId = made.json.id;
      await api('PUT', `/api/${SLUG}/songs/${songId}/lyrics`, { lyrics: 'La la la' });
      await sql`INSERT INTO song_media (song_id, artist_id, kind, url, waveform) SELECT id, artist_id, 'listen', ${BASE + '/ref.mp3'}, ${'c0'.repeat(100)} FROM songs WHERE id = ${songId}`;
      setId = (await api('POST', `/api/${SLUG}/setlists`, { title: '[TEST] stage smoke', song_ids: [songId] })).json.id;

      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(`${BASE}/${SLUG}/stage?song=${songId}&from=${setId}`);
      await sql`INSERT INTO song_media (song_id, artist_id, kind, url, waveform) SELECT id, artist_id, 'playback', ${BASE + '/pb.mp3'}, ${'d0'.repeat(100)} FROM songs WHERE id = ${songId}`;
      await page.reload();
      await page.waitForSelector('canvas.stage-wave', { timeout: 10000 });
      if (await page.getAttribute('canvas.stage-wave', 'data-wave') !== 'c0'.repeat(100)) throw new Error('listen waveform not drawn first');
      await page.click('.stage-menu-wrap[data-menu="track"] .stage-menu-btn');
      await page.click('.stage-menu-wrap[data-menu="track"] .stage-menu button:has-text("Playback")');
      await page.click('.stage-menu-wrap[data-menu="rate"] .stage-menu-btn');
      await page.click('.stage-menu-wrap[data-menu="rate"] .stage-menu button:has-text("0.8")');
      if (await page.evaluate(() => document.querySelector('#_stage_audio audio').playbackRate) !== 0.8) throw new Error('speed dropdown did not apply');
      await page.waitForFunction(w => (document.querySelector('canvas.stage-wave') || {}).dataset?.wave === w, 'd0'.repeat(100), { timeout: 5000 });
      if (!/pb\.mp3$/.test(await page.getAttribute('#_stage_player audio', 'src'))) throw new Error('playback not loaded into the one player');
      const width = await page.evaluate(() => document.querySelector('.stage-wrap').getBoundingClientRect().width);
      if (width < 1300) throw new Error('stage is not full width: ' + width);
      const players = await page.evaluate(() => document.querySelectorAll('#stage-content audio').length);
      if (players !== 1) throw new Error('expected one player, found ' + players);

      // Fit to screen and Columns are toggles: pressed while on, and off restores the size.
      const lyricsPx = () => page.evaluate(() => document.getElementById('_stage_lyrics').style.fontSize);
      const pressedOf = id => page.getAttribute(id, 'aria-pressed');
      await page.evaluate(() => { localStorage.removeItem('stage_fit'); localStorage.removeItem('stage_cols'); });
      await page.reload();
      await page.waitForSelector('#_stage_fit_btn', { timeout: 10000 });
      const base = await lyricsPx();
      await page.click('#_stage_fit_btn');
      if (await pressedOf('#_stage_fit_btn') !== 'true') throw new Error('fit button not pressed after a click');
      if (await lyricsPx() === base) throw new Error('fit did not change the size');
      await page.reload();
      await page.waitForSelector('#_stage_fit_btn', { timeout: 10000 });
      if (await pressedOf('#_stage_fit_btn') !== 'true') throw new Error('fit did not stay on after a reload');
      await page.click('#_stage_fit_btn');
      if (await pressedOf('#_stage_fit_btn') !== 'false' || await lyricsPx() !== base) throw new Error('fit off did not restore the size');
      await page.click('#_stage_cols_btn');
      if (await pressedOf('#_stage_cols_btn') !== 'true') throw new Error('columns button not pressed');
      await page.click('#_stage_cols_btn');
      if (await pressedOf('#_stage_cols_btn') !== 'false') throw new Error('columns did not switch off');
      await page.evaluate(() => { localStorage.removeItem('stage_fit'); localStorage.removeItem('stage_cols'); });
      const btn = '#stage-offline-btn';
      await page.waitForSelector(btn, { timeout: 5000 });
      if (await page.getAttribute(btn, 'aria-pressed') !== 'false') throw new Error('should start grey');
      await page.click(btn);
      await page.waitForSelector(btn + '.kept', { timeout: 30000 });
      page.once('dialog', d => d.accept());
      await page.click(btn);
      await page.waitForFunction(b => !document.querySelector(b).classList.contains('kept'), btn, { timeout: 10000 });
      assertClean(log.take(), 'stage waveform / offline icon');
    } finally {
      if (setId) await api('DELETE', `/api/${SLUG}/setlists/${setId}`);
      if (songId) await sql`DELETE FROM songs WHERE id = ${songId}`;
      await sql.end();
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  });

  await browser.close();
  console.log(failed ? R(`\n${failed} failed`) : G('\nall pages clean'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
