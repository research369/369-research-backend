import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { customers, orders, customerCommunications } from '../drizzle/schema.js';
import { syncCustomerShippingAddressesInTransaction } from './customerShippingAutoSyncService.js';

// Execute the actual update procedure without importing unrelated router routes,
// booting the server, using credentials, or reaching any database/provider.
const source = fs.readFileSync(new URL('./customerRouter.ts', import.meta.url), 'utf8');
const schemaStart = source.indexOf('const customerSchema = z.object(');
const schemaEnd = source.indexOf('\nexport const customerRouter', schemaStart);
const updateStart = source.indexOf('  update: adminProcedure');
const updateEnd = source.indexOf('  // Delete customer', updateStart);
assert.ok(schemaStart >= 0 && schemaEnd > schemaStart && updateStart >= 0 && updateEnd > updateStart);
const updateSource = source.slice(updateStart, updateEnd);
const procedureSource = updateSource.replace(/^\s*update:\s*/, '').replace(/,\s*$/, '');
const compiled = ts.transpileModule(`${source.slice(schemaStart, schemaEnd)}\nconst route = ${procedureSource};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const dialect = new PgDialect();
const actor = { id: 9, username: 'admin-test', name: 'Test Admin', role: 'admin' };
const baseCustomer = {
  id: 41, customerNumber: '10041', name: 'Old Recipient', firstName: 'Old', lastName: 'Recipient',
  company: 'Old Company', street: 'Old Street', houseNumber: '8', zip: '10115', city: 'Berlin', country: 'DE',
  preferredDeliveryType: 'home', dhlPostNumber: null, phone: 'old-phone', email: 'old@example.invalid',
  notes: null, tags: null, communicationLanguage: 'de', updatedAt: new Date('2020-01-01'),
};
function order(orderId: string, extra: Record<string, any> = {}) {
  return { order_id: orderId, customer_id: 41, status: 'offen', first_name: 'Legacy', last_name: 'Snapshot',
    company: 'Legacy Company', street: 'Legacy Street', house_number: '1', zip: '20095', city: 'Hamburg', country: 'DE',
    delivery_type: 'home', dhl_post_number: '11111111', phone: '', email: '', subtotal: '100', total: '105',
    payment_method: 'bank_transfer', paid_at: null, packed_at: null, shipped_at: null, delivered_at: null,
    cancelled_at: null, tracking_number: null, shipping_label_url: null, shipping_label_content: null, ...extra };
}
function harness(options: {
  realService?: boolean; failSync?: boolean; missingCustomer?: boolean; validationWarning?: boolean;
  customer?: Record<string, any>; orderRows?: Record<string, any>[]; syncResult?: { updatedOrderIds: string[]; skippedOrderIds: string[] };
} = {}) {
  let state = { customer: { ...baseCustomer, ...options.customer }, orderRows: options.orderRows ?? [],
    communications: [{ customerId: 41, recipientEmail: 'old@example.invalid', deliveryStatus: 'bounced', deliveryIssueResolvedAt: null as Date | null }],
    audits: [] as any[] };
  let inTransaction = false;
  const events: string[] = [];
  const calls: { customer: any; actor: any; tx: any }[] = [];
  const db = {
    async transaction(callback: (tx: any) => Promise<any>) {
      assert.equal(inTransaction, false);
      inTransaction = true;
      events.push('begin');
      const draft = structuredClone(state);
      const tx: any = {
        select: () => ({ from: (table: any) => ({ where: (where: any) => ({ limit: (limit: number) => ({
          for: async (lock: string) => {
            assert.equal(table, customers); assert.equal(limit, 1); assert.equal(lock, 'update');
            assert.deepEqual(dialect.sqlToQuery(where).params, [41]);
            events.push('customer-lock');
            return options.missingCustomer ? [] : [structuredClone(draft.customer)];
          },
        }) }) }) }),
        update: (table: any) => ({ set: (values: any) => ({ where: (where: any) => {
          const query = dialect.sqlToQuery(where);
          if (table === customers) {
            assert.deepEqual(query.params, [41]);
            return { returning: async () => {
              events.push('profile-returning'); Object.assign(draft.customer, values); return [draft.customer];
            } };
          }
          if (table === orders) {
            const key = Object.keys(values)[0];
            assert.ok(key === 'phone' || key === 'email');
            assert.match(query.sql, /NULLIF\(TRIM\(/);
            assert.deepEqual(query.params, [41]);
            events.push(`contact-${key}`);
            for (const row of draft.orderRows) if (row.customer_id === 41 && !String(row[key] ?? '').trim()) row[key] = values[key];
          } else {
            assert.equal(table, customerCommunications);
            events.push('communications-resolve');
            for (const row of draft.communications) if (row.customerId === 41 && row.recipientEmail === query.params[1]
              && ['delayed', 'bounced', 'failed', 'suppressed'].includes(row.deliveryStatus) && !row.deliveryIssueResolvedAt) Object.assign(row, values);
          }
          return Promise.resolve();
        } }) }),
        execute: async (statement: any) => {
          assert.ok(inTransaction);
          const query = dialect.sqlToQuery(statement);
          const text = query.sql;
          if (text.startsWith('SELECT * FROM orders')) {
            assert.match(text, /ORDER BY order_id FOR UPDATE$/);
            assert.deepEqual(query.params, [41]);
            events.push('order-locks');
            return { rows: draft.orderRows.filter(row => row.customer_id === 41 && ['offen', 'bezahlt', 'gepackt'].includes(row.status)) };
          }
          if (text.includes("to_regclass('dhl_label_generations')")) return { rows: [{ generations: false, label_operations: false, legacy_operations: false }] };
          if (text.startsWith('UPDATE orders SET first_name=')) {
            // Drizzle binds in textual occurrence order: the WHERE order ID
            // appears after all ten SET values, although the PG service uses $1.
            const orderId = query.params.at(-1);
            const values = query.params.slice(0, -1);
            const row = draft.orderRows.find(row => row.order_id === orderId)!;
            const keys = ['first_name', 'last_name', 'company', 'street', 'house_number', 'zip', 'city', 'country', 'delivery_type', 'dhl_post_number'];
            keys.forEach((key, index) => { row[key] = values[index]; });
            events.push(`shipping-${orderId}`);
            return { rows: [], rowCount: 1 };
          }
          if (text.startsWith('INSERT INTO order_recipient_corrections')) {
            draft.audits.push(query.params); return { rows: [], rowCount: 1 };
          }
          throw new Error(`Unexpected SQL in focused router test: ${text}`);
        },
      };
      try {
        const result = await callback(tx);
        state = draft; events.push('commit'); return result;
      } catch (error) { events.push('rollback'); throw error; }
      finally { inTransaction = false; }
    },
  };
  const dependencies: Record<string, any> = {
    z, eq, and, inArray, sql, customers, orders, customerCommunications,
    adminProcedure: { input: (schema: any) => ({ mutation: (handler: any) => ({ schema, handler }) }) },
    getDb: async () => db,
    validateGermanAddress: async () => { events.push('validate'); return options.validationWarning
      ? { applicable: true, status: 'warning', warnings: [{ message: 'Existing address warning' }] }
      : { applicable: false, status: 'not_applicable', warnings: [] }; },
    persistAddressValidation: async () => { assert.equal(inTransaction, false); events.push('validation-record'); },
    queueCustomerDuplicateReview: async (id: number, reason: string, context: string) => {
      assert.equal(inTransaction, false); assert.equal(id, 41); assert.equal(reason, 'customer_changed'); assert.equal(context, 'customer.update');
      events.push('duplicate-queue');
    },
    syncCustomerShippingAddressesInTransaction: async (tx: any, customer: any, by: any) => {
      assert.ok(inTransaction); assert.equal(events.at(-1), 'profile-returning');
      calls.push({ tx, customer: structuredClone(customer), actor: by }); events.push('sync');
      if (options.failSync) throw new Error('SYNC_FAILED');
      return options.realService ? syncCustomerShippingAddressesInTransaction(tx, customer, by)
        : options.syncResult ?? { updatedOrderIds: ['A', 'B'], skippedOrderIds: ['C'] };
    },
  };
  const route = new Function(...Object.keys(dependencies), `${compiled}\nreturn route;`)(...Object.values(dependencies));
  return { events, calls, get state() { return state; },
    update: (patch: Record<string, any>) => route.handler({ input: route.schema.parse({ id: 41, ...patch }), ctx: { user: actor } }) };
}

test('customer.update locks the customer, returns its full saved row, delegates in the same transaction, and returns compatible counts', async () => {
  const h = harness();
  assert.deepEqual(await h.update({ street: 'New Street', company: '' }), { success: true, shippingOrdersUpdated: 2, shippingOrdersSkipped: 1 });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].customer.street, 'New Street'); assert.equal(h.calls[0].customer.company, null);
  assert.equal(h.calls[0].customer.houseNumber, '8'); assert.equal(h.calls[0].customer.id, 41);
  assert.deepEqual(h.calls[0].actor, { id: actor.id, username: actor.username });
  assert.ok(h.events.indexOf('customer-lock') < h.events.indexOf('profile-returning'));
  assert.ok(h.events.indexOf('sync') < h.events.indexOf('commit'));
  assert.ok(h.events.indexOf('commit') < h.events.indexOf('duplicate-queue'));
});

for (const field of ['name', 'firstName', 'lastName', 'company', 'street', 'houseNumber', 'zip', 'city', 'country', 'dhlPostNumber', 'preferredDeliveryType', 'deliveryType']) {
  test(`submitted ${field} alone triggers automatic shipping sync`, async () => {
    const value = ['deliveryType', 'preferredDeliveryType'].includes(field) ? 'packstation' : field === 'name' ? 'New Name' : 'changed';
    const h = harness(); await h.update({ [field]: value }); assert.equal(h.calls.length, 1);
    if (['deliveryType', 'preferredDeliveryType'].includes(field)) assert.equal(h.calls[0].customer.preferredDeliveryType, 'packstation');
  });
}

for (const patch of [{ notes: 'note' }, { tags: '[]' }, { communicationLanguage: 'en' }, { phone: 'new-phone' }, { email: 'new@example.invalid' }, {}]) {
  test(`non-shipping update ${JSON.stringify(patch)} does not invoke shipping sync`, async () => {
    const h = harness();
    assert.deepEqual(await h.update(patch), { success: true, shippingOrdersUpdated: 0, shippingOrdersSkipped: 0 });
    assert.equal(h.calls.length, 0); assert.ok(h.events.includes('commit'));
  });
}

test('CRM full-form resave invokes shipping sync even when fields match the profile', async () => {
  const h = harness(); await h.update({ name: baseCustomer.name, firstName: baseCustomer.firstName, lastName: baseCustomer.lastName,
    company: baseCustomer.company, street: baseCustomer.street, houseNumber: baseCustomer.houseNumber,
    zip: baseCustomer.zip, city: baseCustomer.city, country: baseCustomer.country, dhlPostNumber: '' });
  assert.equal(h.calls.length, 1);
});

test('name-only save derives new explicit recipient names, while submitted explicit names retain precedence', async () => {
  const h = harness(); await h.update({ name: 'New Multi Word' });
  assert.equal(h.calls[0].customer.firstName, 'New'); assert.equal(h.calls[0].customer.lastName, 'Multi Word');
  const explicit = harness(); await explicit.update({ name: 'Display Name', firstName: 'Explicit', lastName: 'Recipient' });
  assert.equal(explicit.calls[0].customer.firstName, 'Explicit'); assert.equal(explicit.calls[0].customer.lastName, 'Recipient');
});

test('sync failure rolls back the profile and never runs post-commit duplicate/validation effects', async () => {
  const h = harness({ failSync: true, validationWarning: true });
  await assert.rejects(h.update({ street: 'New Street', addressValidationOverride: { confirmed: true } }), /SYNC_FAILED/);
  assert.equal(h.state.customer.street, 'Old Street');
  assert.ok(h.events.includes('rollback')); assert.ok(!h.events.includes('commit'));
  assert.ok(!h.events.includes('duplicate-queue')); assert.ok(!h.events.includes('validation-record'));
});

test('existing address-warning confirmation is preserved and its record is saved after commit', async () => {
  const rejected = harness({ validationWarning: true });
  await assert.rejects(rejected.update({ street: 'New Street' }), /ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH/);
  assert.equal(rejected.calls.length, 0); assert.equal(rejected.state.customer.street, 'Old Street');
  const confirmed = harness({ validationWarning: true });
  await confirmed.update({ street: 'New Street', addressValidationOverride: { confirmed: true } });
  assert.ok(confirmed.events.indexOf('commit') < confirmed.events.indexOf('validation-record'));
});

test('missing customer rejects before profile or shipping writes', async () => {
  const h = harness({ missingCustomer: true }); await assert.rejects(h.update({ street: 'New Street' }), /Kunde nicht gefunden/);
  assert.equal(h.calls.length, 0); assert.ok(!h.events.includes('profile-returning'));
});

test('contact missing-fill and prior email incident resolution are preserved without overwriting present contacts', async () => {
  const h = harness({ orderRows: [order('MISSING'), order('PRESENT', { phone: 'snapshot-phone', email: 'snapshot@example.invalid' }),
    order('OTHER', { customer_id: 99 })] });
  await h.update({ phone: 'new-phone', email: 'new@example.invalid' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.orderRows[0].phone, 'new-phone'); assert.equal(h.state.orderRows[0].email, 'new@example.invalid');
  assert.equal(h.state.orderRows[1].phone, 'snapshot-phone'); assert.equal(h.state.orderRows[1].email, 'snapshot@example.invalid');
  assert.equal(h.state.orderRows[2].phone, ''); assert.equal(h.state.orderRows[2].email, '');
  assert.ok(h.state.communications[0].deliveryIssueResolvedAt);
});

test('real sync integration replaces complete active shipping copies but does not autofill labelled or shipped snapshots', async () => {
  const rows = [order('OPEN'), order('PAID', { status: 'bezahlt' }), order('PACKED', { status: 'gepackt' }),
    order('LABELLED', { shipping_label_content: 'existing-label' }), order('SHIPPED', { status: 'gepackt', shipped_at: new Date('2020-01-03') }),
    order('CLOSED', { status: 'abgeschlossen' }), order('OTHER-CUSTOMER', { customer_id: 99 })];
  const before = structuredClone(rows);
  const h = harness({ realService: true, orderRows: rows });
  const result = await h.update({ name: 'New Recipient', company: '', street: 'New Street', houseNumber: '11', zip: '8000', city: 'Zürich', country: 'CH', dhlPostNumber: '' });
  assert.deepEqual(result, { success: true, shippingOrdersUpdated: 3, shippingOrdersSkipped: 2 });
  for (const row of h.state.orderRows.slice(0, 3)) {
    assert.equal(row.first_name, 'New'); assert.equal(row.last_name, 'Recipient'); assert.equal(row.company, null);
    assert.equal(row.street, 'New Street'); assert.equal(row.house_number, '11'); assert.equal(row.zip, '8000');
    assert.equal(row.city, 'Zürich'); assert.equal(row.country, 'CH'); assert.equal(row.delivery_type, 'home'); assert.equal(row.dhl_post_number, null);
    assert.equal(row.total, '105'); assert.equal(row.subtotal, '100'); assert.equal(row.status, before.find(old => old.order_id === row.order_id)!.status);
  }
  assert.deepEqual(h.state.orderRows.slice(3), before.slice(3));
  assert.equal(h.state.audits.length, 3);
  assert.ok(h.events.indexOf('customer-lock') < h.events.indexOf('order-locks'));
});

test('router adds neither preview tokens nor country/ZIP guards nor notification/financial calls', () => {
  assert.match(updateSource, /update:\s*adminProcedure/);
  assert.doesNotMatch(updateSource, /previewToken|previewCustomerOrderRecipient|applyCustomerOrderRecipientCorrection|countryRoute|postalRoute/);
  assert.doesNotMatch(updateSource, /sendEmail|RESEND_API_URL|fetch\(|invoice|refund|inventory|paymentService|getPool\(/i);
});
