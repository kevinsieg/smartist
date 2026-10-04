// Shared domain constants used by API handlers.

const GEMA_ROLE_TYPES = ['composer', 'lyricist', 'author'];

const MEDIA_LOG_ACTIONS = [
  'audio_replace',    'audio_delete',
  'sheet_replace',    'sheet_delete',
  'playback_replace', 'playback_delete',
];

// Newest history entries kept per song (song_logs): restore reads the last
// one, the history list shows 20 at most. Trimmed on every logged write.
const SONG_LOG_KEEP = 20;

// Facebook Graph API version, used for both the login dialog and the Graph
// calls. Meta retires a version roughly two years after release and then
// silently serves the oldest one still live, so every call names this
// explicitly — an unversioned call changes behaviour without a code change.
// Bump here and the dialog, the token exchange and /me all move together.
const FB_GRAPH_VERSION = 'v25.0';

module.exports = {
  GEMA_ROLE_TYPES,
  MEDIA_LOG_ACTIONS, FB_GRAPH_VERSION, SONG_LOG_KEEP,
};
