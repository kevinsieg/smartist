# Profile / Settings refactor — design

**Date:** 2026-06-12
**Status:** approved design

## Problem

`profile.html` is misnamed: it holds workspace config (photo, favicon, band
name, slug, privacy, song-table columns, setlist filter buttons, arrangement
members/instruments) and nothing personal. Member management lives on a
separate admin-only `users.html`. The admin "Users" nav link moved into the
new "More" dropdown during the member-usability work, which read as "the tab
disappeared".

Goal: a personal profile page for every logged-in user, and one admin-only
settings page for everything workspace-related, cleanly structured.

## Pages & navigation

| URL | Audience | Content |
|-----|----------|---------|
| `/:slug/profile` | any logged-in user | email (read-only), change password |
| `/:slug/settings` | admin only (role `admin` or legacy `null`) | all workspace config + members |

- Nav "More" dropdown: the "Users" link becomes "Settings" (keeps the
  `admin-only` class). Profile stays in the auth menu, unchanged.
- `vercel.json`: add `/:slug/settings` → `app/settings.html`; repoint the old
  `/:slug/users` rewrite to the same `settings.html` so bookmarks keep
  working. `profile.html` keeps its URL with new, much smaller content.
- `users.html` and `app/js/users.js` are deleted; their content moves into
  the settings page.

## Settings page structure

Admin gate identical to today's `users.js`: non-admin (role not `admin` and
not legacy `null`) redirects to `/dashboard`.

Stacked sections, one card per topic:

1. **Band** — photo, favicon, band name, slug (read-only). Moved 1:1 from
   `profile.html`.
2. **App settings** — privacy toggle, song table columns (`displayFields`),
   setlist filter buttons (`filterFields`). Moved 1:1.
3. **Members** — current users-page content (active members with role select
   and remove, invite form, pending/expired invites) plus a new per-member
   "edit email" action. Admin can change any member's email including their
   own.
4. **Instruments** — arrangement config (instruments & techniques, band
   members), extended: each member row gets an optional instrument multi-pick
   (from configured instruments) and an optional link to a user account
   (dropdown of member emails, "— none —" default). Stored in
   `arrangementConfig.members[]` as `{ name, abbr, instruments: [],
   userEmail? }` — JSONB only, no schema change.

## Profile page (rebuilt)

- **Account** — email read-only, hint "ask an admin to change it".
- **Change password** — current password + new password (min 8 chars), via
  the new endpoint below. Hidden in legacy bootstrap mode (no `users` row —
  the password lives in the artist row / env).
- Action history: deliberately skipped for now (`song_logs` has no
  `user_id`; revisit later).

## API changes

Both in the existing `api/[artist]/auth.js` — no new serverless function
(Hobby 12-function limit).

- `POST ?action=change-password` `{ currentPassword, newPassword }` —
  verifies the current password with bcrypt against the caller's own `users`
  row, then updates the hash. Rate-limited like login. 400 on short/missing
  passwords, 401 on wrong current password.
- `PUT` (existing role-update endpoint) additionally accepts `email` —
  admin-only, validated like invite emails, unique per workspace (409 on
  conflict). Self-email change is allowed; self-role change stays blocked.
- Trade-off (accepted): multi-workspace identity joins users on email, so
  changing a member's email in one workspace detaches that membership from
  the shared identity.

## Constraints

- Vanilla JS, no build step; SPA global-name rules (private names in page
  scripts, `var` not `let` at top level).
- No new serverless functions; no DB schema change.
- `invalidateConfigCache()` after every `PATCH /api/config`.

## Testing

- `tests/api.js`: change-password (wrong current → error, success → login
  with new password works), admin email change (conflict → 409, success),
  existing user-management tests stay green.
- Manual: settings page as admin/member/viewer, profile as member, nav link
  rename, old `/users` URL lands on settings.
