// Shared domain constants used by API handlers.

const VENUE_STATUSES = ['prospect', 'contacted', 'confirmed', 'active', 'declined'];

// Statuses visible to unauthenticated (view-mode) visitors.
const VENUE_PUBLIC_STATUSES = ['active', 'confirmed'];

const VENUE_CATEGORIES = ['club', 'restaurant', 'festival', 'pub', 'private', 'street', 'placeholder'];

const GEMA_ROLE_TYPES = ['composer', 'lyricist', 'author'];

const MEDIA_LOG_ACTIONS = [
  'audio_replace',    'audio_delete',
  'sheet_replace',    'sheet_delete',
  'playback_replace', 'playback_delete',
];

// Facebook Graph API version, used for both the login dialog and the Graph
// calls. Meta retires a version roughly two years after release and then
// silently serves the oldest one still live, so every call names this
// explicitly — an unversioned call changes behaviour without a code change.
// Bump here and the dialog, the token exchange and /me all move together.
const FB_GRAPH_VERSION = 'v25.0';

module.exports = {
  VENUE_STATUSES, VENUE_PUBLIC_STATUSES, VENUE_CATEGORIES, GEMA_ROLE_TYPES,
  MEDIA_LOG_ACTIONS, FB_GRAPH_VERSION,
};
