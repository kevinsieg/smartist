# Two List Factories — Architecture Notes

## Current state

The app has two separate list-rendering factories:

| Factory | File | Used by |
|---------|------|---------|
| `createSortableList` | `app/js/common.js` | gigs, venues, organizers |
| `createListView` | `app/js/list-view.js` | setlist history, songs |

`createListView` is strictly more capable: filter bar, grouped list, side panel, async text filters, `onRowClick` hook. `createSortableList` is older and simpler.

## Migration blockers (as of 2026-05-31)

1. **Gigs: two table instances sharing one sort bar.** Gigs splits data into
   `upcoming-list` and `past-list` — two `createSortableList` instances that
   share the same `sortBarId`. `createListView` does not support multiple
   instances sharing one filter bar. Would need a `multiInstance` option or a
   different approach (render both as groups within one `createListView`).

2. **Venues: server-side pagination + tab/map view.** Venues fetches pages
   from the server and has a secondary "Map" tab. `createListView` uses a
   client-side `getData(state)` callback and does not support server-side
   pagination or tab switching. Would need a `fetchPage` option.

## Recommended next step

Do not attempt a full migration now. Instead, when the next list-level feature
is needed (export, bulk select, keyboard nav), add it to `createListView` first
and then evaluate whether a targeted extension to `createSortableList` is
worth it. Keep the gap from widening.
