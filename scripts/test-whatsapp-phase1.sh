#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${WOP_TEST_SANITIZED:-}" != 1 ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 NODE_ENV=test \
    WOP_TEST_SANITIZED=1 DOTENV_CONFIG_PATH=/dev/null DATABASE_URL='' RAILWAY_DB_URL='' \
    JWT_SECRET='synthetic-whatsapp-tests-no-production-0123456789' bash "$0"
fi
PG_BIN="$(pg_config --bindir)"
TEST_ROOT="$(mktemp -d /tmp/369-whatsapp-phase1.XXXXXX)"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
mkdir "$TEST_ROOT/socket"
cleanup() { "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TEST_ROOT"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U whatsapp_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" -o "-k $TEST_ROOT/socket -h '' -p 55468" start >/dev/null
"$PG_BIN/createdb" -h "$TEST_ROOT/socket" -p 55468 -U whatsapp_local whatsapp_phase1_test_rehearsal
export DATABASE_URL="postgresql:///whatsapp_phase1_test_native?host=$TEST_ROOT/socket&port=55468&user=whatsapp_local"
export WOP_TEST_DB_HOST="$TEST_ROOT/socket" WOP_TEST_DB_PORT=55468 WOP_TEST_DB_USER=whatsapp_local
./node_modules/.bin/tsx --test server/whatsappOrderPhase1.integration.ts server/whatsappWawiAdapter.integration.ts server/pepgptOffers.test.ts server/botPromoPolicy.test.ts server/kwkCheckoutPricing.test.ts server/jarvyOrderContract.test.ts server/orderConfirmationPolicy.test.ts server/orderItemIdentity.test.ts
