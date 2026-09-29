#!/usr/bin/env bash
# Local stack for tests: a throwaway Postgres, the schema, a seeded Pro band and
# the API + pages served by tests/harness/server.js — the same setup CI runs.
# Never touches a remote database: DATABASE_URL is always the local one here.
#
#   bash scripts/dev_up.sh up          # start (idempotent), print the env
#   bash scripts/dev_up.sh run <cmd>   # start if needed, then run <cmd> with the env
#   bash scripts/dev_up.sh env         # print export lines for the stack
#   bash scripts/dev_up.sh restart     # restart the API server (after code changes)
#   bash scripts/dev_up.sh down        # stop the server and Postgres
#
# npm run test:api / test:smoke / test:all wrap `run`. Needs Postgres binaries
# (initdb, pg_ctl) — on PATH or under /usr/lib/postgresql/<version>/bin — and,
# for the smoke test, playwright (npm i -g playwright && npx playwright install chromium).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${SMARTIST_LOCAL_DIR:-${TMPDIR:-/tmp}/smartist-local}"
PGDATA="$STATE/pgdata"
PGPORT="${SMARTIST_PGPORT:-5433}"
PORT="${PORT:-3000}"
DB=smartist_local

export DATABASE_URL="postgres://postgres@localhost:$PGPORT/$DB"
export APP_SECRET="local-only-secret"
export ARTIST_SLUG="${ARTIST_SLUG:-local}"
export ARTIST_EMAIL="${ARTIST_EMAIL:-dev@example.test}"
export ARTIST_PASSWORD="${ARTIST_PASSWORD:-local-password}"
export BASE_URL="http://localhost:$PORT"
# Presigning is local signing, no request to R2 — any values do.
export R2_ACCOUNT_ID=local R2_ACCESS_KEY_ID=local R2_SECRET_ACCESS_KEY=local
export R2_BUCKET_NAME=local R2_PUBLIC_URL=https://cdn.example.test
export PORT

log() { echo "  $*" >&2; }

pgbin() {
  if command -v pg_ctl >/dev/null 2>&1; then dirname "$(command -v pg_ctl)"; return; fi
  local d; d=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
  [ -n "$d" ] || { echo "Postgres binaries not found (initdb, pg_ctl)." >&2; exit 1; }
  echo "$d"
}

# initdb and postgres refuse to run as root.
as_pg() {
  if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi
}

start_postgres() {
  local bin; bin=$(pgbin)
  mkdir -p "$STATE"
  [ "$(id -u)" = 0 ] && chown postgres "$STATE"
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    log "initdb $PGDATA"
    as_pg "'$bin/initdb' -D '$PGDATA' -U postgres --auth=trust >/dev/null"
  fi
  if ! as_pg "'$bin/pg_ctl' -D '$PGDATA' status >/dev/null 2>&1"; then
    log "starting Postgres on :$PGPORT"
    as_pg "'$bin/pg_ctl' -D '$PGDATA' -o \"-p $PGPORT -k /tmp -c listen_addresses=localhost\" -l '$STATE/postgres.log' -w start >/dev/null"
  fi
  "$bin/psql" -h localhost -p "$PGPORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
    || "$bin/createdb" -h localhost -p "$PGPORT" -U postgres "$DB"
}

healthy() { curl -sf "$BASE_URL/api/config?action=health" >/dev/null 2>&1; }

start_server() {
  if healthy; then return; fi
  log "starting the API on :$PORT (log: $STATE/server.log)"
  (cd "$ROOT" && nohup node tests/harness/server.js >"$STATE/server.log" 2>&1 & echo $! >"$STATE/server.pid")
  for _ in $(seq 50); do healthy && return; sleep 0.2; done
  cat "$STATE/server.log" >&2; exit 1
}

up() {
  [ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm install --no-audit --no-fund >/dev/null)
  start_postgres
  (cd "$ROOT" && node scripts/apply_schema.js --yes >/dev/null)
  (cd "$ROOT" && node tests/harness/seed.js >/dev/null)
  # Repeated runs would otherwise trip the login rate limit (10 a minute).
  "$(pgbin)/psql" -h localhost -p "$PGPORT" -U postgres -d "$DB" -qc "DELETE FROM rate_limits" >/dev/null
  start_server
}

print_env() {
  for v in DATABASE_URL APP_SECRET ARTIST_SLUG ARTIST_EMAIL ARTIST_PASSWORD BASE_URL R2_PUBLIC_URL; do
    echo "export $v=\"${!v}\""
  done
}

# The server holds its modules in memory: code changes need a restart. Also
# stops a server started by an earlier session whose pid file is gone.
stop_server() {
  if [ -f "$STATE/server.pid" ]; then kill "$(cat "$STATE/server.pid")" 2>/dev/null || true; rm -f "$STATE/server.pid"; fi
  local pids; pids=$(ps -eo pid=,args= | awk '/[t]ests\/harness\/server\.js/ {print $1}')
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  for _ in $(seq 25); do healthy || return 0; sleep 0.2; done
}

down() {
  stop_server
  [ -f "$PGDATA/PG_VERSION" ] && as_pg "'$(pgbin)/pg_ctl' -D '$PGDATA' stop -m fast >/dev/null 2>&1" || true
  log "stopped"
}

case "${1:-up}" in
  up)   up; print_env ;;
  restart) stop_server; up; print_env ;;
  env)  print_env ;;
  run)  shift; up; cd "$ROOT"
        # tests/smoke.js needs playwright, which is not a dependency (it downloads
        # browsers on install). A global install counts too.
        export NODE_PATH="${NODE_PATH:+$NODE_PATH:}$(npm root -g)"
        exec "$@" ;;
  down) down ;;
  *)    echo "usage: $0 up|restart|run <cmd>|env|down" >&2; exit 2 ;;
esac
