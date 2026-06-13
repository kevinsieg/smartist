# Member usability improvements — design

**Date:** 2026-06-11
**Status:** approved design, pending implementation plan

## Problem

Band members are musicians with low computer literacy. They edit data (songs,
setlists), not just read it, on a mix of phone and desktop. Observed pain:
general intimidation, overwhelming forms/tables, and trouble finding their way
around. Top member tasks, in order: look up a song, add/edit song details,
build or tweak a setlist.

Scope decision: targeted fixes to existing pages. No structural redesign, no
"simple mode" toggle, no onboarding tours.

## 1. Language & declutter

**Navigation.** Top-level links reduce to Songs, Setlists, Gigs. Venues,
Organizers, Hub, and PRO move into a single "More" dropdown in the nav
(built by `injectShell()` in `common.js`). Users stays admin-only and Profile
stays in the auth menu, both unchanged.

**Renames.** Setlist page tabs: "Generator" → "Build setlist",
"History" → "Saved setlists". No other member-facing industry jargon at first
sight; GEMA/ISRC/PRO terms move behind the fold (section 2).

**Touch.** Controls that only appear on mouse-hover (e.g. the song-edit pencil
in setlist history) become always-visible on touch devices via
`@media (hover: none)`. Icon-only buttons get a ≥44px tap area.

**Empty states.** Songs, Setlists, and Gigs pages each get a one-line empty
state with a single call-to-action button (e.g. "No songs yet — Add your first
song").

**Confirmations.** Keep the inline confirm pattern; unify wording: one
sentence stating what happens, buttons "Delete" / "Keep it".

## 2. Simple forms (selected: grouped layout)

**Song edit form.** Basics always visible: Title, Key, Capo, Length, Lyrics,
plus the primary listen/recording action. Everything else moves into three
collapsed groups (collapsed by default):

- **Recordings & sheet music** — listen/playback/sheet uploads and links
- **Song info** — artist (interpret), genre, tempo, BPM, lead, reference and
  song-info links
- **Rights & reporting** — ISRC, language, GEMA status

**Songs table.** Default visible columns: Title, Key, Capo, Length. Applies
only when the workspace has not customised `config.displayFields` — existing
configurations are respected. The filter/search input sits on top and is
auto-focused on page load on desktop only (auto-focus on mobile pops the
keyboard and hides content).

## 3. Dashboard task entry (selected: button row)

A compact row of three large buttons above the existing dashboard content:

| Button | Target |
|--------|--------|
| Find a song | `/:slug/songs` with search focused (`?focus=search`) |
| Add a song | `/:slug/songs` with the new-song form open (`?new=1`) |
| Build a setlist | `/:slug/setlist` on the "Build setlist" tab |

Deep links are handled client-side by the existing page scripts (query params
on page URLs never reach the server rewrites). "Add a song" and "Build a
setlist" follow the existing auth-action/view-mode visibility conventions;
"Find a song" is visible to anyone who can see the dashboard.

## Constraints

- Vanilla JS, no build step; changes live in `common.js` (nav, shared CSS),
  `songs.html`/`songs.js`, `setlist.html`/`setlist.js`, `dashboard.js`.
- No new serverless functions (Hobby limit) and no API changes.
- Respect SPA global-name rules (page scripts use private names; `navigate()`
  keeps old scripts alive).
- `var` not `let` at top level in page scripts (re-execution on SPA nav).

## Risks

- Tests or docs may assert on the "Generator"/"History" tab labels — check
  during implementation.
- Column defaults must not clobber workspaces that already set
  `displayFields`.
- The "More" dropdown must work with the existing burger menu on mobile.

## Testing

- Existing unit + integration suites must stay green.
- Manual checklist on phone and desktop: nav (More dropdown, burger), song
  edit groups expand/collapse and save correctly (JSONB `||` merge must
  preserve folded fields that were not rendered), table defaults, all three
  dashboard buttons land focused/open as specified, hover-only controls
  visible on a touch device.
