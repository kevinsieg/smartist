# Self-service email change — design

**Date:** 2026-09-18
**Status:** approved, not yet implemented
**Branch:** `feat/email-change` (worktree off `dev`)

## Why

Email is the identity across workspaces: `resolveUser` in `api/_auth.js` resolves
membership by joining `users` on email, so whoever controls an email controls
every band that address belongs to.

Because of that, admin-editable emails were an account-takeover path and were
removed in PR #40 (`PUT /api/:artist/auth` now rejects any request carrying
`email`). That closed the hole but left no way at all to change a login address:
the only workaround is to delete the member and re-invite them, which resets
their password and drops their role.

This design restores the capability the way established products do: the person
owning the address changes it themselves, and the new address must be confirmed
before it becomes an identity.

## Constraints

- **`api/` is at exactly 12 route files**, the Hobby-plan function limit. This
  flow adds **no** functions: both steps are new `?action=` values on the
  existing `api/[artist]/auth.js`, and the confirm page is a static rewrite.
- Confirmation is clicked from an inbox, so that step must work **unauthenticated**.
- A change must keep the person's other bands. Anything that rewrites one
  workspace only would split them into two identities with two passwords.

## Decision

Changing an email is a two-step, token-confirmed flow owned by the account holder.
Confirming lists every affected band **before** the change is applied.

### API

Both on `api/[artist]/auth.js`; no new function.

**1. `POST /api/:artist/auth?action=request-email-change`** — authenticated.

Body: `{ currentPassword, newEmail }`.

- Requires a real user row. Legacy bootstrap logins (`req.user.id === null`,
  band-password auth) are rejected with the same message `change-password` uses:
  `Password change is not available for this account`.
- Verifies `currentPassword` with bcrypt against the caller's row; wrong password
  → `401`.
- Validates `newEmail` with `validateStr(email, 200)` plus
  `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/` — the same pair the removed admin path used —
  and lowercases it. Invalid → `400`. An address equal to the current one → `400`.
- Rate limit `emailchg:<ip>`, 5 per 600s, mirroring `chpw:`.
- Generates 32 random bytes; stores **only** `sha256(token)` in
  `email_change_token_hash`, the address in `pending_email`, and
  `now() + 24h` in `email_change_expires_at`, all on the caller's row. A new
  request overwrites any previous pending change.
- Sends the confirmation link to the **new** address. Returns `{ ok: true }`
  regardless of whether that address is already in use elsewhere — the collision
  is reported at confirm time, so this endpoint never discloses who holds an
  address.

**2. `POST /api/:artist/auth?action=confirm-email-change`** — unauthenticated.

Two modes in one action, which is what keeps the function count unchanged:

- `{ token }` → **preview**, writes nothing. Returns
  `{ newEmail, bands: [{ slug, name, role }] }`, the bands being every workspace
  whose `users` row carries the current (old) address.
- `{ token, confirm: true }` → applies the change.

Both look the row up by `email_change_token_hash = sha256(token)` with
`email_change_expires_at > now()`. No match → `400 Invalid or expired link`.

Rate limit `emailchg-confirm:<ip>`, 10 per 600s. A 32-byte token is not
realistically guessable, but the endpoint is unauthenticated, so the limit blunts
automated probing and keeps the cost of a flood low.

### Applying the change

In one `sql.begin` transaction:

1. Re-read the pending row and re-check the token and expiry inside the
   transaction.
2. Collect every `users` row whose email equals the old address.
3. If any of those `artist_id`s already has a row with the new address, abort
   with `409` naming the band, e.g.
   `That email is already used in "Band Name"`.
4. `UPDATE users SET email = <new> WHERE email = <old>` — every row, so all
   memberships follow the person.
5. Clear `pending_email`, `email_change_token_hash` and
   `email_change_expires_at` on the originating row, making the token single-use.

A concurrent claim on the same address can still lose the race between steps 3
and 4, so the unique-violation code `23505` is caught and mapped to the same
`409`.

