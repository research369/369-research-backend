import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeOrderPickupCustomer } from './orderPickupAddressContract.js';
const pickup = { street: 'Packstation', houseNumber: '172', zip: '18528', city: 'Bergen auf Rügen', country: 'Deutschland', deliveryType: 'home' as const, dhlPostNumber: '1116683275' };
test('complete legacy pickup input becomes canonical Packstation, not home', () => {
  assert.deepEqual(canonicalizeOrderPickupCustomer(pickup), { ...pickup, country: 'DE', deliveryType: 'packstation', company: undefined });
});
test('missing postnumber fails before a new order can be persisted', () => {
  assert.throws(() => canonicalizeOrderPickupCustomer({ ...pickup, dhlPostNumber: '' }), /DHL-Postnummer/);
});
test('Postfiliale uses canonical recipient fields and clears incompatible company', () => {
  const r=canonicalizeOrderPickupCustomer({ ...pickup, street:'Postfiliale 172',deliveryType:'postfiliale' as const,company:'Old Company' });
  assert.equal(r.street,'Postfiliale');assert.equal(r.deliveryType,'postfiliale');assert.equal(r.company,undefined);
});
test('invalid station number, country, postcode and conflicting pickup kind are rejected', () => {
  for (const patch of [{houseNumber:'0'},{houseNumber:'123456'},{country:'CH'},{zip:'1852'},{deliveryType:'postfiliale' as const}]) {
    assert.throws(() => canonicalizeOrderPickupCustomer({...pickup,...patch}));
  }
});
test('ordinary home order and all unrelated fields remain untouched', () => {
  const c={...pickup,street:'Normalstraße',houseNumber:'3',country:'Austria',zip:'1234',dhlPostNumber:undefined};
  assert.strictEqual(canonicalizeOrderPickupCustomer(c),c);
});
