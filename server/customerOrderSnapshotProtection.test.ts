import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('customer profile updates delegate complete active shipping copies; historical snapshots are not directly backfilled', () => {
  const source = fs.readFileSync(new URL('./customerRouter.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  update: adminProcedure');
  const update = source.slice(start, source.indexOf('  // Delete customer', start));
  assert.ok(update.includes('db.transaction(async (tx)'));
  assert.ok(update.includes('.limit(1).for("update")'));
  assert.ok(update.includes('.where(eq(customers.id, id)).returning()'));
  assert.ok(update.includes('syncCustomerShippingAddressesInTransaction(tx, updatedCustomer,'));
  assert.ok(update.indexOf('.returning()') < update.indexOf('syncCustomerShippingAddressesInTransaction('));
  assert.ok(update.includes('unversandte Aufträge ohne Label. Historische Adressen bleiben unverändert.'));
  assert.ok(update.includes('NULLIF(TRIM(${orders.phone})'));
  assert.ok(update.includes('NULLIF(TRIM(${orders.email})'));
  assert.ok(!update.includes('onlyIfMissing'));
  assert.ok(!update.includes('orderSyncFields'));
  const writes = [...update.matchAll(/(?:db|tx)\.update\(orders\)\.set\(\{\s*(\w+):/g)].map(x => x[1]);
  assert.deepEqual(writes.sort(), ['email', 'phone']);
});

test('manual order profile updates use address-bound optional field resolution, not truthy old address fallback', () => {
  const source = fs.readFileSync(new URL('./orderRouter.ts', import.meta.url), 'utf8');
  const start = source.indexOf('        } else if (isAuthenticatedWawiManualSale && !ctx.jarvyOrder');
  const end = source.indexOf('          customerIntegrityTrigger = manuallyChanged', start);
  assert.ok(start >= 0 && end > start, 'Manual profile branch must exist');
  const manual = source.slice(start, end);
  assert.ok(manual.includes('resolveAddressBoundOptionalFields(existingCustomer, input.customer)'));
  assert.ok(!manual.includes('input.customer.company || existingCustomer.company'));
  assert.ok(!manual.includes('input.customer.dhlPostNumber || existingCustomer.dhlPostNumber'));
});
