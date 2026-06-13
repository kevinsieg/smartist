# Member Usability Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make smartist less intimidating for non-technical band members: 3-link nav with a "More" dropdown, plain-language labels, touch-visible controls, empty-state CTAs, a basics-first grouped song edit form, and three task buttons on the dashboard.

**Architecture:** Pure frontend changes in the existing vanilla-JS pages (no build step). Nav changes live in `injectShell()` in `common.js`; the song form regroup is a restructure of the existing `<details class="edit-section">` blocks in `songs.js`; empty states extend the shared `createListView` factory; dashboard buttons are deep links handled by query params the page scripts already read client-side. No API changes, no new serverless functions.

**Tech Stack:** Vanilla JS (`var` at top level of page scripts — SPA re-execution), shared CSS in `app/css/app.css`, Vercel rewrites untouched.

**Spec:** `docs/2026-06-11-member-usability-design.md`

**Workflow notes (Kev's rules — override skill defaults):**
- Every commit step happens **only after Kev verifies the change in the browser**. Pause at each "Verify" step.
- The working tree may still hold uncommitted fixes from 2026-06-11 (login/landing/stage). Those must be committed first or this plan's commits will mix changes. **Check `git status` before Task 1.**
- Spec deviation noted during planning: the songs page default (list view) already shows only Title/Interpret/Genre/Key/Tempo per row — the "reduce table columns" spec item is already satisfied; the column-heavy table is the opt-in desktop Bulk Edit and stays untouched.

**Testing reality:** No DOM test framework exists. Per task: `node --check` on changed JS, `node tests/unit.js` (must stay 183 passed), manual browser verification against `vercel dev`. Full integration suite (`cd tests && ARTIST_PASSWORD=… npm test`) after the last task.

---

### Task 1: Nav "More" dropdown

**Files:**
- Modify: `app/js/common.js:68-83` (injectShell nav links)
- Modify: `app/js/common.js:152-168` (click handler — add dropdown toggle)
- Modify: `app/css/app.css` (append nav-more styles)

- [ ] **Step 1: Replace the nav links block**

In `common.js`, replace lines 70-77 (the eight links inside the `_artistSlug ?` branch) with:

```js
          '<a href="' + _base + '/songs">Songs</a>' +
          '<a href="' + _base + '/setlist">Setlists</a>' +
          '<a href="' + _base + '/gigs">Gigs</a>' +
          '<div class="nav-more">' +
            '<a href="#" class="nav-more-toggle" id="nav-more-toggle" aria-expanded="false">More &#9662;</a>' +
            '<div class="nav-more-menu" id="nav-more-menu">' +
              '<a href="' + _base + '/venues">Venues</a>' +
              '<a href="' + _base + '/organizers" class="auth-only">Organizers</a>' +
              '<a href="' + _base + '/hub">Hub</a>' +
              '<a href="' + _base + '/pro-import" class="auth-only">PRO</a>' +
              '<a href="' + _base + '/users" class="admin-only">Users</a>' +
            '</div>' +
          '</div>'
```

(Users moves inside the menu; it keeps `admin-only` so visibility is unchanged.)

- [ ] **Step 2: Add the toggle to the existing document click listener**

In the same file, inside the `document.addEventListener('click', …)` block, directly **before** the `// Burger toggle` branch, add:

```js
    // "More" dropdown toggle
    if (e.target.closest('#nav-more-toggle')) {
      e.preventDefault();
      var moreEl = document.querySelector('.nav-more');
      var moreOpen = moreEl.classList.toggle('nav-more-open');
      document.getElementById('nav-more-toggle').setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
      return;
    }
    if (!e.target.closest('.nav-more')) {
      var openMore = document.querySelector('.nav-more.nav-more-open');
      if (openMore) {
        openMore.classList.remove('nav-more-open');
        document.getElementById('nav-more-toggle').setAttribute('aria-expanded', 'false');
      }
    }
```

- [ ] **Step 3: Append CSS to `app/css/app.css`**

```css
/* ── Nav "More" dropdown ── */
.nav-more { position: relative; display: inline-block; }
.nav-more-toggle { cursor: pointer; }
.nav-more-menu {
  display: none; position: absolute; right: 0; top: calc(100% + 6px);
  background: var(--bg-color, #fff); border: 1px solid var(--border-color);
  border-radius: 6px; padding: 0.4rem 0; min-width: 10rem; z-index: 60;
  box-shadow: 0 4px 14px rgba(0,0,0,0.08);
}
.nav-more-open .nav-more-menu { display: block; }
.nav-more-menu a { display: block; padding: 0.45rem 1rem; }
/* Burger/mobile menu: render the group flat — no nested dropdown */
.app-header.nav-open .nav-more { display: contents; }
.app-header.nav-open .nav-more-toggle { display: none; }
.app-header.nav-open .nav-more-menu {
  display: contents; position: static; border: none; box-shadow: none; padding: 0;
}
```

Match the real variable names used in `app.css` for background/border before committing (open the file and copy what `.app-header` itself uses).

- [ ] **Step 4: Syntax check + unit tests**

Run: `node --check app/js/common.js && node tests/unit.js`
Expected: check passes, `183 passed 0 failed`.

- [ ] **Step 5: Verify with Kev (vercel dev)**

Desktop: nav shows Songs/Setlists/Gigs/More; More opens/closes on click and outside click; current-page highlight still works on dropdown pages (e.g. /venues). Mobile burger: all items appear flat in the open menu. Logged out: Organizers/PRO/Users hidden inside the menu.

- [ ] **Step 6: Commit (after Kev confirms)**

```bash
git add app/js/common.js app/css/app.css
git commit -m "feat: collapse secondary nav links into More dropdown"
```

---

### Task 2: Rename setlist tabs

**Files:**
- Modify: `app/setlist.html:87-88`

- [ ] **Step 1: Rename labels (values/ids stay `generator`/`history`)**

```html
<button class="setlist-tab setlist-tab--active" data-tab="generator" onclick="switchTab('generator')">Build setlist</button>
<button class="setlist-tab" data-tab="history" onclick="switchTab('history')">Saved setlists</button>
```

- [ ] **Step 2: Check nothing asserts the old labels**

Run: `grep -rn "Generator\|>History<" tests/ app/js/setlist.js`
Expected: no label assertions (verified during planning — `tests/history-client.js` tests logic, not labels).

- [ ] **Step 3: Verify with Kev, then commit**

```bash
git add app/setlist.html
git commit -m "feat: plain-language setlist tab labels"
```

---

### Task 3: Touch-visible controls and tap targets

**Files:**
- Modify: `app/setlist.html` (`.hist-song-edit-btn` style block, ~line 51)
- Modify: `app/css/app.css` (append)

- [ ] **Step 1: Audit for hover-revealed/dimmed controls**

Run: `grep -rn "hover" app/css/app.css app/*.html | grep -i "opacity\|display\|visibility"`
List every control that is invisible or heavily dimmed until mouse-hover. Known from planning: `.hist-song-edit-btn` (opacity 0.6 → 1 on row hover, setlist.html:51-53).

- [ ] **Step 2: Append touch overrides to `app.css`**

```css
/* ── Touch devices: no hover — controls must be fully visible & tappable ── */
@media (hover: none) {
  .hist-song-edit-btn { opacity: 1; }
  .song-card-icon-btn,
  .hist-song-edit-btn,
  .icon-btn {
    min-width: 42px; min-height: 42px;
    display: inline-flex; align-items: center; justify-content: center;
  }
}
```

Add one line per additional control found in Step 1 (same pattern: force `opacity: 1` / visible).

- [ ] **Step 3: Verify with Kev on a phone (or DevTools touch emulation), then commit**

Check the songs list rows and setlist history rows: icons visible without hover, comfortably tappable, rows don't overflow.

```bash
git add app/css/app.css app/setlist.html
git commit -m "feat: touch-visible controls and 42px tap targets"
```

---

### Task 4: Empty-state CTAs

**Files:**
- Modify: `app/js/list-view.js:124-130` (the "No results." branch)
- Modify: `app/js/songs.js` (`_renderSongsListView`, createListView opts)
- Modify: `app/js/setlist.js` (history createListView opts, ~line 990)
- Modify: `app/js/gigs.js` (locate its empty render — see Step 3)

- [ ] **Step 1: Add `emptyHtml` option to the list-view factory**

In `list-view.js`, the render body currently does (line ~128):

```js
body.innerHTML = '<p style="text-align:center;color:var(--third-color);padding:2rem;">No results.</p>';
```

Replace with:

```js
var _isEmpty = typeof opts.getTotal === 'function' && opts.getTotal() === 0;
body.innerHTML = (_isEmpty && opts.emptyHtml)
  ? opts.emptyHtml
  : '<p style="text-align:center;color:var(--third-color);padding:2rem;">No results.</p>';
```

(`getTotal() === 0` = truly no data; non-zero with zero visible = a filter is active, keep "No results.")

- [ ] **Step 2: Pass `emptyHtml` from songs and setlist history**

In `songs.js` `_renderSongsListView()` createListView opts, after `renderRow: renderListRowHtml,` add:

```js
    emptyHtml: '<div style="text-align:center;padding:2.5rem 1rem;color:var(--third-color);">' +
      '<p style="margin-bottom:1rem;">No songs yet.</p>' +
      (getToken() ? '<button class="btn active" onclick="_openNewSongPanel()">+ Add your first song</button>' : '') +
      '</div>',
```

In `setlist.js` history createListView opts (the one with `getTotal: function() { return _histSets.length; }`), add:

```js
    emptyHtml: '<div style="text-align:center;padding:2.5rem 1rem;color:var(--third-color);">' +
      '<p style="margin-bottom:1rem;">No setlists saved yet.</p>' +
      '<button class="btn active" onclick="switchTab(\'generator\')">Build your first setlist</button>' +
      '</div>',
```

- [ ] **Step 3: Gigs page empty state**

Run: `grep -n "createListView\|innerHTML" app/js/gigs.js | head -20` to find how gigs render when the list is empty. If gigs uses `createListView`, pass an `emptyHtml` like the above with label "No gigs yet" and a button that triggers the existing `+ New gig` control. If it renders its own table, add an equivalent empty branch where rows are written. Same markup pattern as Step 2.

- [ ] **Step 4: Syntax check + unit tests**

Run: `node --check app/js/list-view.js app/js/songs.js app/js/setlist.js app/js/gigs.js && node tests/unit.js`
Expected: pass, 183 passed. (`node --check` takes one file at a time on some versions — loop if needed.)

- [ ] **Step 5: Verify with Kev (use a fresh/empty test workspace or the seeded dev DB minus data), then commit**

```bash
git add app/js/list-view.js app/js/songs.js app/js/setlist.js app/js/gigs.js
git commit -m "feat: empty-state CTAs on songs, setlists, gigs"
```

---

### Task 5: Regroup the song edit form (spec section 2, option B)

**Files:**
- Modify: `app/js/songs.js:625-692` (`_openSongEditForm` innerHTML)

- [ ] **Step 1: Replace the five `<details class="edit-section">` blocks**

Keep the surrounding code (variable prep, `inp`/`num`/`chk` helpers, header, error div, actions, focus, arrangement fetch) unchanged. Replace everything from `'<details class="edit-section" open><summary class="edit-section-summary">General</summary>'` through the closing of the GEMA section (`'</details>'` before the `(!isNew ? (` arrangement block) with:

```js
      '<details class="edit-section" open><summary class="edit-section-summary">Basics</summary>' +
        '<div class="edit-section-body">' +
          _editField('Title', '<input type="text" class="edit-input" data-id="' + id + '" data-key="title" value="' + title + '" oninput="markPanelEditDirty()" placeholder="Song title">') +
          _editField('Key', inp('key', key)) +
          _editField('Guitar capo', num('extra.gitCapo', gitCapo)) +
          _editField('Banjo capo', num('extra.banjoCapo', bjCapo)) +
          _editField('Length (MM:SS)', '<input type="text" class="edit-input" data-id="' + id + '" data-key="length_min" data-type="time" value="' + length + '" placeholder="MM:SS" oninput="markPanelEditDirty()">') +
          _editField('Lyrics', '<textarea class="edit-textarea edit-input" data-id="' + id + '" data-key="extra.lyrics" oninput="markPanelEditDirty()" placeholder="Enter lyrics…">' + lyrics + '</textarea>') +
          _editField('Listen', '<div class="panel-file-row">' + inp('extra.listenUrl', listen) + (!isNew ? '<button class="btn panel-upload-btn" onclick="_panelUploadFile(\'pf-audio-' + id + '\')">&#8593;</button><input type="file" id="pf-audio-' + id + '" style="display:none" accept="audio/*" onchange="_panelUploadHandler(this,\'' + id + '\',\'audio\')">' : '') + '</div>') +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">Recordings &amp; sheet music</summary>' +
        '<div class="edit-section-body">' +
          _editField('Sheet', '<div class="panel-file-row">' + inp('extra.sheetUrl', sheet) + (!isNew ? '<button class="btn panel-upload-btn" onclick="_panelUploadFile(\'pf-sheet-' + id + '\')">&#8593;</button><input type="file" id="pf-sheet-' + id + '" style="display:none" accept=".pdf,application/pdf" onchange="_panelUploadHandler(this,\'' + id + '\',\'sheet\')">' : '') + '</div>') +
          _editField('Playback', '<div class="panel-file-row">' + inp('extra.playbackUrl', playback) + (!isNew ? '<button class="btn panel-upload-btn" onclick="_panelUploadFile(\'pf-playback-' + id + '\')">&#8593;</button><input type="file" id="pf-playback-' + id + '" style="display:none" accept="audio/*" onchange="_panelUploadHandler(this,\'' + id + '\',\'playback\')">' : '') + '</div>') +
          _editField('Reference URL', inp('extra.referenceUrl', refUrl, 'url')) +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">Song info</summary>' +
        '<div class="edit-section-body">' +
          _editField('', '<div class="edit-toggle-row"><span>Active</span><div class="toggle-switch"><input type="checkbox" data-id="' + id + '" data-key="active"' + active + ' onchange="markPanelEditDirty()"><span class="toggle-track"><span class="toggle-thumb"></span></span></div></div>') +
          _editField('', '<div class="edit-check-row">' + chk('heart', heart) + '<span>&#9829; Favourite (always in auto-generation)</span></div>') +
          _editField('Genre', inp('genre', genre)) +
          _editField('Energy', inp('energy', energy)) +
          _editField('Time signature', '<select class="edit-input" data-id="' + id + '" data-key="time_signature" onchange="markPanelEditDirty()"><option value="">—</option>' + TIME_SIGNATURES.map(function(v){return '<option value="'+v+'"'+(timeSig===v?' selected':'')+'>'+v+'</option>';}).join('') + '</select>') +
          _editField('BPM', num('bpm', bpm)) +
          _editField('Lead', inp('extra.lead', lead)) +
          _editField('', '<div class="edit-check-row">' + chk('extra.git2', git2) + '<span>2nd guitar</span></div>') +
          _editField('', '<div class="edit-check-row">' + chk('extra.harp', harp) + '<span>Harmonica</span></div>') +
          _editField('Author', inp('extra.author', author)) +
          _editField('Interpret', inp('interpret', interp)) +
          _editField('Reference interpret', inp('reference_interpret', refInt)) +
          _editField('Song info URL', inp('extra.songinfoUrl', infoUrl, 'url')) +
          _editField('Comment', inp('comment', comment)) +
        '</div>' +
      '</details>' +
      '<details class="edit-section"><summary class="edit-section-summary">Rights &amp; reporting</summary>' +
        '<div class="edit-section-body">' +
          _editField('Language', '<select class="edit-select edit-input" data-id="' + id + '" data-key="extra.language" onchange="markPanelEditDirty()">' + langOpts + '</select>') +
          (iswc   ? _editField('ISWC',    '<div class="edit-readonly">' + escHtml(iswc)   + '</div>') : '') +
          (gemaNr ? _editField('GEMA-Nr', '<div class="edit-readonly">' + escHtml(gemaNr) + '</div>') : '') +
          (isrc   ? _editField('ISRC',    '<div class="edit-readonly">' + escHtml(isrc)   + '</div>') : '') +
        '</div>' +
      '</details>' +
```

Every field keeps its exact `data-key`, so `collectRow()` and the JSONB `||` merge are unaffected. Fields are moved, none added or removed (the old "Files & Lyrics" and "Metadata" sections dissolve into the new groups; Reference URL lands under Recordings since it is a listening reference).

- [ ] **Step 2: Syntax check + unit tests**

Run: `node --check app/js/songs.js && node tests/unit.js`
Expected: pass, 183 passed.

- [ ] **Step 3: Verify with Kev, then commit**

Edit an existing song: Basics open with Title/Key/capos/Length/Lyrics/Listen; three collapsed groups below; save a change from inside a collapsed group and from Basics; reopen — values persisted (JSONB merge intact). New song: same layout, no upload buttons.

```bash
git add app/js/songs.js
git commit -m "feat: basics-first grouped song edit form"
```

---

### Task 6: Desktop search auto-focus + deep links (`?focus=search`, `?new=1`)

**Files:**
- Modify: `app/js/songs.js` (`loadAndRender` ~line 157-165, `_renderSongsListView` end ~line 400)

- [ ] **Step 1: Read the deep-link params in `loadAndRender`**

After the existing `_pendingSongId` line add:

```js
    _pendingFocusSearch = _qp.get('focus') === 'search';
    _pendingNewSong     = _qp.get('new') === '1';
```

Declare at top level near the other page globals (private names per SPA rules):

```js
var _pendingFocusSearch = false;
var _pendingNewSong     = false;
```

- [ ] **Step 2: Act on them at the end of `_renderSongsListView`**

After the existing `_pendingSongId` block add:

```js
  if (_pendingNewSong && getToken() && !_viewMode) {
    _openNewSongPanel();
    _pendingNewSong = false;
  } else if (!isMobile()) {
    // Desktop: search is the #1 member task — focus it on load.
    var _searchEl = document.getElementById('lv-f-title');
    if (_searchEl) _searchEl.focus();
  }
  _pendingFocusSearch = false;
```

(Auto-focus is unconditional on desktop per spec; `?focus=search` therefore needs no extra branch — it documents intent in the dashboard link. Mobile never auto-focuses: the keyboard would cover the list.)

- [ ] **Step 3: Syntax check + unit tests**

Run: `node --check app/js/songs.js && node tests/unit.js`
Expected: pass, 183 passed.

- [ ] **Step 4: Verify with Kev, then commit**

Desktop `/:slug/songs`: search focused on load. `/:slug/songs?new=1` while logged in: new-song panel open. Mobile: no keyboard popup. SPA nav from dashboard buttons (Task 7) behaves the same.

```bash
git add app/js/songs.js
git commit -m "feat: songs search auto-focus and ?new=1 deep link"
```

---

### Task 7: Dashboard task button row

**Files:**
- Modify: `app/js/dashboard.js:22-35` (`renderDashboard`)
- Modify: `app/css/app.css` (append)

- [ ] **Step 1: Insert the task row at the top of `el.innerHTML`**

In `renderDashboard`, before `actionRow +` add:

```js
  var taskRow =
    '<div class="dash-tasks">' +
      '<a href="' + b + '/songs?focus=search" class="dash-task-btn">&#128269; Find a song</a>' +
      '<a href="' + b + '/songs?new=1" class="dash-task-btn auth-action">&#65291; Add a song</a>' +
      '<a href="' + b + '/setlist" class="dash-task-btn auth-action">&#9776; Build a setlist</a>' +
    '</div>';
```

and change the assignment to `el.innerHTML = taskRow + actionRow + …`.

(`auth-action` matches the existing view-mode convention: editing entries hidden when not authed; "Find a song" stays visible.)

- [ ] **Step 2: Append CSS to `app.css`**

```css
/* ── Dashboard task buttons ── */
.dash-tasks { display: flex; gap: 0.6rem; margin-bottom: 1.2rem; }
.dash-task-btn {
  flex: 1; text-align: center; padding: 0.9rem 0.4rem;
  border: 1px solid var(--border-color); border-radius: 8px;
  font-size: 0.95rem; text-decoration: none;
}
.dash-task-btn:hover { border-color: var(--secondary-color); background: var(--secondary-color); }
@media (max-width: 640px) { .dash-tasks { flex-direction: column; } }
```

- [ ] **Step 3: Syntax check + unit tests**

Run: `node --check app/js/dashboard.js && node tests/unit.js`
Expected: pass, 183 passed.

- [ ] **Step 4: Verify with Kev, then commit**

Dashboard shows three buttons above the existing CTA/grid; each lands correctly (search focused / panel open / build tab); on a logged-out view of a public workspace only "Find a song" shows; stacked vertically on a narrow phone.

```bash
git add app/js/dashboard.js app/css/app.css
git commit -m "feat: dashboard task entry buttons"
```

---

### Task 8: Unify confirmation wording

**Files:**
- Modify: `app/songs.html` (three confirm blocks: audio ~237, sheet ~257, playback ~276, lyrics ~302)
- Modify: any further hits from the audit grep

- [ ] **Step 1: Audit**

Run: `grep -rn "Yes, delete\|Are you sure\|confirm(" app/*.html app/js/*.js | grep -v node_modules`
List all confirmation texts.

- [ ] **Step 2: Apply the standard wording**

Pattern for every inline confirm: one sentence stating the consequence + buttons `Delete` / `Keep it`. Example for the audio block in `songs.html`:

```html
<span>This removes the audio file permanently.</span>
<button class="btn btn-danger" onclick="confirmDeleteAudio()">Delete</button>
<button class="btn" onclick="cancelDeleteAudio()">Keep it</button>
```

Apply the same two-button wording to each hit from Step 1 (native `confirm()` calls get the one-sentence text inside the call). Handlers/IDs unchanged.

- [ ] **Step 3: Verify with Kev, then commit**

```bash
git add app/songs.html app/js
git commit -m "feat: consistent plain-language delete confirmations"
```

---

### Task 9: Full regression + manual checklist

- [ ] **Step 1: Integration suite against vercel dev**

Run: `vercel dev` (port 3000), then `cd tests && ARTIST_PASSWORD=… npm test`
Expected: all passing (suite creates two persistent `[TEST]` setlists — known behaviour).

- [ ] **Step 2: Manual checklist with Kev (phone + desktop)**

- Nav: More dropdown desktop, flat burger mobile, auth/admin visibility
- Setlist tabs renamed; switching works; saved-setlists empty CTA
- Song form: groups collapse/expand, saves from every group persist (JSONB `||` merge keeps untouched extra keys: open a song with `isrc` set, save, confirm `isrc` survives)
- Songs empty-state CTA (empty workspace)
- Dashboard buttons: all three targets, view-mode hides the two editing buttons
- Touch: icons visible and tappable without hover
- Stage view unaffected (no common.js — none of these files load there except none)

- [ ] **Step 3: Final commit if stragglers, otherwise done**

---

## Self-review notes

- **Spec coverage:** nav (T1), renames (T2), touch (T3), empty states (T4), grouped form (T5), table columns — already satisfied, documented as deviation in header; search focus (T6), dashboard row (T7), confirmations (T8), testing (T9). GEMA/ISRC "behind the fold" is delivered by T5 (Rights & reporting group).
- **Names consistent:** `_pendingFocusSearch`/`_pendingNewSong` defined and used only in T6; `emptyHtml` option defined in T4 Step 1, consumed in T4 Steps 2-3; `dash-task-btn` defined and styled in T7.
- **No placeholders:** T4 Step 3 and T8 are audit-driven by design (grep command + exact pattern to apply) because the target lines weren't all enumerable at planning time.
