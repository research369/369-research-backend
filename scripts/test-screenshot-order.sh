#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${SCREENSHOT_TEST_SANITIZED:-}" != "1" ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 NODE_ENV=test \
    SCREENSHOT_TEST_SANITIZED=1 DOTENV_CONFIG_PATH=/dev/null DATABASE_URL='' RAILWAY_DB_URL='' \
    JWT_SECRET='synthetic-local-screenshot-jwt-key-64-characters-only-never-live' \
    RESEND_API_KEY='' BUNQ_API_KEY='' FORGE_API_KEY='' DHL_API_KEY='' DHL_TRACKING_API_KEY='' \
    WAWI_INTERNAL_KEY='' ADMIN_PASSWORD='' bash "$0"
fi
PG_BIN="$(pg_config --bindir)"
TEST_ROOT="$(mktemp -d /tmp/369-screenshot-order.XXXXXX)"
mkdir "$TEST_ROOT/socket"
cleanup() { "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U screenshot_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-k $TEST_ROOT/socket -h '' -p 55464" start >/dev/null
"$PG_BIN/createdb" -h "$TEST_ROOT/socket" -p 55464 -U screenshot_local screenshot_local
./node_modules/.bin/tsx scripts/export-ledger-test-schema.ts "$TEST_ROOT/schema.sql"
"$PG_BIN/psql" -h "$TEST_ROOT/socket" -p 55464 -U screenshot_local -d screenshot_local -v ON_ERROR_STOP=1 -f "$TEST_ROOT/schema.sql" >/dev/null
export SCREENSHOT_TEST_PG_SOCKET="$TEST_ROOT/socket"
./node_modules/.bin/tsx --test server/nasalSalesPolicy.test.ts
./node_modules/.bin/tsx --test server/screenshotOrderContract.test.ts server/screenshotOrderService.test.ts
