# Self-service account deletion — design

**Status:** design, not yet implemented
**Date:** 2026-09-23

## Why now

Three separate things ask for it:

- **The privacy policy already promises it.** smartist.studio/privacy went live
  on 2026-09-23 saying an account and its content are deleted within 30 days of
  an emailed request, and admitting there is no button yet. That promise is
  public.
- **GDPR.** The right to erasure is not conditional on us having built a UI.
- **Meta.** "Give them a way to log out, disconnect their account, or delete it
  all together… this is also a requirement of our Developer Policies for Login."
  It is one of the gates before the Facebook app can go Live
  (`2026-09-22-oauth-setup.md`).

Today the only deletion path is `scripts/delete_artist.js`, run by hand, and it
deletes a *workspace*, not a person.

---

## What "my account" means here

`getArtistsForUser` joins on **email**, not user id:

```sql
WHERE u.email = (SELECT email FROM users WHERE id = ${userId})
```

One person is several `users` rows — one per workspace — tied together by the
address. So deletion operates on every row sharing that address, not on the row
behind the current session.

Each workspace the person belongs to falls into one of three cases:

| Case | What happens |
|---|---|
| They are the **only member** | The whole workspace is destroyed: rows and files. |
| There are other members and they are **not the sole admin** | Only their `users` row goes. The band carries on. |
| There are other members and they are the **sole admin** | **Blocked.** |

**Blocking is deliberate.** The alternative — destroying a band's catalogue
because one member closed their account — is not a decision one person should be
able to make for everyone, and an automatic hand-over would give admin rights to
someone who never asked for them. The refusal names the workspaces and says what
to do: promote another admin, or remove the other members first.

**One blocker blocks everything.** If any workspace is in the third case, the
whole deletion refuses — it does not delete the other workspaces and leave the
account half-gone. A partially deleted account is a state nobody asked for and
nobody can reason about afterwards: the person believes they are gone, their
address still resolves, and the next login lands somewhere unexpected.

**The session dies with the rows.** Session tokens are stateless and carry an
eight-hour TTL, so nothing revokes them directly — but `requireAuth` resolves
membership by looking the user up, and that lookup now finds nothing. Any tab
still open starts failing its next request, which is the correct outcome.

---

## Confirmation

An emailed, single-use link, expiring in 30 minutes (the existing magic-link
TTL). Not a password prompt: accounts created through Google have no password at
all, so a password gate would lock exactly the people most likely to want this
out of it.

**This does not work on klang or salmons yet.** Those deployments use a
different Resend account in which `kevinklang.de` is not verified, so no
transactional mail leaves them. app.smartist.studio is fine. Until Resend is
fixed there, the button must be hidden — or gated on mail being configured —
rather than shipped as something that silently does nothing.

---

## Schema

Two columns on `users`, mirroring `invite_token_hash` / `invite_expires_at`,
which already exist on that table for the same shape of problem:

```sql
-- 2026-09-23: self-service account deletion
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_token_hash    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_token_expires TIMESTAMPTZ;
```

The token is stored as SHA256, never in the clear, exactly as the signup and
invite tokens are.

**This migration must be applied to every production database**, not just the
linked one: `smartist-kevin` (serves both salb and klang) and `smartist` (the
public product), plus dev. Missing `APP_SECRET` on two projects took them down
for months; the same class of mistake applies here.

---

## Endpoints

Both are new actions on `api/config.js`, which is a router — no new serverless
function, so the count stays at 11 of 12.

| Action | Auth | Does |
|---|---|---|
| `GET ?action=deletion-preflight` | session | Returns what would happen: workspaces destroyed, workspaces left, blockers. |
| `POST ?action=request-deletion` | session | Rate-limited. Stores a token hash, emails the link. |
| `POST ?action=confirm-deletion` | token | Re-checks, then deletes. |

`confirm-deletion` authenticates on the token alone, not on a session — the link
may well be opened in a different browser from the one that asked.

---

## The deletion, in order

The ordering is the design; each step exists because the one after it cannot be
undone.

