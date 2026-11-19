#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Re-exec with an allowlist rather than inheriting any external credential.
if [[ "${FAMILY_TEST_SANITIZED:-}" != "1" ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 \
    FAMILY_TEST_SANITIZED=1 DOTENV_CONFIG_PATH=/dev/null \
    DATABASE_URL='' RAILWAY_DB_URL='' JWT_SECRET='local-synthetic-family-only' \
    RESEND_API_KEY='' RESEND_WEBHOOK_SECRET='' BUNQ_API_KEY='' FORGE_API_KEY='' \
    DHL_API_KEY='' DHL_TRACKING_API_KEY='' DHL_BUSINESS_USERNAME='' DHL_BUSINESS_PASSWORD='' \
    WAWI_INTERNAL_KEY='' ADMIN_PASSWORD='' \
    bash "$0"
fi
PG_BIN="$(pg_config --bindir)"
TEST_ROOT="$(mktemp -d /tmp/369-product-family.XXXXXX)"
mkdir "$TEST_ROOT/socket"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT
# Reserved loopback port; refuse occupied ports rather than reuse any cluster.
"$PG_BIN/initdb" -D "$TEST_ROOT/data" -A trust -U family_local >/dev/null
"$PG_BIN/pg_ctl" -D "$TEST_ROOT/data" -l "$TEST_ROOT/postgres.log" \
  -o "-k $TEST_ROOT/socket -h 127.0.0.1 -p 55461" start >/dev/null
./node_modules/.bin/tsx scripts/export-ledger-test-schema.ts "$TEST_ROOT/schema.sql"
"$PG_BIN/psql" -h "$TEST_ROOT/socket" -p 55461 -U family_local -d postgres \
  -v ON_ERROR_STOP=1 -f "$TEST_ROOT/schema.sql" >/dev/null
export FAMILY_TEST_PG_SOCKET="$TEST_ROOT/socket"
./node_modules/.bin/tsx --test server/productFamily.postgres.test.ts
