#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Same throwaway actual Drizzle-schema fixture as test-priority-integrity.sh,
# separate reserved port so parallel parent tests never share a database.
export DATABASE_URL='' RAILWAY_DB_URL='' DOTENV_CONFIG_PATH=/dev/null
export RESEND_API_KEY='' RESEND_WEBHOOK_SECRET='' BUNQ_API_KEY='' DHL_API_KEY='' DHL_TRACKING_API_KEY='' FORGE_API_KEY=''
export DHL_BUSINESS_USERNAME='' DHL_BUSINESS_PASSWORD='' WAWI_INTERNAL_KEY='' ADMIN_PASSWORD='' JWT_SECRET='local-synthetic-permissions-only'
PG_BIN="$(pg_config --bindir)"
TEST_ROOT="$(mktemp -d /tmp/369-operations-permissions.XXXXXX)"
mkdir "$TEST_ROOT/socket"
cleanup() { "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U operations_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-k $TEST_ROOT/socket -h 127.0.0.1 -p 56440" start >/dev/null
./node_modules/.bin/tsx scripts/export-ledger-test-schema.ts "$TEST_ROOT/schema.sql"
"$PG_BIN/psql" -h "$TEST_ROOT/socket" -p 56440 -U operations_local -d postgres -v ON_ERROR_STOP=1 -f "$TEST_ROOT/schema.sql" >/dev/null
export OPERATIONS_TEST_PG_SOCKET="$TEST_ROOT/socket"
./node_modules/.bin/tsx --test server/operationsPermissionsCleanup.postgres.test.ts
