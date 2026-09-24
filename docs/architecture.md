# Architecture decisions

The decisions behind the current code, and why they were made. Day-to-day
conventions (handler skeleton, validation, i18n, styling) are in `CLAUDE.md`;
the schema is in `DATABASE.md`.

---

## Layers

- **`api/`**: thin HTTP handlers. They parse, call domain code, respond.
- **`api/_domain/`**: business logic, with no HTTP and no DOM. Most of
  `api/config.js` is a router into these modules.
- **`api/_*.js`**: infrastructure (db, email, storage, logger, tokens, rate
  limits). Each swappable provider sits behind one block at the top of its file.
- **`app/js/services/`**: API client wrappers used by the standalone pages.

Vercel's Hobby plan allows 12 functions, and the app uses 11. Files starting
with `_` are not functions, so new logic goes into `_domain/` rather than a new
endpoint. That is also why some routes share a handler via `vercel.json`
rewrites.

---

## Accounts, workspaces and roles

- **A workspace is a band** (`artists` row). **A person is one `users` row per
  workspace**, and the rows are tied together by the **email address**. Sessions
  are stateless tokens that carry a user id. `requireAuth` resolves membership in
  the requested workspace by joining on email, so one login reaches every band
  the person belongs to.
- Because email is the identity, **every path that writes or trusts an email
  must prove ownership**:
  - Admins cannot edit a member's email.
  - Changing your own email sends a link to the *new* address, and nothing
    changes until it is confirmed.
  - Google sign-in requires `verified_email === true`.
  - Emails are stored lowercased, enforced by a database CHECK.
- **Roles:**
  - `admin`: everything, including members.
  - `member`: full app access.
  - `viewer`: read-only.

  They are enforced in the API with `requireRole`. The client only hides what
  the role cannot use (`.admin-only`, `.auth-only`).
- **Signup** creates a new workspace. **Invites** add a person to an existing
  one. `scripts/create_user.js` creates the first account for a band that has
  none.
- **A workspace is private by default.** Anonymous access is opt-in per surface
  (`publicCatalogue`, `publicStage`); see `CLAUDE.md`.

---

## Account deletion

Deletion acts on every `users` row sharing the address. Each workspace falls
into one of three cases:

| Case | Result |
|---|---|
| Only member | The whole workspace goes: rows and files. |
| Other members, not the sole admin | Only their membership goes. |
| Other members, sole admin | **Blocked.** |

One blocked workspace blocks the whole deletion, so an account is never
half-deleted. A confirmation link is emailed, and opening it only *shows* what
would be deleted; a separate click deletes. That way mail scanners and the Back
button cannot delete anything.

Song media keys are **not scoped by workspace**: `audio/<uuid>-name` is one flat
namespace shared by every band. Files are therefore deleted by enumerating
them from the database, never by prefix. Deleting `audio/` would delete every
band's recordings.

A workspace can be exported first: a ZIP with one CSV per table
(`api/_export.js`).

---

## Plans and billing

`api/_plans.js` is the single source of truth for what Free and Pro include.
`getPlan(artist)` is the only entitlement check, and it reads
`artists.config.plan`. Limits are enforced server-side with `402` and a machine
code, and the client only mirrors them for UX. Today the upgrade flips the plan
directly. Paid billing would only change what writes `config.plan`, through the
`?action=upgrade` seam. Donations are voluntary and unlock nothing.

---

## Media and storage

Uploads go straight from the browser to R2 using presigned URLs, and the server
confirms each one afterwards. `artists.storage_used_bytes` is maintained
atomically on confirm and delete (net of a replaced file), so the plan's
storage cap needs no bucket listing. Gig posters get a thumbnail generated in
the browser before upload.

---

## Client

- **No build step.** Pages are plain HTML with one script per page. `common.js`
  builds the header, `footer.js` builds the footer (the same one on every
  page), and in-app navigation swaps page content without a full reload
  (`navigate()`). Page scripts therefore share one global scope: use `var` and
  private names (enforced by `tests/unit/page_scripts.js`).
- **Two list factories exist:**
  - `createSortableList` in `common.js`, used by gigs, venues and organizers.
  - `createListView` in `list-view.js`, used by songs and setlist history.

  `createListView` can do more. Gigs has not moved to it because it renders two
  tables (upcoming and past) sharing one sort bar, which `createListView` does
  not support yet.
- **Three languages** (EN, FR, DE). Only one dictionary is loaded, and
  `tests/unit/i18n.js` enforces identical key sets across the three locales.
  `stage.html` is English-only on purpose.

---

## Deployment

One codebase serves both a public multi-band deployment and single-band
deployments. `ARTIST_SLUG` decides which: see [`deployment.md`](deployment.md).
