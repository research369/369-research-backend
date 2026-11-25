#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# No real credentials, URLs, browser/API calls or existing database are used.
export DATABASE_URL='' RAILWAY_DB_URL='' DOTENV_CONFIG_PATH=/dev/null
export RESEND_API_KEY='' RESEND_WEBHOOK_SECRET='' BUNQ_API_KEY='' DHL_API_KEY='' DHL_TRACKING_API_KEY='' FORGE_API_KEY=''
export DHL_BUSINESS_USERNAME='' DHL_BUSINESS_PASSWORD='' WAWI_INTERNAL_KEY='' ADMIN_PASSWORD='' JWT_SECRET=''
export OPS_ISOLATED_REHEARSAL=false OPS_REHEARSAL_DB=''
PG_BIN="$(pg_config --bindir)"
TEST_ROOT="$(mktemp -d /tmp/369-campaign-permissions.XXXXXX)"
mkdir "$TEST_ROOT/socket"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT
# Reserved port: fail if occupied; never connect to/reuse another running cluster.
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U campaign_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-k $TEST_ROOT/socket -h 127.0.0.1 -p 55460" start >/dev/null
./node_modules/.bin/tsx scripts/export-ledger-test-schema.ts "$TEST_ROOT/schema.sql"
"$PG_BIN/psql" -h "$TEST_ROOT/socket" -p 55460 -U campaign_local -d postgres -v ON_ERROR_STOP=1 -f "$TEST_ROOT/schema.sql" >/dev/null
export CAMPAIGN_TEST_PG_SOCKET="$TEST_ROOT/socket"
# Own route tests deliberately have no OPS_ISOLATED_REHEARSAL skip gate.
./node_modules/.bin/tsx --experimental-test-module-mocks --test server/campaignAccountPermissions.postgres.test.ts
./node_modules/.bin/tsx --experimental-test-module-mocks --test server/globalAutomaticDiscountConfig.test.ts server/blackFridayCampaign.test.ts server/promotionPersistence.test.ts
