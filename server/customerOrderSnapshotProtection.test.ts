import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('customer profile updates never backfill historical address/name/packstation fields', () => {
  const source = fs.readFileSync(new URL('./customerRouter.ts', import.meta.url), 'utf8');
  const update = source.slice(source.indexOf('  update: adminProcedure'), source.indexOf('      if (addressWarningNeedsConfirmation && addressValidation)', source.indexOf('  update: adminProcedure')));
  assert.ok(update.includes('NULLIF(TRIM(${orders.phone})'));
  assert.ok(update.includes('NULLIF(TRIM(${orders.email})'));
  assert.ok(!update.includes('onlyIfMissing'));
  assert.ok(!update.includes('orderSyncFields'));
  const writes = [...update.matchAll(/db\.update\(orders\)\.set\(\{\s*(\w+):/g)].map(x => x[1]);
  assert.deepEqual(writes.sort(), ['email', 'phone']);
});

test('manual order profile updates use address-bound optional field resolution, not truthy old address fallback', () => {
  const source = fs.readFileSync(new URL('./orderRouter.ts', import.meta.url), 'utf8');
  const manual = source.slice(source.indexOf('        } else if (isAuthenticatedWawiManualSale && !ctx.jarvyOrder)'), source.indexOf('          customerIntegrityTrigger = manuallyChanged'));
  assert.ok(manual.includes('resolveAddressBoundOptionalFields(existingCustomer, input.customer)'));
  assert.ok(!manual.includes('input.customer.company || existingCustomer.company'));
  assert.ok(!manual.includes('input.customer.dhlPostNumber || existingCustomer.dhlPostNumber'));
});
