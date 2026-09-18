# Kevin Klang gigdb import — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the cleaned gigdb export (songs, GEMA works, covers, gigs + setlists, organizers, venues) into the `klang` workspace on the smartist-demo DB, with venue `phone`/`contact_name` supported end to end.

**Architecture:**
- Committed app changes: schema columns, venues API, venue modal fields, organizer type options, i18n.
- Local, gitignored pipeline in `data/`: `clean.js` (CSV → JSON + `REPORT.md`), `check_venues.js` (website verification) and `import.js` (one postgres.js transaction, idempotent via natural keys, `--dry-run` rolls back).

**Tech Stack:** Node 22, postgres.js (`postgres`), Neon PostgreSQL, vanilla JS front end, custom unit runner (`tests/unit/_runner.js`).

**Spec:** `docs/2026-09-17-klang-gigdb-import-design.md`

## Global Constraints

- Target artist slug: `klang`. Salmons and CK data is excluded.
- Venues: add only `phone TEXT` and `contact_name TEXT`. No website status or verification columns.
- API limits: `phone` validateStr 100, `contact_name` validateStr 200.
- Energy: keep the export's 1–10 numbers as text.
- Values map to existing app values only; the original value goes into `comment`. Exception: organizer type gains `event`, `press`, `radio`.
- Dead venue websites → `website = NULL` plus a comment note; the venue is still imported. Still-unclear websites are listed in `REPORT.md`.
- The demo DB is the `DATABASE_URL` in local `.env`. Never write credentials into files; never edit `.env`.
- Everything in `data/` stays gitignored. Do not commit or push without the user's explicit go (user rule). Commit messages have no Claude attribution (user rule).
- i18n: every new key goes into `en`, `fr` and `de`; bump `I18N_VERSION` in `app/js/i18n.js` and every `i18n.js?v=` query (20 pages).

---

### Task 1: Venue `phone` + `contact_name` — schema and API

**Files:**
- Modify: `scripts/schema.sql` (append after the last `ALTER TABLE venues` block)
- Modify: `DATABASE.md` (venues column table, after `generic_email`)
- Modify: `api/[artist]/venues.js` (POST validation + INSERT)
- Modify: `api/[artist]/venues/[...path].js` (PUT validation + UPDATE)
- Create: `tests/unit/venue_handlers.js`
- Modify: `tests/unit.js` (register suite)

**Interfaces:**
- Produces: `venues.phone`, `venues.contact_name` columns.
  - POST/PUT bodies accept `phone` (≤100 chars) and `contact_name` (≤200 chars).
  - Too long → 400 `{ error: 'phone too long' | 'contact_name too long' }`.
  - PUT with the field omitted keeps the stored value.

- [ ] **Step 1: Write the failing test** — `tests/unit/venue_handlers.js`

```js
'use strict';

// Venue POST/PUT handling of the phone and contact_name fields.

const path = require('path');
const { makeRunner, stubLogger } = require('./_runner');

stubLogger();

const ARTIST = { id: 1, slug: 'test', name: 'Test Band', config: { plan: 'pro' } };

function mp(rel) { return require.resolve(path.join(__dirname, '../..', rel)); }

function mockRes() {
  const r = { statusCode: 200, headersSent: false };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; r.headersSent = true; return r; };
  r.setHeader = () => {};
  return r;
}

// Records every statement with its interpolated values; route(text) answers.
function loadHandler(rel, route) {
  const dbPath = mp('api/_db'), authPath = mp('api/_auth'), handlerPath = mp(rel);
  for (const p of [dbPath, authPath, handlerPath]) delete require.cache[p];
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    return route(text);
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      getDb: () => sql,
      getArtist: async () => ARTIST,
      getSlug: () => 'test',
      insertAuditLog: async () => {},
      parsePage: () => ({ limit: 50, offset: 0 }),
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
      requireAuth: async req => { req.user = { id: 1, role: 'member' }; return ARTIST; },
      getAccess: async () => ({ artist: ARTIST, user: { id: 1, role: 'member' } }),
      isPrivate: () => false,
    },
  };
  return { handler: require(path.join(__dirname, '../..', rel)), calls };
}

async function call(handler, method, body, query = {}) {
  const res = mockRes();
  await handler({ method, url: '/api/test/venues/5', query: { artist: 'test', ...query }, headers: {}, body }, res);
  return res;
}

const STORED = { id: 5, artist_id: 1, name: 'Old', deleted: false, phone: '+49 1', contact_name: 'Anna', social_links: {} };

async function run(r) {
  const { testAsync, assert, assertEq } = r;
  console.log(r.B('\nvenue handlers (phone, contact_name)'));

  await testAsync('POST stores phone and contact_name', async () => {
    const { handler, calls } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', { name: 'Club', phone: ' 0711 123 ', contact_name: 'Max' });
    assertEq(res.statusCode, 201);
    const insert = calls.find(c => c.text.startsWith('INSERT INTO venues'));
    assert(insert.text.includes('phone') && insert.text.includes('contact_name'), 'columns missing in INSERT');
    assert(insert.values.includes('0711 123'), 'trimmed phone not passed');
    assert(insert.values.includes('Max'), 'contact_name not passed');
  });

  await testAsync('POST rejects phone over 100 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', { name: 'Club', phone: 'x'.repeat(101) });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'phone too long');
  });

  await testAsync('POST rejects contact_name over 200 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues.js', () => [{ id: 9 }]);
    const res = await call(handler, 'POST', { name: 'Club', contact_name: 'x'.repeat(201) });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'contact_name too long');
  });

  await testAsync('PUT updates phone and contact_name', async () => {
    const { handler, calls } = loadHandler('api/[artist]/venues/[...path].js',
      text => (text.startsWith('SELECT * FROM venues') ? [STORED] : [{ ...STORED }]));
    const res = await call(handler, 'PUT', { name: 'Old', phone: '+41 2', contact_name: 'Ben' }, { path: ['5'] });
    assertEq(res.statusCode, 200);
    const update = calls.find(c => c.text.startsWith('UPDATE venues'));
    assert(update.values.includes('+41 2') && update.values.includes('Ben'), 'new values not passed to UPDATE');
  });

  await testAsync('PUT without the fields keeps stored values', async () => {
    const { handler, calls } = loadHandler('api/[artist]/venues/[...path].js',
      text => (text.startsWith('SELECT * FROM venues') ? [STORED] : [{ ...STORED }]));
    const res = await call(handler, 'PUT', { name: 'Old' }, { path: ['5'] });
    assertEq(res.statusCode, 200);
    const update = calls.find(c => c.text.startsWith('UPDATE venues'));
    assert(update.values.includes('+49 1') && update.values.includes('Anna'), 'stored values not kept');
  });

  await testAsync('PUT rejects phone over 100 chars → 400', async () => {
    const { handler } = loadHandler('api/[artist]/venues/[...path].js',
      text => (text.startsWith('SELECT * FROM venues') ? [STORED] : []));
    const res = await call(handler, 'PUT', { name: 'Old', phone: 'x'.repeat(101) }, { path: ['5'] });
    assertEq(res.statusCode, 400);
    assertEq(res.body?.error, 'phone too long');
  });
}

module.exports = run;

if (require.main === module) {
  const r = makeRunner();
  run(r).then(() => r.summary());
}
```

