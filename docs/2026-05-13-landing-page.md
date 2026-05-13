# smartist.studio Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public landing page at `smartist.studio` backed by the dev deployment, with a working email subscribe form.

**Architecture:** Static `app/landing.html` served via a `vercel.json` host-based rewrite when the request host is `smartist.studio`. Subscribe form POSTs to `POST /api/config` (new branch in the existing config handler — avoids exceeding the 12-function Hobby plan limit). Email rows stored in a new `subscribers` table in the Neon dev DB.

**Tech Stack:** Vanilla HTML/CSS/JS, Node.js serverless (Vercel), Neon PostgreSQL (neon serverless driver via `_db.js`), existing `_validate.js` + `_ratelimit.js` helpers.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `scripts/schema.sql` | Modify | Add `subscribers` table |
| `api/config.js` | Modify | Add `POST` branch for email subscribe |
| `tests/unit/subscribe.js` | Create | Unit tests for subscribe POST branch |
| `tests/unit.js` | Modify | Register subscribe suite |
| `app/landing.html` | Create | Self-contained landing page (no `common.js`) |
| `vercel.json` | Modify | Host-based rewrite for `smartist.studio` |
| `docs/2026-05-13-smartist-studio-landing-design.md` | Delete | Remove spec after implementation |

---

### Task 1: Add `subscribers` table to schema

**Files:**
- Modify: `scripts/schema.sql`

- [ ] **Append the following block to the end of `scripts/schema.sql`:**

```sql
-- ── subscribers ──────────────────────────────────────────────────────────────
-- Landing page email sign-ups. No confirmation flow — simple collection only.

CREATE TABLE IF NOT EXISTS subscribers (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'landing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Run migration against the dev DB:**

```bash
node scripts/migrate-schema.js
```

Expected: prompts for `y`, then prints `Done.` without errors.

- [ ] **Commit:**

```bash
git add scripts/schema.sql
git commit -m "feat: add subscribers table to schema"
```

---

### Task 2: Unit tests for subscribe POST branch (write first, then implement)

**Files:**
- Create: `tests/unit/subscribe.js`

- [ ] **Create `tests/unit/subscribe.js` with the following content:**

```js
'use strict';
const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

// Stub _logger and _ratelimit at module level before config.js is required.
stubLogger();
const ratelimitPath = require.resolve(path.join(__dirname, '../../api/_ratelimit'));
if (!require.cache[ratelimitPath]) {
  require.cache[ratelimitPath] = {
    id: ratelimitPath, filename: ratelimitPath, loaded: true,
    exports: {
      checkRateLimit: async () => false,
      clientIp: () => '127.0.0.1',
      isMissingRateLimitTable: () => false,
    },
  };
}

// Re-require config.js with a given sql tagged-template stub.
function makeHandler(sqlFn) {
  const dbPath = require.resolve(path.join(__dirname, '../../api/_db'));
  const configPath = require.resolve(path.join(__dirname, '../../api/config'));
  delete require.cache[dbPath];
  delete require.cache[configPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sqlFn,
      getBand: async () => ({ id: 1, slug: 'test', name: 'Test', config: {} }),
    },
  };
  return require(path.join(__dirname, '../../api/config'));
}

function mockRes() {
  const r = {};
  r.status = (s) => { r._status = s; return r; };
  r.json   = (b) => { r._body  = b; return r; };
  r._status = 200;
  return r;
}

