#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_ROOT="${PRECISION_TEST_PG_ROOT:-/home/ubuntu/369-commerce-integration-20261127/test-tools/root}"
PG_BIN="$PG_ROOT/usr/lib/postgresql/16/bin"
PG_SHARE="$PG_ROOT/usr/share/postgresql/16"
if [[ "${PRECISION_TEST_ISOLATED:-}" != 'true' ]]; then
  exec env -i HOME="$HOME" PATH="/home/ubuntu/.nvm/versions/node/v22.23.4/bin:/usr/bin:/bin" \
    PRECISION_TEST_ISOLATED=true PRECISION_TEST_PG_ROOT="$PG_ROOT" unshare -U --map-current-user --keep-caps -n bash -c 'ip link set lo up; exec bash "$@"' bash "$0" "$@"
fi
export LD_LIBRARY_PATH="$PG_ROOT/usr/lib/$(uname -m)-linux-gnu"
export DATABASE_URL='' RAILWAY_DB_URL='' DOTENV_CONFIG_PATH=/dev/null
export RESEND_API_KEY='' BUNQ_API_KEY='' DHL_API_KEY='' DHL_TRACKING_API_KEY='' FORGE_API_KEY=''
if [[ "${1:-}" == '--ui' ]]; then
  export PRECISION_TEST_UI_SCRIPT="$PWD/scripts/precision-checkout-browser.py"
  shift
fi
TEST_ROOT="$(mktemp -d /tmp/369-precision-integrity.XXXXXX)"
mkdir "$TEST_ROOT/socket"
cleanup() { "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
"$PG_BIN/initdb" -L "$PG_SHARE" -D "$TEST_ROOT/data" -A trust -U priority_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-k $TEST_ROOT/socket -h 127.0.0.1 -p 56439" start >/dev/null
./node_modules/.bin/tsx scripts/export-ledger-test-schema.ts "$TEST_ROOT/schema.sql"
DB=postgres
if [[ "$*" == *precisionCommerce.postgres.test.ts* ]]; then
  DB=precision_synthetic_test
  "$PG_BIN/createdb" -h "$TEST_ROOT/socket" -p 56439 -U priority_local "$DB"
  export PRECISION_SYNTHETIC_POSTGRES_TESTS=true PRECISION_TEST_DATABASE_URL=postgresql://priority_local@127.0.0.1:56439/precision_synthetic_test
fi
"$PG_BIN/psql" -h "$TEST_ROOT/socket" -p 56439 -U priority_local -d "$DB" -v ON_ERROR_STOP=1 -f "$TEST_ROOT/schema.sql" >/dev/null
printf '[Isolated] Fresh PostgreSQL, synthetic schema, loopback-only network.\n'
if [[ "$#" -eq 0 ]]; then set -- server/priorityOrderIntegrity.test.ts; fi
./node_modules/.bin/tsx --test "$@"