Before running, check `tests/unit/tx_handlers.js` (its last lines) for the exact export/standalone pattern (`module.exports = run` and the `r.summary()` / `r.done()` call name) and match it. Also check how `api/[artist]/venues/[...path].js` reads the id (`req.query.path` vs the URL) and adjust `query`/`url` in `call()` so the handler resolves id `5`.

- [ ] **Step 2: Register the suite and run it to verify it fails**

In `tests/unit.js` add `require('./unit/venue_handlers'),` after `require('./unit/tx_handlers'),`.

Run: `node tests/unit/venue_handlers.js`
Expected: FAIL. The POST test fails with "columns missing in INSERT", and the length tests fail because the status is 201/200 instead of 400.

- [ ] **Step 3: Implement**

`scripts/schema.sql`, appended:

```sql
ALTER TABLE venues ADD COLUMN IF NOT EXISTS phone        TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_name TEXT;
```

`api/[artist]/venues.js`: after the `comment` validation in POST:

```js
    const phone = validateStr(b.phone, 100);
    if (phone === false) return res.status(400).json({ error: 'phone too long' });
    const contact_name = validateStr(b.contact_name, 200);
    if (contact_name === false) return res.status(400).json({ error: 'contact_name too long' });
```

and the INSERT becomes:

```js
    const [venue] = await sql`
      INSERT INTO venues (artist_id, name, street_number, street, city, country, category, status, comment, lat, lng, phone, contact_name)
      VALUES (${artist.id}, ${name}, ${street_number}, ${street}, ${city}, ${country}, ${category}, ${status}, ${comment}, ${lat}, ${lng}, ${phone}, ${contact_name})
      RETURNING *
    `;
```

`api/[artist]/venues/[...path].js`: after the `comment` validation in PUT:

```js
    const phone = validateStr(body.phone, 100);
    if (phone === false) return res.status(400).json({ error: 'phone too long' });
    const contact_name = validateStr(body.contact_name, 200);
    if (contact_name === false) return res.status(400).json({ error: 'contact_name too long' });
```

and in the UPDATE, after `generic_email = …`:

```js
        phone = ${'phone' in body ? phone : venue.phone},
        contact_name = ${'contact_name' in body ? contact_name : venue.contact_name},
```

`DATABASE.md` venues table, after the `generic_email` row:

```markdown
| `phone` | text | Venue phone |
| `contact_name` | text | Booking contact person |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/unit/venue_handlers.js && node tests/unit.js`
Expected: all PASS, including existing suites.

- [ ] **Step 5: Pause for review** (user rule: no commit without explicit go). Suggested message: `feat: venue phone and contact name`

---

### Task 2: Venue modal fields, organizer types, i18n

**Files:**
- Modify: `app/venues.html` (modal, after the website field)
- Modify: `app/js/venues.js` (`openAddModal`, `openEditModal`, `saveVenue`)
- Modify: `app/organizers.html` (`#om-type` select)
- Modify: `app/js/organizers.js` (`_orgTypeLabel`)
- Modify: `app/i18n/en.json`, `app/i18n/fr.json`, `app/i18n/de.json`
- Modify: `app/js/i18n.js` (`I18N_VERSION = 10`) and all 20 pages' `i18n.js?v=9` → `?v=10`