async function run(r) {
  const { testAsync, assertEq } = r;

  await testAsync('POST /api/config subscribe — missing email → 400', async () => {
    const handler = makeHandler((s, ...v) => Promise.resolve([]));
    const res = mockRes();
    await handler({ method: 'POST', body: {} }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config subscribe — invalid email → 400', async () => {
    const handler = makeHandler((s, ...v) => Promise.resolve([]));
    const res = mockRes();
    await handler({ method: 'POST', body: { email: 'notanemail' } }, res);
    assertEq(res._status, 400);
  });

  await testAsync('POST /api/config subscribe — duplicate email → 409', async () => {
    const dupErr = Object.assign(new Error('unique violation'), { code: '23505' });
    const handler = makeHandler((s, ...v) => Promise.reject(dupErr));
    const res = mockRes();
    await handler({ method: 'POST', body: { email: 'a@b.com' } }, res);
    assertEq(res._status, 409);
  });

  await testAsync('POST /api/config subscribe — valid email → 200', async () => {
    const handler = makeHandler((s, ...v) => Promise.resolve([]));
    const res = mockRes();
    await handler({ method: 'POST', body: { email: 'hello@example.com' } }, res);
    assertEq(res._status, 200);
    assertEq(res._body?.ok, true);
  });
}

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => process.exit(r.summary() > 0 ? 1 : 0));
}
module.exports = run;
```

- [ ] **Run the test — confirm it fails (subscribe branch not yet implemented):**

```bash
node tests/unit/subscribe.js
```

Expected: all 4 tests fail with something like `TypeError: handler is not a function` or `expected 400, got 200`.

---

### Task 3: Implement subscribe POST branch in `api/config.js`

**Files:**
- Modify: `api/config.js`

- [ ] **Replace the entire contents of `api/config.js` with:**

```js
const { getBand, getDb } = require('./_db');
const { wrap } = require('./_handler');
const { validateEmail } = require('./_validate');
const { checkRateLimit, clientIp } = require('./_ratelimit');

