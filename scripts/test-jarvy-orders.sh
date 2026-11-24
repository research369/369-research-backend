#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${JARVY_TEST_SANITIZED:-}" != 1 ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 NODE_ENV=test \
    JARVY_TEST_SANITIZED=1 DOTENV_CONFIG_PATH=/dev/null DATABASE_URL='' RAILWAY_DB_URL='' \
    JWT_SECRET='synthetic-jarvy-test-only-not-production-0123456789' bash "$0"
fi
PG_BIN="$(pg_config --bindir)"
TEST_ROOT="$(mktemp -d /tmp/369-jarvy-orders.XXXXXX)"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
mkdir "$TEST_ROOT/socket"
cleanup() { "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U jarvy_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-k $TEST_ROOT/socket -h '' -p 55467" start >/dev/null
"$PG_BIN/createdb" -h "$TEST_ROOT/socket" -p 55467 -U jarvy_local jarvy_local
./node_modules/.bin/tsx scripts/export-ledger-test-schema.ts "$TEST_ROOT/schema.sql"
export JARVY_TEST_PG_SOCKET="$TEST_ROOT/socket" JARVY_TEST_SCHEMA="$TEST_ROOT/schema.sql" JARVY_ISOLATED_ORDER_REHEARSAL=true
./node_modules/.bin/tsx server/jarvyOrderRehearsal.ts
