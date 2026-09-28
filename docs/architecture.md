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
  - Google sign-in requires `verified_email === true`. Facebook reports no
    such flag, so it may only sign into an existing account when the
    deployment sets `FACEBOOK_TRUST_EMAIL=true`.
  - OAuth `state` is bound to an `oauth_nonce` cookie set when the flow
    starts, so a callback URL cannot be replayed in someone else's browser.
  - Emails are stored lowercased, enforced by a database CHECK.
- **Roles:**
  - `admin`: everything, including members.
  - `member`: full app access.
  - `viewer`: read-only.

  They are enforced in the API with `requireRole`. The client only hides what
  the role cannot use (`.admin-only`, `.auth-only`).
- **Sessions end when the password changes.** A session token carries a
  fingerprint of the password hash it was issued against; changing or resetting
  the password makes every earlier session stop verifying.
- **Email links are single-purpose.** Magic tokens are signed for `login`,
  `reset` or `demo`, and one cannot be redeemed as another. The public demo
  gate hands out a `demo` token, which is a *member* session: no settings,
  invites or uploads.
- **Signup** creates a new workspace. **Invites** add a person to an existing
  one. `scripts/create_user.js` creates the first account for a band that has
  none.
- **A workspace is private by default.** Anonymous access is opt-in per surface
  (`publicCatalogue`, `publicStage`, both off); see `CLAUDE.md`.

---

## Tenant isolation

All bands share one database, and row ids are one sequence across all of them.
So an id is never proof of ownership:

- Every query is scoped by `artist_id`, including the joins.
- Every foreign id that arrives in a request body — `song_ids`, `gig_id`,
  `venue_id`, `organizer_id` — is checked against the caller's band
  (`api/_ownership.js`) before anything is written.
- Links stored in a song's `extra` (`*Url`) must be http(s), and a link into our
  bucket is accepted only if the upload flow put it there.

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

Files are deleted by enumerating them from the database, never by key prefix.
Song media uploaded before keys were scoped lives in one flat namespace
(`audio/<uuid>-name`) shared by every band, so deleting `audio/` would delete
everyone's recordings. New uploads are `audio/<artist id>/<uuid>-name` (likewise
`sheets/`, `playback/`), and deletes only touch keys that are the band's own or
predate scoping.

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

## Songs and lyrics

The song list is loaded on every songs, setlist and dashboard page, so it
carries only what a list shows. Lyrics (up to 20 000 characters each) live in
their own table, `song_lyrics`: a list row says `has_lyrics`, and the text comes
with one song's details, the first time the panel, the lyrics modal or the
stage view needs it. The CSV export asks for all of them in one request.
Bulk writes (songs PATCH, GEMA import) are one statement per batch, with their
audit entries in the same statement.

---

## Media and storage

Uploads go straight from the browser to R2 using presigned URLs, and the server
confirms each one afterwards. The presigned URL signs the byte count, and the
confirm step checks that the key carries the band's id. `artists.storage_used_bytes` is maintained
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