module.exports = wrap(async function handler(req, res) {
  if (req.method === 'POST') {
    const email = validateEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Valid email required' });

    if (await checkRateLimit(`subscribe:${clientIp(req)}`, 5, 3600))
      return res.status(429).json({ error: 'Too many requests — try again later' });

    const sql = getDb();
    try {
      await sql`INSERT INTO subscribers (email, source) VALUES (${email}, 'landing')`;
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Already subscribed' });
      throw err;
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const slug = process.env.BAND_SLUG;
  if (!slug) return res.status(500).json({ error: 'BAND_SLUG not configured' });
  const band = await getBand(slug);
  if (!band) return res.status(404).json({ error: 'Band not found in database' });

  const sql = getDb();
  const songs = await sql`
    SELECT s.*, g.iswc, g.gema_work_number, g.language AS gema_language
    FROM songs s
    LEFT JOIN LATERAL (
      SELECT iswc, gema_work_number, language
      FROM gema_works
      WHERE song_id = s.id
      ORDER BY gema_work_number
      LIMIT 1
    ) g ON true
    WHERE s.band_id = ${band.id} AND s.deleted = false
    ORDER BY s.title
  `;

  res.json({ slug: band.slug, name: band.name, config: band.config, songs });
});
```

- [ ] **Run the subscribe tests — all 4 must pass:**

```bash
node tests/unit/subscribe.js
```

Expected output:
```
  ✓ POST /api/config subscribe — missing email → 400
  ✓ POST /api/config subscribe — invalid email → 400
  ✓ POST /api/config subscribe — duplicate email → 409
  ✓ POST /api/config subscribe — valid email → 200

────────────────────────────────────────
4 passed  0 failed
```

- [ ] **Commit:**

```bash
git add api/config.js tests/unit/subscribe.js
git commit -m "feat: add email subscribe POST branch to config handler"
```

---

### Task 4: Register subscribe suite in the test runner

**Files:**
- Modify: `tests/unit.js`

- [ ] **Add `require('./unit/subscribe')` to the suites array in `tests/unit.js`:**

```js
const suites = [
  require('./unit/validate'),
  require('./unit/token'),
  require('./unit/pdf'),
  require('./unit/r2'),
  require('./unit/lyrics'),
  require('./unit/ratelimit'),
  require('./unit/gema'),
  require('./unit/ai'),
  require('./unit/handler'),
  require('./unit/subscribe'),
];
```

- [ ] **Run the full suite — all tests must pass:**

```bash
node tests/unit.js
```

Expected: previous count + 4 new passing tests, 0 failed.

- [ ] **Commit:**

```bash
git add tests/unit.js
git commit -m "test: register subscribe suite in unit runner"
```

---

### Task 5: Create `app/landing.html`

**Files:**
- Create: `app/landing.html`

- [ ] **Create `app/landing.html` with the following content** (production version of the approved mockup — frame-note and feedback bar removed, real links wired, subscribe JS added):

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>smartist — band management tools</title>
<meta name="description" content="Setlist generator, song catalogue, PRO reporting, gig management — the toolkit independent musicians actually need.">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', Courier, monospace; background: #f5f0ea; color: #1a1a1a; -webkit-text-size-adjust: 100%; }

  /* ── Header ── */
  .site-header { padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #ddd5c8; }
  .site-header .wordmark { font-size: 1rem; font-weight: 700; letter-spacing: 0.12em; }
  .site-header nav a { font-size: 0.68rem; color: #999; text-decoration: none; letter-spacing: 0.1em; margin-left: 18px; }
  .site-header nav a:hover { color: #b06a2a; }
  @media (min-width: 640px) {
    .site-header { padding: 20px 40px; }
    .site-header .wordmark { font-size: 1.1rem; }
    .site-header nav a { font-size: 0.72rem; margin-left: 24px; }
  }

  /* ── Hero ── */
  .hero { max-width: 680px; margin: 0 auto; padding: 72px 40px 56px; position: relative; overflow: hidden; }
  .hero-label { font-size: 0.65rem; letter-spacing: 0.3em; text-transform: uppercase; color: #b06a2a; margin-bottom: 20px; }
  .hero h1 { font-size: clamp(1.6rem, 4vw, 2.4rem); font-weight: 700; line-height: 1.2; letter-spacing: 0.02em; margin-bottom: 20px; }
  .hero h1 em { font-style: normal; color: #b06a2a; }
  .divider { width: 40px; height: 2px; background: #b06a2a; margin-bottom: 20px; }
  .hero p { font-size: 0.92rem; color: #666; line-height: 1.7; max-width: 480px; margin-bottom: 36px; }
  .cta-btn { display: inline-block; padding: 12px 30px; border: 1.5px solid #b06a2a; color: #b06a2a; font-family: 'Courier New', monospace; font-size: 0.78rem; letter-spacing: 0.22em; text-transform: uppercase; text-decoration: none; border-radius: 2px; transition: background 0.15s, color 0.15s; }
  .cta-btn:hover, .cta-btn:focus { background: #b06a2a; color: #f5f0ea; }

  .hero-waveform { position: absolute; right: 0; top: 48px; display: flex; align-items: flex-end; gap: 3px; opacity: 0.1; pointer-events: none; }
  .hero-waveform span { display: block; width: 3px; background: #b06a2a; border-radius: 1px; }

  /* ── Feature strip ── */
  .features { background: #ede5d8; margin: 0 16px 32px; border: 1px solid #ddd5c8; border-radius: 3px; box-shadow: 0 4px 20px rgba(0,0,0,0.07); }
  .features-inner { display: flex; flex-wrap: wrap; }
  .feature-tile h3 { font-size: 0.65rem; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: #b06a2a; margin-bottom: 8px; }
  .feature-tile p { font-size: 0.69rem; color: #666; line-height: 1.6; }
  .feature-tile .badge { display: inline-block; font-size: 0.49rem; letter-spacing: 0.14em; text-transform: uppercase; padding: 2px 6px; border: 1px solid #c89060; color: #c89060; border-radius: 2px; margin-bottom: 7px; }
  .feature-tile { flex: 0 0 100%; padding: 18px 16px; border-right: none; border-bottom: 1px solid #ddd5c8; }
  .feature-tile:last-child { border-bottom: none; }
  @media (min-width: 360px) {
    .feature-tile { flex: 0 0 50%; border-right: 1px solid #ddd5c8; border-bottom: 1px solid #ddd5c8; }
    .feature-tile:last-child { border-bottom: 1px solid #ddd5c8; }
    .feature-tile:nth-child(2n) { border-right: none; }
    .feature-tile:nth-last-child(-n+2) { border-bottom: none; }
  }
  @media (min-width: 540px) {
    .feature-tile { flex: 0 0 25%; }
    .feature-tile:nth-child(2n) { border-right: 1px solid #ddd5c8; }
    .feature-tile:nth-child(4n) { border-right: none; }
    .feature-tile:nth-last-child(-n+2) { border-bottom: 1px solid #ddd5c8; }
    .feature-tile:nth-last-child(-n+4) { border-bottom: none; }
  }
  @media (min-width: 1050px) {
    .features { margin: 0; border: none; border-top: 1px solid #ddd5c8; border-bottom: 1px solid #ddd5c8; border-radius: 0; box-shadow: none; }
    .features-inner { flex-wrap: nowrap; }
    .feature-tile { flex: 1 1 0; padding: 26px 16px; border-right: 1px solid #ddd5c8; border-bottom: none; }
    .feature-tile:nth-child(4n) { border-right: 1px solid #ddd5c8; }
    .feature-tile:nth-last-child(-n+4) { border-bottom: none; }
    .feature-tile:last-child { border-right: none; }
  }

  /* ── Bottom section ── */
  .bottom { border-top: 1px solid #ddd5c8; padding: 48px 20px; }
  .bottom-inner { max-width: 640px; margin: 0 auto; }
  .bottom-label { font-size: 0.6rem; letter-spacing: 0.3em; text-transform: uppercase; color: #b06a2a; margin-bottom: 8px; }
  .bottom-intro { font-size: 0.85rem; color: #555; line-height: 1.7; margin-bottom: 36px; }
  .bottom-intro a { color: #b06a2a; text-decoration: underline; }
  @media (min-width: 640px) {
    .bottom { padding: 64px 40px; }
    .bottom-intro { font-size: 0.88rem; max-width: 500px; }
  }
  .plans { display: grid; grid-template-columns: 1fr; gap: 12px; margin-bottom: 44px; }
  @media (min-width: 560px) { .plans { grid-template-columns: 1fr 1fr; gap: 16px; } }
  .plan { padding: 24px 20px; border: 1px solid #ddd5c8; border-radius: 2px; background: #f9f5ef; }
  .plan.featured { background: #2e2e2e; border-color: #2e2e2e; }
  .plan h3 { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #b06a2a; margin-bottom: 8px; }
  .plan.featured h3 { color: #f9bf8f; }
  .plan .plan-headline { font-size: 1rem; font-weight: 700; color: #1a1a1a; margin-bottom: 10px; line-height: 1.3; }
  .plan.featured .plan-headline { color: #f5f0ea; }
  .plan p { font-size: 0.73rem; color: #777; line-height: 1.65; }
  .plan.featured p { color: #888; }
  .plan ul { margin-top: 14px; list-style: none; }
  .plan ul li { font-size: 0.68rem; color: #666; padding: 3px 0; letter-spacing: 0.03em; }
  .plan ul li::before { content: '— '; color: #b06a2a; }
  .plan.featured ul li { color: #aaa; }
  .plan.featured ul li::before { color: #f9bf8f; }
  .plan-cta { display: inline-block; margin-top: 18px; font-size: 0.66rem; letter-spacing: 0.18em; text-transform: uppercase; color: #b06a2a; text-decoration: none; border-bottom: 1px solid #b06a2a; padding-bottom: 1px; }
  .plan.featured .plan-cta { color: #f9bf8f; border-color: #f9bf8f; }
  .subscribe { border-top: 1px solid #ddd5c8; padding-top: 32px; }
  .subscribe p { font-size: 0.76rem; color: #666; margin-bottom: 14px; line-height: 1.6; }
  .subscribe-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .subscribe-row input { flex: 1 1 180px; padding: 10px 14px; border: 1px solid #ddd5c8; background: #f9f5ef; font-family: 'Courier New', monospace; font-size: 0.75rem; color: #1a1a1a; border-radius: 2px; outline: none; min-width: 0; }
  .subscribe-row input::placeholder { color: #bbb; }
  .subscribe-row button { flex: 0 0 auto; padding: 10px 16px; background: transparent; border: 1px solid #b06a2a; color: #b06a2a; font-family: 'Courier New', monospace; font-size: 0.66rem; letter-spacing: 0.15em; text-transform: uppercase; cursor: pointer; border-radius: 2px; transition: background 0.15s, color 0.15s; }
  .subscribe-row button:hover { background: #b06a2a; color: #f5f0ea; }
  .subscribe-msg { font-size: 0.72rem; margin-top: 10px; color: #888; letter-spacing: 0.05em; min-height: 1.2em; }

  /* ── Footer ── */
  .site-footer { border-top: 1px solid #ddd5c8; padding: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .site-footer .wordmark { font-size: 0.8rem; font-weight: 700; letter-spacing: 0.12em; color: #aaa; }
  .site-footer p { font-size: 0.62rem; color: #bbb; letter-spacing: 0.08em; }
  @media (min-width: 640px) { .site-footer { padding: 24px 40px; } }
</style>
</head>
<body>

<header class="site-header">
  <span class="wordmark">smartist</span>
  <nav>
    <a href="https://github.com/kevinsieg/smartist">github</a>
    <a href="mailto:sieg.kevin@gmx.de">contact</a>
  </nav>
</header>

<section class="hero">
  <div class="hero-waveform" aria-hidden="true">
    <span style="height:10px"></span><span style="height:18px"></span><span style="height:28px"></span>
    <span style="height:20px"></span><span style="height:38px"></span><span style="height:26px"></span>
    <span style="height:52px"></span><span style="height:36px"></span><span style="height:64px"></span>
    <span style="height:44px"></span><span style="height:72px"></span><span style="height:52px"></span>
    <span style="height:80px"></span><span style="height:60px"></span><span style="height:88px"></span>
    <span style="height:68px"></span><span style="height:80px"></span><span style="height:56px"></span>
    <span style="height:92px"></span><span style="height:64px"></span><span style="height:76px"></span>
    <span style="height:48px"></span><span style="height:60px"></span><span style="height:36px"></span>
    <span style="height:48px"></span><span style="height:28px"></span><span style="height:40px"></span>
    <span style="height:22px"></span><span style="height:32px"></span><span style="height:16px"></span>
    <span style="height:26px"></span><span style="height:12px"></span><span style="height:20px"></span>
    <span style="height:8px"></span><span style="height:14px"></span><span style="height:6px"></span>
  </div>
  <div class="hero-label">band management tools</div>
  <h1>The toolkit independent musicians <em>actually</em> need.</h1>
  <div class="divider"></div>
  <p>Streamline your artist organisation and keep the full overview — setlists, song catalogue, PRO reporting, social reach, platform availability. Built by a musician, for musicians. No subscriptions. No bloat.</p>
  <a class="cta-btn" href="/setlist">Open demo →</a>
</section>

<section class="features" aria-label="Features">
  <div class="features-inner">
    <div class="feature-tile">
      <span class="badge">sets</span>
      <h3>Setlists</h3>
      <p>Generate by energy, duration, and feel. Drag-and-drop reorder. Save to gigs. Share as PDF.</p>
    </div>
    <div class="feature-tile">
      <span class="badge">library</span>
      <h3>Songs</h3>
      <p>Full catalogue with play count, AI lyrics, audio and sheet music attachments, full change log.</p>
    </div>
    <div class="feature-tile">
      <span class="badge">rights</span>
      <h3>PRO</h3>
      <p>Import performing rights organisation data — CSV with dry-run preview and catalogue auto-matching.</p>
    </div>
    <div class="feature-tile">
      <span class="badge">gigs</span>
      <h3>Gig management</h3>
      <p>Venues, contracts, set times, contacts, and finances — linked to your setlists.</p>
    </div>
    <div class="feature-tile">
      <span class="badge">venues</span>
      <h3>Venue database</h3>
      <p>Searchable profiles with capacity, genre fit, booking contacts, and fee history.</p>
    </div>
    <div class="feature-tile">
      <span class="badge">AI</span>
      <h3>Tour planning</h3>
      <p>AI-optimised routing, booking outreach, revenue forecast, conflict detection.</p>
    </div>
    <div class="feature-tile">
      <span class="badge">insights</span>
      <h3>Artist Hub</h3>
      <p>Song availability across platforms, social media reach, physical sales, and streaming integrations.</p>
    </div>
    <div class="feature-tile">
      <span class="badge">live</span>
      <h3>Stage view</h3>
      <p>Full-screen setlist display built for the stage. Song, key, capo, and notes — nothing else.</p>
    </div>
  </div>
</section>

<section class="bottom">
  <div class="bottom-inner">
    <div class="bottom-label">open source · self-hosted · managed</div>
    <p class="bottom-intro">
      smartist is open source. Run it yourself for free —
      full source on <a href="https://github.com/kevinsieg/smartist">GitHub</a> — or let us handle hosting, updates, and integrations with a managed subscription.
    </p>
    <div class="plans">
      <div class="plan">
        <h3>Self-hosted</h3>
        <div class="plan-headline">Free forever.</div>
        <p>Deploy to your own Vercel account. Full source, MIT licensed. One band, one database, yours to own.</p>
        <ul>
          <li>Full source on GitHub</li>
          <li>Vercel + Neon setup</li>
          <li>Community support</li>
          <li>MIT licence</li>
        </ul>
        <a class="plan-cta" href="https://github.com/kevinsieg/smartist">View on GitHub →</a>
      </div>
      <div class="plan featured">
        <h3>Managed</h3>
        <div class="plan-headline">We handle everything.</div>
        <p>Your band is live in 24 hours. Hosting, backups, domain, integrations — all included. Cancel anytime.</p>
        <ul>
          <li>Hosted on your domain</li>
          <li>Backups &amp; uptime monitoring</li>
          <li>PRO &amp; R2 integration setup</li>
          <li>Priority support</li>
        </ul>
        <a class="plan-cta" href="mailto:sieg.kevin@gmx.de">Get in touch →</a>
      </div>
    </div>
    <div class="subscribe">
      <p>Stay in the loop — early access, feature releases, and launch news.</p>
      <div class="subscribe-row">
        <input id="sub-email" type="email" placeholder="your@email.com" autocomplete="email">
        <button id="sub-btn" type="button">Subscribe</button>
      </div>
      <div class="subscribe-msg" id="sub-msg" aria-live="polite"></div>
    </div>
  </div>
</section>

<footer class="site-footer">
  <span class="wordmark">smartist</span>
  <p>open source · MIT · built by a working musician · 2026</p>
</footer>

<script>
(function () {
  var btn = document.getElementById('sub-btn');
  var input = document.getElementById('sub-email');
  var msg = document.getElementById('sub-msg');

  btn.addEventListener('click', function () {
    var email = input.value.trim();
    if (!email) { msg.textContent = 'Enter your email address.'; return; }
    btn.disabled = true;
    msg.textContent = '';
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
      .then(function (r) {
        if (r.ok) {
          input.value = '';
          msg.textContent = 'You\'re in — we\'ll be in touch.';
          btn.textContent = 'Done';
        } else if (r.status === 409) {
          msg.textContent = 'That address is already subscribed.';
          btn.disabled = false;
        } else {
          msg.textContent = r.data.error || 'Something went wrong — try again.';
          btn.disabled = false;
        }
      })
      .catch(function () {
        msg.textContent = 'Network error — try again.';
        btn.disabled = false;
      });
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') btn.click();
  });
}());
</script>
</body>
</html>
```

- [ ] **Commit:**

```bash
git add app/landing.html
git commit -m "feat: add smartist.studio landing page"
```

---

### Task 6: Add host-based rewrite in `vercel.json`

**Files:**
- Modify: `vercel.json`

The new rewrite rules must appear **before** the existing `{ "source": "/" }` rule so Vercel processes them first.

- [ ] **Replace the `"rewrites"` array in `vercel.json` with the following** (two new rules prepended, rest unchanged):

```json
"rewrites": [
  { "source": "/", "has": [{ "type": "host", "value": "smartist.studio" }], "destination": "/app/landing.html" },
  { "source": "/", "has": [{ "type": "host", "value": "www.smartist.studio" }], "destination": "/app/landing.html" },
  { "source": "/",                "destination": "/app/index.html" },
  { "source": "/api/docs",        "destination": "/app/api-docs.html" },
  { "source": "/setlist",         "destination": "/app/setlist.html" },
  { "source": "/setlist-history", "destination": "/app/setlist-history.html" },
  { "source": "/songs",           "destination": "/app/songs.html" },
  { "source": "/stage",           "destination": "/app/stage.html" },
  { "source": "/gema-import",     "destination": "/app/gema-import.html" }
]
```

- [ ] **Commit:**

```bash
git add vercel.json
git commit -m "feat: add smartist.studio host-based landing page rewrite"
```

---

### Task 7: Run full test suite and push

- [ ] **Run all unit tests:**

```bash
node tests/unit.js
```

Expected: all tests pass (previous count + 4 subscribe tests), 0 failed.

- [ ] **Push to dev:**

```bash
git push
```

Vercel will build and deploy the preview. Confirm the deployment succeeds in the Vercel dashboard.

---

### Task 8: Configure custom domain in Vercel + DNS on OVH

These steps are done via the Vercel dashboard and OVH control panel — no code changes.

- [ ] **In the Vercel dashboard:** open the **dev** project → Settings → Domains → add `smartist.studio` and `www.smartist.studio`.

- [ ] **On OVH:** in the DNS zone for `smartist.studio`:
  - Add an `A` record for `@` → `76.76.21.21`
  - Add a `CNAME` record for `www` → `cname.vercel-dns.com`

- [ ] **Back in Vercel:** wait for DNS propagation (usually a few minutes), then confirm both domains show a green TLS certificate.

- [ ] **Smoke test:** open `https://smartist.studio` in a browser — confirm the landing page loads. Open `https://smartist.studio/setlist` — confirm the app loads (demo band visible). Submit a test email in the subscribe form — confirm `200 ok` and the success message.

---

### Task 9: Delete spec and final cleanup commit

- [ ] **Delete the design spec:**

```bash
git rm docs/2026-05-13-smartist-studio-landing-design.md
git commit -m "chore: remove landing page design spec after implementation"
```

---

## Self-review checklist

- [x] **Schema coverage** — `subscribers` table added in Task 1
- [x] **Subscribe endpoint** — POST branch in `api/config.js`, stays within 12-function limit
- [x] **Tests** — 4 unit tests covering missing/invalid/duplicate/valid email; registered in orchestrator
- [x] **Landing HTML** — complete file with real GitHub links, mailto contact, `/setlist` CTA, subscribe JS
- [x] **vercel.json rewrite** — two `has`-host rules before the existing `"/"` rule
- [x] **DNS steps** — explicit A + CNAME records documented
- [x] **Spec deletion** — Task 9
- [x] **No TBD/placeholders** — all code blocks are complete and executable
- [x] **Type consistency** — `validateEmail`, `checkRateLimit`, `clientIp` signatures match their definitions in `_validate.js` and `_ratelimit.js`