**Interfaces:**
- Consumes: Task 1 API fields `phone`, `contact_name`.
- Produces:
  - Organizer type values `event`, `press`, `radio` (used by Task 4's cleaned data).
  - i18n keys `venues.fieldPhone`, `venues.fieldContactName`, `organizers.typeEvent`, `organizers.typePress`, `organizers.typeRadio`.

- [ ] **Step 1: Add i18n keys (tests enforce identical key sets)**

en.json, next to `venues.fieldWebsite` / `organizers.typeOrg`:

```json
  "venues.fieldPhone": "Phone",
  "venues.fieldContactName": "Contact person",
  "organizers.typeEvent": "Event",
  "organizers.typePress": "Press",
  "organizers.typeRadio": "Radio",
```

fr.json:

```json
  "venues.fieldPhone": "Téléphone",
  "venues.fieldContactName": "Personne de contact",
  "organizers.typeEvent": "Événement",
  "organizers.typePress": "Presse",
  "organizers.typeRadio": "Radio",
```

de.json:

```json
  "venues.fieldPhone": "Telefon",
  "venues.fieldContactName": "Ansprechperson",
  "organizers.typeEvent": "Event",
  "organizers.typePress": "Presse",
  "organizers.typeRadio": "Radio",
```

Run: `node tests/unit.js`
Expected: the i18n suite PASSES (same keys in all three files).

- [ ] **Step 2: Venue modal fields** — `app/venues.html`, after the `vm-website` field block:

```html
    <div class="modal-field">
      <label data-i18n="venues.fieldPhone">Phone</label>
      <input type="tel" id="vm-phone" placeholder="+49 …">
    </div>
    <div class="modal-field">
      <label data-i18n="venues.fieldContactName">Contact person</label>
      <input type="text" id="vm-contact-name">
    </div>
```

`app/js/venues.js`:
- In `openAddModal`, the reset list becomes `['name','street-number','street','postcode','city','country','category','email','website','phone','contact-name','comment']`.
- In `openEditModal`, after the `vm-website` line:

```js
  document.getElementById('vm-phone').value        = v.phone         || '';
  document.getElementById('vm-contact-name').value = v.contact_name  || '';
```

- In `saveVenue`, after `website:`:

```js
    phone:         document.getElementById('vm-phone').value.trim()        || null,
    contact_name:  document.getElementById('vm-contact-name').value.trim() || null,
```

- [ ] **Step 3: Organizer type options** — `app/organizers.html` `#om-type`, after the organization option:

```html
        <option value="event" data-i18n="organizers.typeEvent">Event</option>
        <option value="press" data-i18n="organizers.typePress">Press</option>
        <option value="radio" data-i18n="organizers.typeRadio">Radio</option>
```

`app/js/organizers.js` `_orgTypeLabel`:

```js
  var map = { person: t('organizers.typePerson'), organization: t('organizers.typeOrg'),
              event: t('organizers.typeEvent'), press: t('organizers.typePress'), radio: t('organizers.typeRadio') };
```

- [ ] **Step 4: Bump the i18n version**

Run: `grep -rl "i18n.js?v=9" app | xargs sed -i '' 's/i18n\.js?v=9/i18n.js?v=10/'` and set `var I18N_VERSION = 10;` in `app/js/i18n.js`.
Verify: `grep -rn "i18n.js?v=9" app` prints nothing.

- [ ] **Step 5: Run the unit tests**

Run: `npm run test:unit`
Expected: all PASS (includes `page_scripts` and `asset_versions` checks).

- [ ] **Step 6: Manual check in `vercel dev`** — open `/venues`, edit a venue, set phone and contact person, save, reopen: the values persist. Open `/organizers`: the type select shows Event/Press/Radio. Pause for user review.

---

### Task 3: Venue website re-verification (local, `data/`)

**Files:**
- Modify: `data/check_venues.js` (retry pass with URL variants)
- Modify: `data/clean.js` (`webVerdict`, `applyWebCheck`)

**Interfaces:**
- Consumes: `data/clean/venues.json` (each venue has `website`).
- Produces:
  - `data/clean/venue_web_check.json`: `{ [url]: { status, ok, error?, redirectedTo?, origin?, retry? } }`.
  - In cleaned venues, dead websites become `website: null` with a comment note.
  - The `website_check` field is removed from the output.

- [ ] **Step 1: Add the retry pass** — in `data/check_venues.js`, before `const all = Object.values(results);`:

```js
  // Pass 3: everything still failing gets a slow retry over URL variants
  // (http↔https, with/without www, site root). Any variant answering → ok.
  const variants = u => {
    const x = new URL(u);
    const hosts = [x.hostname, x.hostname.startsWith('www.') ? x.hostname.slice(4) : `www.${x.hostname}`];
    return [...new Set(['https:', 'http:'].flatMap(p => hosts.flatMap(h => [`${p}//${h}${x.pathname}${x.search}`, `${p}//${h}/`]))];
  };
  const failing = Object.entries(results).filter(([, r]) => !r.ok && !r.origin?.ok && !r.retry);
  console.log(`${failing.length} failing URLs → retry with variants`);
  for (let k = 0; k < failing.length; k += CONCURRENCY) {
    await Promise.all(failing.slice(k, k + CONCURRENCY).map(async ([u, r]) => {
      r.retry = { ok: false, tried: [] };
      for (const v of variants(u)) {
        const res = await check(v, 30000);
        r.retry.tried.push({ url: v, status: res.status, error: res.error, redirectedTo: res.redirectedTo });
        if (res.ok) { r.retry.ok = true; r.retry.url = v; r.retry.redirectedTo = res.redirectedTo; break; }
      }
    }));
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
```

and give `check` a timeout parameter: `async function check(url, timeoutMs = TIMEOUT_MS)`, using `timeoutMs` in `setTimeout`.

- [ ] **Step 2: Run it**

Run: `node data/check_venues.js`
Expected: finishes and prints the ok/failed counts; `venue_web_check.json` entries for failing URLs have a `retry` object.

- [ ] **Step 3: Apply verdicts in `clean.js`** — replace `webVerdict` and `applyWebCheck` with:

```js
const PARKING_HOST = /sedo\.com|^domains\.|afternic|dan\.com|godaddy|parkingcrew|bodis|afp24|hugedomains/;

function webVerdict(r) {
  if (!r) return 'unchecked';
  const parked = x => x?.redirectedTo && PARKING_HOST.test(new URL(x.redirectedTo).hostname);
  if (parked(r) || parked(r.origin) || parked(r.retry)) return 'dead';
  if (r.ok || r.origin?.ok || r.retry?.ok) return 'ok';
  const tried = r.retry?.tried || [];
  if (r.status === 410 || (tried.length && tried.every(t => t.error === 'ENOTFOUND'))) return 'dead';
  return 'unclear';
}

function applyWebCheck(venues) {
  const file = path.join(OUT, 'venue_web_check.json');
  if (!fs.existsSync(file)) { err('venues: website check has not run (node data/check_venues.js)'); return; }
  const results = JSON.parse(fs.readFileSync(file, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const counts = {};
  for (const v of venues) {
    if (!v.website) continue;
    const r = results[v.website];
    const verdict = webVerdict(r);
    counts[verdict] = (counts[verdict] || 0) + 1;
    if (verdict === 'unchecked') err(`venue "${v.name}": website ${v.website} not checked — rerun check_venues.js`);
    if (verdict === 'dead') {
      v.comment = [v.comment, `Website offline (geprüft ${r.checkedAt || today}): ${v.website}`].filter(Boolean).join('\n');
      checkLen(`venue "${v.name}"`, 'comment', v.comment, 2000);
      v.website = null;
    }
    if (verdict === 'unclear') {
      const detail = [r.error || r.status, ...(r.retry?.tried || []).map(t => t.error || t.status)].filter(Boolean);
      review(`venue "${v.name}" (${v.city || '—'}): website ${v.website} unclear (${[...new Set(detail)].join(', ')}) → kept`);
    }
  }
  info(`venues website check: ${JSON.stringify(counts)}; dead websites removed and noted in comment`);
}
```

- [ ] **Step 4: Run the cleaner**

Run: `node data/clean.js`
Expected: `errors=0`. REPORT.md lists the verdict counts and one review line per still-unclear website. Spot-check: `node -e "const v=require('./data/clean/venues.json');console.log(v.filter(x=>/Website offline/.test(x.comment||'')).length)"` equals the `dead` count.

---

### Task 4: Map values to app enums + add website gigs (local, `data/clean.js`)

**Files:**
- Modify: `data/clean.js`

**Interfaces:**
- Consumes: `LOCATION_OVERRIDE`, `loadSiteEvents()`, `siteLocation(e)` (already in `clean.js`); Task 2 organizer types.
- Produces (read by Task 5):
  - `venues.json[i]`: `key` (string), `status`, `category`, `phone`, `contact_name`, …
  - `gigs.json[i]`: `source` (`'export'|'site'`), `venue_key` (string|null), `type`, `setlists` (empty array for site gigs).
  - `organizers.json[i]`: `type` ∈ `organization|person|event|press|radio|null`, `extra.legacy`, `extra.mergedLegacy`.

- [ ] **Step 1: Venue status and category mapping** — add near `BOOKING_CHANNEL`:

```js
const VENUE_STATUS_MAP = {
  hot: 'prospect', todo: 'prospect', possible: 'prospect',
  retry: 'contacted', waiting: 'contacted', ongoing: 'contacted',
  confirmed: 'confirmed',
  'not relevant': 'declined', 'not interested': 'declined', 'not possible': 'declined', 'not solo': 'declined',
  rejected: 'declined', 'no more concerts': 'declined', 'only locals': 'declined', 'only via booking agency': 'declined',
};
const VENUE_CATEGORY_MAP = {
  Festival: 'festival', 'Open Air': 'festival',
  Bar: 'pub', Cafe: 'pub', 'Cafe, Bar': 'pub', Kneipe: 'pub', Pub: 'pub', Bistro: 'pub', Biergarten: 'pub',
  Keller: 'pub', 'Club, Bar': 'pub', Brauerei: 'pub',
  Club: 'club', 'Rock Club': 'club', 'Cafe, Club': 'club',
  Restaurant: 'restaurant', Hotel: 'restaurant', "Rock'n'Roll Hotel & Bar": 'restaurant',
  Kulturzentrum: 'association', Jugendzentrum: 'association', 'Verein für Soziokultur in Bergedorf': 'association',
  Studentenwerk: 'association', Theater: 'association', Saal: 'association', Konzerthaus: 'association', Kloster: 'association',
  Markt: 'street',
};
```

In `cleanVenues`, replace the `status` lines with:

```js
    const rawStatus = str(v.status);
    const status = rawStatus ? VENUE_STATUS_MAP[rawStatus.toLowerCase()] : null;
    if (rawStatus && !status) err(`${where}: unmapped status "${rawStatus}"`);
    if (rawStatus && rawStatus.toLowerCase() !== status) notes.push(`Status laut Export: ${rawStatus}`);
    const rawCategory = str(v.category);
    const category = rawCategory ? VENUE_CATEGORY_MAP[rawCategory] || null : null;
    if (rawCategory && rawCategory.toLowerCase() !== category) notes.push(`Kategorie laut Export: ${rawCategory}`);
```

In the record, use `status,` and `category,` (drop the old `category: str(v.category)`), and add
`key: int(v.id) != null ? \`v${int(v.id)}\` : \`n:${name.toLowerCase()}|${(city || '').toLowerCase()}\`,` as the first field.

- [ ] **Step 2: Gig type mapping and venue key** — add above `cleanGigs`:

```js
const GIG_TYPE_MAP = { Solo: 'concert', Band: 'concert', SoloSupport: 'concert', 'Open Stage': 'concert',
  Songslam: 'concert', Competition: 'concert', SoloRoomConcert: 'private', Radio: 'other' };
```

In `cleanGigs`, in the `out.push({...})` object:
- `source: 'export',`
- `type: GIG_TYPE_MAP[str(first.type)] ?? null,`
- `comment: [str(first.comment), \`Typ laut Export: ${str(first.type)}\`].filter(Boolean).join('\n'),`

Add `if (str(first.type) && !(str(first.type) in GIG_TYPE_MAP)) err(\`gig ${first.id}: unmapped type "${first.type}"\`);` before the push.

In the venue-link block, replace `g.legacy_venue = venue.legacy;` with `g.venue_key = venue.key;` and initialise `venue_key: null` in the pushed object.

- [ ] **Step 3: Website gigs not in the export** — at the end of `cleanGigs`, before `out.sort(...)` moves below it (sort after appending):

```js
  for (const e of unmatchedSite) {
    const date = isoDate(e.date);
    const privat = /privat/i.test(`${e.title || ''} ${e.venue || ''}`);
    const title = str(e.title) || str(e.venue) || (privat ? 'Privat' : `Gig ${str(e.city) || ''}`.trim());
    const location = LOCATION_OVERRIDE[date] || siteLocation(e);
    const [vName, vCity] = (location || '').split(', ');
    const venue = venues.find(v => norm(v.city) === norm(vCity) &&
      (norm(v.name) === norm(vName) || (norm(vName).length > 5 && norm(v.name).includes(norm(vName)))));
    out.push({
      source: 'site', legacy_gig_ids: [], title, date, type: privat ? 'private' : null,
      time_start: null, time_end: null, legacy_organizer_id: null, legacy_event_id: null,
      venue_key: venue ? venue.key : null, location, additional_text: null,
      additional_link: url(e.titleHref), comment: null, setlists: [],
    });
    checkLen(`site gig ${date}`, 'title', title, 200);
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
```

Move the `unmatchedSite` computation above this loop. Remove the earlier `out.sort` call, since sorting now happens after appending.

- [ ] **Step 4: Organizer types** — in `cleanOrganizers`, set `type: str(o.type) ? 'organization' : null` and add `subType: str(o.type)` to `extra`. In `typedOrganizers`:
- events: `type: 'event'`, and `extra: { eventType: str(r.type), genre: str(r.genre), turnus: str(r.turnus) }`
- press: `type: 'press'`
- radios: `type: 'radio'`

Delete `EVENT_TYPE`. In `mergeOrganizers`, after the fill loop add `if (hit.type === 'organization' || !hit.type) hit.type = t.type;`, so a radio station that was an organizer becomes `radio`.

- [ ] **Step 5: Run and verify**

Run: `node data/clean.js`
Expected: `errors=0`. Then check value sets:

```bash
node -e "
const v=require('./data/clean/venues.json'),g=require('./data/clean/gigs.json'),o=require('./data/clean/organizers.json');
const set=(a,f)=>[...new Set(a.map(x=>x[f]))];
console.log('status',set(v,'status'));console.log('category',set(v,'category'));
console.log('gig types',set(g,'type'),'gigs',g.length,'export',g.filter(x=>x.source==='export').length);
console.log('org types',set(o,'type'));"
```

Expected:
- status ⊆ {null, prospect, contacted, confirmed, declined}
- category ⊆ {null, festival, pub, club, restaurant, association, street}
- gig types ⊆ {concert, private, other, null}
- 159 gigs, of which 53 are export gigs
- org types ⊆ {null, organization, event, press, radio}

---

### Task 5: Import script (local, `data/import.js`)

**Files:**
- Create: `data/import.js`

**Interfaces:**
- Consumes: `data/clean/{organizers,venues,songs_own,songs_covers,gema_works,gigs}.json` as produced by Tasks 3–4.
- Produces: rows in `organizers`, `venues`, `songs`, `song_logs`, `gema_works`, `gigs`, `setlists`, `setlist_songs` for the artist. Prints per-entity counts `{ inserted, filled, unchanged }`.

- [ ] **Step 1: Write `data/import.js`**

```js
#!/usr/bin/env node
// Imports data/clean/*.json into one artist. One transaction; --dry-run rolls back.
// Idempotent: rows are matched by natural keys and only empty fields are filled.
// Usage: node data/import.js --artist klang [--dry-run]   (DATABASE_URL from .env)
'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const postgres = require('postgres');

function loadEnv(file) {
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    });
  } catch {}
}
loadEnv(path.join(__dirname, '..', '.env'));

const args   = process.argv.slice(2);
const slug   = args[args.indexOf('--artist') + 1];
const dryRun = args.includes('--dry-run');
if (!args.includes('--artist') || !slug) { console.error('Usage: node data/import.js --artist <slug> [--dry-run]'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const load = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'clean', f), 'utf8'));
const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
const ROLLBACK = new Error('dry-run rollback');

async function confirm() {
  const host = new URL(process.env.DATABASE_URL).hostname;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question(`Import into ${host} (artist ${slug})${dryRun ? ' [DRY RUN]' : ''}? [y/N] `, r));
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') process.exit(0);
}

// Returns the subset of `incoming` that fills fields that are empty on `existing`.
function fillable(existing, incoming, fields) {
  const out = {};
  for (const f of fields) if ((existing[f] == null || existing[f] === '') && incoming[f] != null && incoming[f] !== '') out[f] = incoming[f];
  return out;
}

function counter() { return { inserted: 0, filled: 0, unchanged: 0 }; }

async function importOrganizers(tx, artistId, orgs) {
  const c = counter();
  const byLegacy = new Map();
  const existing = await tx`SELECT * FROM organizers WHERE artist_id = ${artistId} AND deleted = false`;
  const byName = new Map(existing.map(o => [norm(o.name), o]));
  const fields = ['type', 'email', 'phone', 'website', 'city', 'country', 'comment'];
  for (const o of orgs) {
    let row = byName.get(norm(o.name));
    if (row) {
      const fill = fillable(row, o, fields);
      if (Object.keys(fill).length) {
        [row] = await tx`UPDATE organizers SET ${tx(fill)}, extra = ${o.extra}::jsonb || extra, last_updated = NOW()
                         WHERE id = ${row.id} RETURNING *`;
        c.filled++;
      } else c.unchanged++;
    } else {
      [row] = await tx`INSERT INTO organizers (artist_id, name, type, email, phone, website, city, country, comment, extra)
        VALUES (${artistId}, ${o.name}, ${o.type}, ${o.email}, ${o.phone}, ${o.website}, ${o.city}, ${o.country}, ${o.comment}, ${o.extra})
        RETURNING *`;
      byName.set(norm(o.name), row);
      c.inserted++;
    }
    for (const l of [o.extra.legacy, ...(o.extra.mergedLegacy || [])]) if (l.id != null) byLegacy.set(`${l.source}:${l.id}`, row.id);
  }
  return { c, byLegacy };
}

const VENUE_COLS = ['name', 'alive', 'activated', 'declined', 'status', 'category', 'street', 'street_number', 'postcode',
  'city', 'state', 'country', 'generic_email', 'phone', 'contact_name', 'website', 'social_links', 'last_communication',
  'booking_channel', 'number_of_cold_contacts', 'turnus', 'remuneration', 'overnight', 'season', 'preferred_period',
  'comment', 'deadline', 'main_genre', 'subgenres', 'size', 'language', 'last_updated'];

async function importVenues(tx, artistId, venues) {
  const c = counter();
  const byKey = new Map();
  const existing = await tx`SELECT * FROM venues WHERE artist_id = ${artistId} AND deleted = false`;
  const byNameCity = new Map(existing.map(v => [`${norm(v.name)}|${norm(v.city)}`, v]));
  const fillFields = VENUE_COLS.filter(f => !['name', 'city', 'alive', 'activated', 'declined', 'overnight',
    'number_of_cold_contacts', 'social_links', 'subgenres', 'last_updated'].includes(f));
  const toInsert = [];
  for (const v of venues) {
    const row = byNameCity.get(`${norm(v.name)}|${norm(v.city)}`);
    if (!row) { toInsert.push(v); continue; }
    byKey.set(v.key, row.id);
    const fill = fillable(row, v, fillFields);
    if (Object.keys(fill).length) { await tx`UPDATE venues SET ${tx(fill)}, last_updated = NOW() WHERE id = ${row.id}`; c.filled++; }
    else c.unchanged++;
  }
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200);
    const rows = chunk.map(v => ({ artist_id: artistId, ...Object.fromEntries(VENUE_COLS.map(f => [f, v[f] ?? null])),
      social_links: v.social_links || {}, subgenres: v.subgenres || [], last_updated: v.last_updated || new Date() }));
    const inserted = await tx`INSERT INTO venues ${tx(rows, 'artist_id', ...VENUE_COLS)} RETURNING id`;
    inserted.forEach((r, k) => byKey.set(chunk[k].key, r.id));
    c.inserted += inserted.length;
  }
  return { c, byKey };
}

const SONG_FIELDS = ['key', 'genre', 'energy', 'time_signature', 'bpm', 'length_min', 'reference_interpret', 'comment'];

async function importSongs(tx, artistId, songs) {
  const c = counter();
  const byLegacy = new Map();
  const existing = await tx`SELECT * FROM songs WHERE artist_id = ${artistId} AND deleted = false`;
  for (const s of songs) {
    let row = existing.find(e => norm(e.title) === norm(s.title) && (!e.interpret || norm(e.interpret) === norm(s.interpret)));
    if (row) {
      const fill = fillable(row, s, [...SONG_FIELDS, 'interpret']);
      const newExtraKeys = Object.keys(s.extra).filter(k => row.extra?.[k] == null);
      if (Object.keys(fill).length || newExtraKeys.length) {
        [row] = await tx`UPDATE songs SET ${Object.keys(fill).length ? tx`${tx(fill)},` : tx``} extra = ${s.extra}::jsonb || extra
                         WHERE id = ${row.id} RETURNING *`;
        await tx`INSERT INTO song_logs (artist_id, song_id, action, song_data) VALUES (${artistId}, ${row.id}, 'update', ${row})`;
        c.filled++;
      } else c.unchanged++;
    } else {
      [row] = await tx`INSERT INTO songs (artist_id, title, active, key, genre, energy, time_signature, bpm, length_min,
                                          interpret, reference_interpret, comment, extra)
        VALUES (${artistId}, ${s.title}, ${s.active}, ${s.key}, ${s.genre}, ${s.energy}, ${s.time_signature}, ${s.bpm},
                ${s.length_min}, ${s.interpret}, ${s.reference_interpret}, ${s.comment}, ${s.extra})
        RETURNING *`;
      await tx`INSERT INTO song_logs (artist_id, song_id, action, song_data) VALUES (${artistId}, ${row.id}, 'create', ${row})`;
      existing.push(row);
      c.inserted++;
    }
    const l = s.extra.legacy;
    if (l.id != null) byLegacy.set(`${l.source}:${l.id}`, row.id);
    (l.mergedIds || []).forEach(id => byLegacy.set(`${l.source}:${id}`, row.id));
    if (l.slag) byLegacy.set(`${l.source}:slag:${l.slag}`, row.id);
  }
  return { c, byLegacy };
}

async function importWorks(tx, artistId, works, songIds) {
  const c = counter();
  for (const w of works) {
    const l = w.legacy_song;
    const songId = songIds.get(l.id != null ? `own:${l.id}` : `own:slag:${l.slag}`) ?? null;
    const [r] = await tx`
      INSERT INTO gema_works (artist_id, gema_work_number, title, iswc, language, performers, gema_genre, duration_sec, first_registered_at, song_id)
      VALUES (${artistId}, ${w.gema_work_number}, ${w.title}, ${w.iswc}, ${w.language}, ${w.performers}, ${w.gema_genre},
              ${w.duration_sec}, ${w.first_registered_at}, ${songId})
      ON CONFLICT (artist_id, gema_work_number) DO UPDATE SET
        iswc = COALESCE(gema_works.iswc, EXCLUDED.iswc),
        language = COALESCE(gema_works.language, EXCLUDED.language),
        performers = COALESCE(gema_works.performers, EXCLUDED.performers),
        gema_genre = COALESCE(gema_works.gema_genre, EXCLUDED.gema_genre),
        duration_sec = COALESCE(gema_works.duration_sec, EXCLUDED.duration_sec),
        first_registered_at = COALESCE(gema_works.first_registered_at, EXCLUDED.first_registered_at),
        song_id = COALESCE(gema_works.song_id, EXCLUDED.song_id)
      RETURNING (xmax = 0) AS inserted`;
    r.inserted ? c.inserted++ : c.filled++;
  }
  return { c };
}

async function importGigs(tx, artistId, gigs, orgIds, venueIds, songIds) {
  const c = counter();
  const sl = counter();
  const existing = await tx`SELECT id, date::text AS date, title, location, venue_id, organizer_id, type FROM gigs
                            WHERE artist_id = ${artistId} AND deleted = false`;
  for (const g of gigs) {
    const sameDay = existing.filter(e => e.date === g.date);
    const match = sameDay.length === 1 ? sameDay[0] : sameDay.find(e => norm(e.title) === norm(g.title));
    const venueId = g.venue_key ? venueIds.get(g.venue_key) ?? null : null;
    const orgId = g.legacy_organizer_id != null ? orgIds.get(`organizer:${g.legacy_organizer_id}`) ?? null : null;
    if (match) {
      const fill = fillable(match, { location: g.location, venue_id: venueId, organizer_id: orgId, type: g.type },
        ['location', 'venue_id', 'organizer_id', 'type']);
      if (Object.keys(fill).length) { await tx`UPDATE gigs SET ${tx(fill)}, last_updated = NOW() WHERE id = ${match.id}`; c.filled++; }
      else c.unchanged++;
      continue;
    }
    const [row] = await tx`
      INSERT INTO gigs (artist_id, title, date, type, time_start, time_end, venue_id, organizer_id, location,
                        additional_text, additional_link, comment)
      VALUES (${artistId}, ${g.title}, ${g.date}, ${g.type}, ${g.time_start}, ${g.time_end}, ${venueId}, ${orgId},
              ${g.location}, ${g.additional_text}, ${g.additional_link}, ${g.comment})
      RETURNING id, date::text AS date, title`;
    existing.push(row);
    c.inserted++;
    for (const s of g.setlists) {
      const ids = s.songs.map(x => songIds.get(`${x.source}:${x.id}`));
      if (ids.some(id => id == null)) throw new Error(`gig ${g.date} "${g.title}": setlist references an unknown song`);
      const [setlist] = await tx`INSERT INTO setlists (artist_id, title, gig_id, created_at)
                                 VALUES (${artistId}, ${s.title}, ${row.id}, ${g.date}) RETURNING id`;
      if (ids.length) {
        await tx`INSERT INTO setlist_songs (setlist_id, song_id, position)
          SELECT * FROM unnest(${ids.map(() => setlist.id)}::int[], ${ids}::int[], ${ids.map((_, i) => i)}::int[])`;
      }
      sl.inserted++;
    }
  }
  return { c, sl };
}

async function main() {
  await confirm();
  const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });
  try {
    const [artist] = await sql`SELECT id, config FROM artists WHERE slug = ${slug}`;
    if (!artist) throw new Error(`artist "${slug}" not found`);
    if (artist.config?.plan !== 'pro') throw new Error(`artist "${slug}" is not on the pro plan`);
    const cols = await sql`SELECT column_name FROM information_schema.columns
                           WHERE table_name = 'venues' AND column_name IN ('phone', 'contact_name')`;
    if (cols.length !== 2) throw new Error('venues.phone / contact_name missing — run scripts/apply_schema.js');

    const report = {};
    try {
      await sql.begin(async tx => {
        const orgs = await importOrganizers(tx, artist.id, load('organizers.json'));
        report.organizers = orgs.c;
        const venues = await importVenues(tx, artist.id, load('venues.json'));
        report.venues = venues.c;
        const songs = await importSongs(tx, artist.id, [...load('songs_own.json'), ...load('songs_covers.json')]);
        report.songs = songs.c;
        report.gema_works = (await importWorks(tx, artist.id, load('gema_works.json'), songs.byLegacy)).c;
        const gigs = await importGigs(tx, artist.id, load('gigs.json'), orgs.byLegacy, venues.byKey, songs.byLegacy);
        report.gigs = gigs.c;
        report.setlists = gigs.sl;
        if (dryRun) throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    console.table(report);
    console.log(dryRun ? 'DRY RUN — rolled back, nothing written.' : 'Committed.');
  } finally {
    await sql.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Syntax check**

Run: `node --check data/import.js`
Expected: no output.

---

### Task 6: Demo run and verification

**Files:** none changed; DB operations on the smartist-demo dev branch (`DATABASE_URL` in `.env`, host `ep-late-bread-a2myikkd-pooler…`).

- [ ] **Step 1: Apply the schema** — `node scripts/apply_schema.js`. Confirm the hostname shown is `ep-late-bread-a2myikkd-pooler.eu-central-1.aws.neon.tech` before typing `y`.

- [ ] **Step 2: Ensure artist `klang` exists on the Pro plan**

Run: `node scripts/plans.js`. If `klang` is missing, create it with `node scripts/setup.js` (slug `klang`, name `Kevin Klang`). Then run `node scripts/plans.js --artist klang --plan pro`.
Expected: `plans.js` lists `klang` with plan `pro`.

- [ ] **Step 3: Dry run**

Run: `node data/import.js --artist klang --dry-run`
Expected counts on an empty `klang`: organizers inserted 104; venues inserted 1997; songs inserted 129 (55 own + 74 covers); gema_works inserted 32; gigs inserted 159; setlists inserted 78. The run ends with "DRY RUN — rolled back".

- [ ] **Step 4: Real run, then idempotency**

Run: `node data/import.js --artist klang`, then run it again.
Expected: the second run shows `inserted 0` for every entity.

- [ ] **Step 5: DB spot checks** (read-only)

```bash
node -e "
require('fs').readFileSync('.env','utf8').split('\n').forEach(l=>{const m=l.match(/^DATABASE_URL=(.*)/);if(m)process.env.DATABASE_URL=m[1].replace(/^\"|\"$/g,'')});
const sql=require('postgres')(process.env.DATABASE_URL,{ssl:'require',max:1});
(async()=>{const [a]=await sql\`SELECT id FROM artists WHERE slug='klang'\`;
console.log(await sql\`SELECT g.date::text, g.title, g.location, count(s.id) sets FROM gigs g LEFT JOIN setlists s ON s.gig_id=g.id WHERE g.artist_id=\${a.id} AND g.date='2014-09-13' GROUP BY g.id\`);
console.log(await sql\`SELECT s.title, count(*) FROM setlists s JOIN setlist_songs ss ON ss.setlist_id=s.id WHERE s.artist_id=\${a.id} GROUP BY s.id ORDER BY s.id LIMIT 3\`);
console.log(await sql\`SELECT count(*) FILTER (WHERE phone IS NOT NULL) phone, count(*) FILTER (WHERE contact_name IS NOT NULL) contact FROM venues WHERE artist_id=\${a.id}\`);
console.log(await sql\`SELECT count(*) FROM gema_works WHERE artist_id=\${a.id} AND song_id IS NULL\`);
await sql.end();})()"
```

Expected:
- Moosacher Musiknacht has 4 sets and location "Bäckerei Riedmair, München".
- Setlists have songs.
- Phone and contact counts are above 400 and 200 respectively.
- 0 GEMA works without a song.

- [ ] **Step 6: UI verification** — `vercel dev`, log in to `klang`:
  - Songs list shows own songs and covers.
  - Gig 2014-09-13 shows 4 setlists.
  - The venue modal shows phone and contact person.
  - A venue with a dead site has no website and a "Website offline" comment.
  - Organizers show Event/Press/Radio badges.
  - Opening and saving a venue keeps its status and category.

- [ ] **Step 7: Hand over to the user** for their own check on demo. Prod rollout (Neon backup branch, deploy, `apply_schema.js`, dry run, run) is a separate go/no-go.
