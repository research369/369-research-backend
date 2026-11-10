#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Reserved, UNIX-only local PostgreSQL fixture; never consult a productive URL.
base=/tmp/369-accounts-pg-20261106
bin=/usr/lib/postgresql/16/bin
if [[ ! -x "$bin/postgres" ]]; then
  echo "PostgreSQL 16 required for the real concurrency/rollback suite" >&2
  exit 1
fi
if [[ -e "$base/data/postmaster.pid" ]]; then
  echo "Reserved Accounts instance already running; stop your own instance first" >&2
  exit 1
fi
mkdir -p "$base/socket"
if [[ ! -e "$base/data/PG_VERSION" ]]; then
  "$bin/initdb" -D "$base/data" -U accounts_test --auth=trust > "$base/init.log"
fi
trap '"$bin/pg_ctl" -D "$base/data" -m fast stop >/dev/null' EXIT
"$bin/pg_ctl" -D "$base/data" -l "$base/server.log" \
  -o "-k $base/socket -p 56437 -c listen_addresses=''" start
export ACCOUNT_SECURITY_POSTGRES_TEST=1
export DATABASE_URL='' RAILWAY_DB_URL='' DOTENV_CONFIG_PATH=/dev/null
export RESEND_API_KEY='' RESEND_WEBHOOK_SECRET='' BUNQ_API_KEY='' FORGE_API_KEY=''
export DHL_API_KEY='' DHL_TRACKING_API_KEY='' DHL_BUSINESS_USERNAME='' DHL_BUSINESS_PASSWORD=''
export DHL_EKP='' DHL_BILLING_NUMBER='' DHL_BILLING_NUMBER_EU='' DHL_BILLING_NUMBER_CH='' DHL_BILLING_NUMBER_KLEINPAKET=''
export WAWI_INTERNAL_KEY='' ADMIN_PASSWORD='' JWT_SECRET='synthetic-account-tests'
./node_modules/.bin/tsx --test server/accountSecurity.test.ts