1. **Re-check the blockers.** The preflight answer is stale by the time a link
   is clicked — someone may have left the band, or been promoted, in between.
   Trusting the earlier answer would let a race destroy a shared workspace.
2. **Enumerate the R2 URLs while the rows still exist:** `songs.extra`
   (`listenUrl`, `sheetUrl`, `playbackUrl`) **including soft-deleted songs**,
   `gigs.poster_url`, `gigs.thumb_url`, and `artists.config.logoUrl`.
3. **Delete the rows in one transaction**, reusing the ordering
   `scripts/delete_artist.js` documents: nullify `gigs.venue_id` and
   `gigs.organizer_id` first (both `ON DELETE RESTRICT`), drop setlists before
   songs (`setlist_songs.song_id` has no cascade), then `DELETE FROM artists`
   and let the cascade do the rest.
4. **Delete the R2 objects**, best-effort, logging every failure by key.

### Why the files cannot be deleted by prefix

Song media keys are **not scoped to a workspace**. `_media.js` builds them as
`audio/<uuid>-<name>`, `sheets/…`, `playback/…` — one flat namespace shared by
every tenant. Only gig posters (`gigs/<slug>/`) and band images (`bands/<slug>/`)
carry the slug.

So deleting `audio/` by prefix would delete every band's recordings. Enumeration
from the database is the only correct route, and `_r2.js` exposes no list
operation anyway — only `deleteFromR2` by URL.

### Why step 4 is outside the transaction

R2 has no rollback. A file deleted before a failed transaction is gone with its
row still pointing at it; a transaction committed before a failed delete leaves
an orphan. The orphan is the better failure: its URL is an unguessable UUID in a
bucket that is not publicly listable, so it is a storage leak rather than an
exposure. It must be logged loudly rather than swallowed — `insertAuditLog`
swallows by design, so this uses `logger.error`.

A reconciliation pass belongs in `scripts/plans.js --recount`, which already
walks R2 against `storage_used_bytes`.

---

## UI

`/profile` (inline script in `profile.html`) grows a danger zone at the bottom:

- Preflight result in plain words — what is destroyed, what is left, what blocks.
- A link to export first, using the existing `GET /api/:artist/export`.
- The request button, disabled while any blocker stands.
- After requesting: "check your email", with the address shown.

New i18n keys in all three locales; `I18N_VERSION` and the `i18n.js?v=` query
bumped on every page, plus `app.css?v=` if the danger zone needs styles.

---

## Testing

| Test | Why |
|---|---|
| Sole admin with other members is refused, and the response names the workspaces | The central rule. |
| The blocker is re-checked at confirm, not trusted from preflight | The race in step 1. |
| A token works once; a second use fails | Replay from a forwarded or logged link. |
| An expired token fails | The 30-minute bound. |
| A sole-member workspace loses its rows *and* its files | The promise the privacy policy makes. |
| A shared workspace loses only the `users` row | The band survives. |
| R2 enumeration includes soft-deleted songs | Their files are still in the bucket. |
| R2 failure leaves the DB deleted and logs the key | The deliberate failure mode of step 4. |

Unit tests follow the existing handler pattern (`tests/unit/oauth_callback.js`,
`login_handler.js`): mock `_db`, `_ratelimit`, `_email` and `_r2` in the require
cache. **Evict `_token` too** — earlier files in the suite leave a stub there
whose `generateUserToken` returns a fixed string, and a test that does not evict
it asserts against the stub and proves nothing.

---

## Out of scope

- **Meta's data deletion callback.** It can call this path once it exists, but
  it is a separate endpoint with its own signed-request format and its own
  response contract. Tracked in `2026-09-22-oauth-setup.md`.
- **Deleting a single workspace from the UI.** Different feature, different
  confirmation, and `scripts/delete_artist.js` covers it for now.
- **A grace period.** Deletion is immediate once the link is clicked. A
  30-day soft-deleted account state would touch every query in the app.
  The privacy policy's "within 30 days" is an upper bound on our response, not a
  promise to keep the data that long.
