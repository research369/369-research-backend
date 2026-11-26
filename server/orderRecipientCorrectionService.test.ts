import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { canonicalRecipientFromCustomer } from './orderRecipientCorrectionService.js';
if (process.env.RECIPIENT_CORRECTION_TEST_SANITIZED !== '1' || process.env.DATABASE_URL
  || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== '/dev/null') throw Error('SANITIZED_FIXTURE_REQUIRED');
const home = { name: '  Ada   von Test ', street: ' Teststraße ', house_number: ' 12a ', zip: '10115', city: ' Berlin ', country: 'Germany' };

test('complete home recipient: CRM name fallback, whitespace, nullable company, no stale Postnummer', () => {
  assert.deepEqual(canonicalRecipientFromCustomer({ ...home, company: ' ', dhl_post_number: '12345678' }), {
    firstName: 'Ada', lastName: 'von Test', company: null, street: 'Teststraße', houseNumber: '12a',
    zip: '10115', city: 'Berlin', country: 'DE', deliveryType: 'home', dhlPostNumber: null,
  });
  const explicit = canonicalRecipientFromCustomer({ ...home, first_name: 'Explicit', last_name: 'Recipient', company: 'Company' });
  assert.equal(explicit.firstName, 'Explicit'); assert.equal(explicit.lastName, 'Recipient'); assert.equal(explicit.company, 'Company');
});

test('supports Drizzle camelCase rows and individual first/last fallback', () => {
  // A SQL property, even explicitly missing, cannot silently be overridden by another shape.
  assert.throws(() => canonicalRecipientFromCustomer({ ...home, house_number: undefined, houseNumber: '99', firstName: 'Explicit' }));
});

test('genuine camelCase row canonicalizes without contact information', () => {
  const { house_number, ...rest } = home;
  const recipient = canonicalRecipientFromCustomer({ ...rest, houseNumber: '99', firstName: 'Explicit' });
  assert.equal(recipient.firstName, 'Explicit'); assert.equal(recipient.lastName, 'von Test'); assert.equal(recipient.houseNumber, '99');
  assert(!('phone' in recipient)); assert(!('email' in recipient));
});

for (const [deliveryType, label] of [['packstation', 'Packstation'], ['postfiliale', 'Postfiliale']] as const) {
  test(`${deliveryType} inferred from combined street: correct station number and personal Postnummer, no home company merge`, () => {
    const recipient = canonicalRecipientFromCustomer({ ...home, street: ` ${label.toLowerCase()} 172 `, house_number: '99',
      company: 'Stale home company', dhl_post_number: '1116683275', preferred_delivery_type: 'home', country: 'DEU' });
    assert.equal(recipient.deliveryType, deliveryType); assert.equal(recipient.street, label); assert.equal(recipient.houseNumber, '172');
    assert.equal(recipient.company, null); assert.equal(recipient.dhlPostNumber, '1116683275'); assert.equal(recipient.country, 'DE');
  });
}

test('invalid stations and incomplete home recipients fail closed', () => {
  const station = { ...home, street: 'Packstation', house_number: '172', dhl_post_number: '12345678' };
  for (const patch of [{ house_number: '0' }, { house_number: '00000' }, { house_number: '12a' }, { house_number: '123456' },
    { dhl_post_number: null }, { dhl_post_number: '12345' }, { dhl_post_number: '1234567890123' }, { dhl_post_number: '12x45678' },
    { zip: '1011' }, { country: 'AT' }, { street: 'Packstation x' }, { city: '' }, { name: 'Ada' }]) {
    assert.throws(() => canonicalRecipientFromCustomer({ ...station, ...patch }), error => (error as any).code === 'BAD_REQUEST', JSON.stringify(patch));
  }
  for (const patch of [{ street: '' }, { house_number: '' }, { name: '' }, { city: '' }, { country: '' }, { zip: '' }]) {
    assert.throws(() => canonicalRecipientFromCustomer({ ...home, ...patch }));
  }
});

test('service owns only recipient SQL; never imports schema, router or financial/communication services', () => {
  const source = readFileSync(new URL('./orderRecipientCorrectionService.ts', import.meta.url), 'utf8');
  const sql = source.match(/UPDATE orders SET([\s\S]*?)WHERE order_id=\$1/)!;
  assert(sql); const columns = [...sql[1].matchAll(/\b([a-z_]+)\s*=/g)].map(match => match[1]);
  assert.deepEqual(columns, ['first_name', 'last_name', 'company', 'street', 'house_number', 'zip', 'city', 'country', 'delivery_type', 'dhl_post_number', 'updated_at']);
  assert(!/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:customers|invoices|order_items|stock_history|partner_transactions|kwk_ledger|payments)\b/i.test(source));
  assert(!/from ['"].*(?:Schema|Router|stockMovement|payment|Communication|partnerCredit)/.test(source));
  assert(source.includes('REPEATABLE READ READ ONLY')); assert(source.includes('timingSafeEqual'));
});
