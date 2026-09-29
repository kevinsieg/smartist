#!/bin/bash
# Claude Code on the web: install dependencies and bring up the local test
# stack (Postgres + seeded band + API on :3000, see scripts/dev_up.sh), so
# `npm run test:all` works from the first prompt. The session's DATABASE_URL
# points at that local database — agents never get a remote one by default.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# npm install rather than npm ci: the container is cached after this hook,
# and install reuses what is already there.
npm install --no-audit --no-fund

# Postgres for the local stack. Best effort: a session without it still has
# the unit tests.
if ! command -v pg_ctl >/dev/null 2>&1 && ! ls /usr/lib/postgresql/*/bin/pg_ctl >/dev/null 2>&1; then
  (apt-get install -y -qq postgresql >/dev/null 2>&1 || true)
fi

if bash scripts/dev_up.sh up > /tmp/smartist-env 2>/tmp/smartist-up.log; then
  [ -n "${CLAUDE_ENV_FILE:-}" ] && cat /tmp/smartist-env >> "$CLAUDE_ENV_FILE"
  echo "local stack up: $(grep "^export BASE_URL" /tmp/smartist-env)"
else
  echo "local stack not started (see /tmp/smartist-up.log); unit tests still work"
fi
