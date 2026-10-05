#!/usr/bin/env node
// Runs all unit suites and prints a combined summary.
// Each suite under tests/unit/ can also be run standalone.
const { makeRunner } = require('./unit/_runner');

const suites = [
  require('./unit/validate'),
  require('./unit/token'),
  require('./unit/pdf'),
  require('./unit/r2'),
  require('./unit/lyrics'),
  require('./unit/ratelimit'),
  require('./unit/gema'),
  require('./unit/ai'),
  require('./unit/handler'),
  require('./unit/router'),
  require('./unit/openapi'),
  require('./unit/subscribe'),
  require('./unit/contact'),
  require('./unit/i18n'),
  require('./unit/arrangement'),
  require('./unit/user_token'),
  require('./unit/auth'),
  require('./unit/identity'),
  require('./unit/oauth_callback'),
  require('./unit/deletion'),
  require('./unit/deletion_handlers'),
  require('./unit/artist'),
  require('./unit/registration'),
  require('./unit/config_signup'),
  require('./unit/login_handler'),
  require('./unit/reset_handlers'),
  require('./unit/members_handler'),
  require('./unit/rbac_handlers'),
  require('./unit/tx_handlers'),
  require('./unit/venue_handlers'),
  require('./unit/organizer_handlers'),
  require('./unit/song_handlers'),
  require('./unit/song_import'),
  require('./unit/song_logs_trim'),
  require('./unit/gig_handlers'),
  require('./unit/plans'),
  require('./unit/asset_versions'),
  require('./unit/page_styles'),
  require('./unit/labels'),
  require('./unit/click_targets'),
  require('./unit/page_scripts'),
  require('./unit/storage_accounting'),
  require('./unit/export'),
  require('./unit/client_escape'),
  require('./unit/chords'),
  require('./unit/song_tags_client'),
  require('./unit/tenant_isolation'),
  require('./unit/with_busy'),
  require('./unit/song_values'),
  require('./unit/env'),
  require('./unit/logger'),
  require('./unit/http_adapter'),
  require('./unit/csp'),
  require('./unit/ignore_build'),
  require('./unit/inline_handlers'),
  require('./unit/api_fetch'),
  require('./unit/backup'),
  require('./unit/schema_scripts'),
  require('./unit/health'),
];

(async () => {
  const r = makeRunner();
  for (const suite of suites) {
    const result = suite(r);
    if (result instanceof Promise) await result;
  }
  process.exit(r.summary() > 0 ? 1 : 0);
})();