After the transaction commits, a notice goes to the **old** address. A failure to
send is logged via `_logger` and does not roll back the change — the change is
already durable and retrying the mail would risk applying it twice.

Confirming does **not** issue a session. The person logs in with the new address
afterwards. This keeps the unauthenticated endpoint incapable of minting
credentials.

### Schema

Three columns on `users`, mirroring the existing invite columns
(`invite_token_hash` / `invite_expires_at`):

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email             TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_token_hash   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_expires_at   TIMESTAMPTZ;
```

Appended to `scripts/schema.sql`, which is idempotent. Another agent session is
appending `venues` columns to the same tail, so the final line order may need
reconciling at merge time.

### Link format

```
{origin}/confirm-email#token=<raw token>&slug=<artist slug>
```

The token sits in the **fragment**, never the query string, so it cannot reach
server or CDN logs — the same rule the password-reset link follows. The slug
travels with it because `api/[artist]/auth.js` is slug-scoped and the confirm
page has no session to infer it from.

`/confirm-email` is added to `vercel.json` as a static rewrite to
`app/confirm-email.html`, costing no function.

### Emails

Two messages, both English-only, matching every other transactional mail in the
codebase (`request-reset` and the invite mails are not translated):

- **To the new address** — subject `Confirm your new email address`; one link,
  stated 24-hour validity, and a "you can ignore this" line.
- **To the old address** — subject `Your email address was changed`; states the
  new address, contains **no link**, and tells the reader to contact support if
  it wasn't them. A hijack attempt is therefore visible to the real owner.

### UI

- **`/profile`** gains a Change email section: current password, new address,
  submit, and a status line confirming that a link was sent. It sits under the
  existing read-only email display, replacing the "ask an admin" hint.
- **`/confirm-email`** is a new standalone page. It reads the fragment, calls
  preview mode, and renders the new address plus the affected bands, then a
  Confirm button. Success shows a "log in with your new address" link; an expired
  or used token shows a plain error.

The confirm page loads `common.js` and `i18n.js` like other pages, so it must not
declare top-level `const`/`let` (see `tests/unit/page_scripts.js`).

### i18n

New keys in `app/i18n/{en,fr,de}.json` for the profile section and the confirm
page, plus an `I18N_VERSION` bump and matching `?v=` query updates. The version
is currently contended with the other agent session, so it is bumped last, right
before commit. Email bodies are not translated, per the decision above.

### Tests

Unit, through the existing `tests/unit/auth_handler.js` harness (stubbed `_db`,
`_auth`, `_email`, `bcrypt`):

- request with a wrong current password → `401`, nothing written
- request from a bootstrap login (`req.user.id === null`) → `400`
- request with an invalid or unchanged address → `400`
- request stores a token **hash**, never the raw token, and sets a future expiry
- preview mode returns the affected bands and issues no `UPDATE`
- confirm rewrites **every** row sharing the old address, in a transaction
- confirm clears the pending columns, so replaying the token → `400`
- expired token → `400`
- new address already present in an affected band → `409`, nothing written
- notice-mail failure still leaves the change applied

Integration (`tests/api.js`, behind `ARTIST_PASSWORD`): both actions reject
unauthenticated and malformed calls. The happy path is not automated end to end,
because it needs a real inbox.

### Rollout

1. Apply the three columns to the dev database with `scripts/apply_schema.js`.
2. Merge to `dev`, verify on Preview with a real address.
3. Apply the same columns to both production databases before promoting to
   `main`. The columns are additive with no defaults to backfill, so old code
   ignores them and the migration can run well ahead of the deploy.

## Out of scope

- Changing the address on legacy bootstrap accounts, which have no `users` row.
- Restoring any admin-initiated email change; that path stays closed.
- Whether Facebook login remains an identity source — Facebook documents no
  verification guarantee for its `email` field and offers no flag to check, so it
  is a separate decision.
