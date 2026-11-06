#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL='' RAILWAY_DB_URL='' DOTENV_CONFIG_PATH=/dev/null
export RESEND_API_KEY='' BUNQ_API_KEY='' DHL_API_KEY='' DHL_TRACKING_API_KEY='' FORGE_API_KEY=''
PG_BIN="$(pg_config --bindir)"
TEST_ROOT="$(mktemp -d /tmp/369-priority-integrity.XXXXXX)"
mkdir "$TEST_ROOT/socket"
cleanup() { "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
# Fixed port is reserved for this module. Start MUST fail if occupied; never reuse another cluster.
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U priority_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-k $TEST_ROOT/socket -h 127.0.0.1 -p 56439" start >/dev/null
./node_modules/.bin/drizzle-kit export --schema ./drizzle/schema.ts --dialect postgresql > "$TEST_ROOT/schema.sql"
"$PG_BIN/psql" -h "$TEST_ROOT/socket" -p 56439 -U priority_local -d postgres -v ON_ERROR_STOP=1 -f "$TEST_ROOT/schema.sql" >/dev/null
./node_modules/.bin/tsx --test server/priorityOrderIntegrity.test.ts
