#!/bin/sh
set -eu

./node_modules/.bin/tsx scripts/checkout-v2-commerce-staging-bootstrap.ts
./node_modules/.bin/tsx scripts/checkout-v2-commerce-staging-smoke.ts
