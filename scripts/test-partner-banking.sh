#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${PARTNER_BANKING_TEST_SANITIZED:-}" != "1" ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 NODE_ENV=test \
    PARTNER_BANKING_TEST_SANITIZED=1 DOTENV_CONFIG_PATH=/dev/null DATABASE_URL='' RAILWAY_DB_URL='' \
    JWT_SECRET='synthetic-local-banking-jwt-only-never-live' \
    RESEND_API_KEY='' RESEND_WEBHOOK_SECRET='' BUNQ_API_KEY='' FORGE_API_KEY='' DHL_API_KEY='' DHL_TRACKING_API_KEY='' \
    WAWI_INTERNAL_KEY='' ADMIN_PASSWORD='' bash "$0"
fi
PG_BIN="$(pg_config --bindir)"
TEST_ROOT="$(mktemp -d /tmp/369-partner-banking.XXXXXX)"
mkdir "$TEST_ROOT/socket"
cleanup() { "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U banking_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-k $TEST_ROOT/socket -h '' -p 55466" start >/dev/null
./node_modules/.bin/tsx scripts/export-ledger-test-schema.ts "$TEST_ROOT/schema.sql"
"$PG_BIN/psql" -h "$TEST_ROOT/socket" -p 55466 -U banking_local -d postgres -v ON_ERROR_STOP=1 -f "$TEST_ROOT/schema.sql" >/dev/null
export PARTNER_BANKING_TEST_PG_SOCKET="$TEST_ROOT/socket"
echo 'Partner banking pure validators/crypto + unchanged financial regressions'
./node_modules/.bin/tsx --test server/partnerBankingContract.test.ts server/partnerCreditService.test.ts server/partnerProgramService.test.ts server/partnerSettlementReport.test.ts server/partnerCommissionPreview.test.ts
echo 'Partner banking isolated PostgreSQL/router/security suite (Unix socket only, port 55466)'
./node_modules/.bin/tsx --test server/partnerBanking.postgres.test.ts
