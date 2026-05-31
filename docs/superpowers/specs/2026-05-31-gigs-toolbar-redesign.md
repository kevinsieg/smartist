# Gigs toolbar redesign

**Date:** 2026-05-31

## Goal

Move the "Subscribe to calendar" and "Copy link" buttons out of the separate `gig-cal-bar` strip and into a new dedicated action row above the filter area. Replace the always-visible filter inputs with a collapsible panel toggled by a single button.

## Layout (all breakpoints)

### Action row (always visible)
```
[ 📅 Subscribe to calendar | Copy link ]          [ + Add gig ]
```
- Left: calendar pill group — two segments separated by an internal divider, enclosed in one border.
  - Segment 1: calendar icon + "Subscribe to calendar" link (webcal:// href).
  - Segment 2: "Copy link" button (copies https:// ICS URL to clipboard, flashes "copied!" for 2 s).
  - Both segments visible to everyone (no auth gate).
- Right: `+ Add gig` button — keeps existing `auth-action disabled` behaviour (hidden in view mode).

### Filter toggle (below action row)
```
[ ⊟ Filters ▾ ]            (collapsed, no active filters)
[ ⊟ Filters ▴  1 ]         (expanded or has active filters — amber border, badge count)
```
- Single button, collapsed by default on every page load.
- Clicking toggles the filter panel open/closed and flips the arrow (▾ / ▴).
- Badge: count of fields with non-empty values, shown when > 0 regardless of open/closed state.
- Amber border + text colour when badge > 0 (same as `--secondary-ink: #b06a2a`).
- If the page loads with URL query params (`?gig=`, `?venue=`, `?setlist=`, `?song=`), open the panel automatically and populate the inputs as before.

### Filter panel (collapsible, hidden by default)
- Contains the four existing filter inputs: Gig, Venue, Setlist, Song.
- Setlist field keeps its `auth-only` class (hidden in view mode).
- Venue field keeps its `gig-filter-desktop` class (hidden on mobile).
- Panel is a flex-wrap row on desktop, stacked column on mobile.

### Sort bar
Unchanged — stays directly below the filter panel.

## Responsive behaviour

| Breakpoint | Action row | Filter toggle |
|---|---|---|
| ≥ 640 px | Cal group left, Add gig right, single row | Inline button (auto width) |
| < 640 px | Cal group full width, Add gig full width below | Full width |

## Files changed

### `app/gigs.html`
1. Remove the existing `.gig-cal-bar` div.
2. Remove the `filter-bar-row1` / `filter-bar-fields` wrapper; the Add gig button moves to the action row.
3. Add `#gig-action-row` before the `filter-bar` div.
4. Add `#gig-filter-toggle` button and `#gig-filter-panel` wrapper around the filter fields.
5. Update page-scoped `<style>` — remove old filter-bar overrides, add action row + toggle + panel rules.

### `app/js/gigs.js`
1. Replace `.gig-cal-bar` show/hide with the new element IDs (`#gig-cal-subscribe`, `#gig-cal-copy` keep their IDs — no selector change needed for the link/button themselves).
2. Remove the `_calBar.style.display = ''` line (no longer needed).
3. Add filter toggle click handler: toggles `#gig-filter-panel` visibility, flips arrow text, updates badge.
4. Add `_updateFilterBadge()` helper called from every filter input's `input` event and on page load.
5. Auto-open panel if any URL query param is set (existing deeplink logic already populates the inputs; just call `_openFilterPanel()` after that block).

## Behaviour details

- Filter state (`_gigFilters` object) is unchanged — same keys, same event wiring.
- Closing the filter panel does not clear active filters; badge persists to signal hidden active state.
- No localStorage persistence for panel open/closed state (always starts collapsed).
- "Copy link" feedback: button text changes to "copied!" for 2 s, same as today.
