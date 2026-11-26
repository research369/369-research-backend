import assert from 'node:assert/strict';
import test, { before, after, beforeEach, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { customers } from '../drizzle/schema.js';
import { ENV } from './env.js';
import { getDb, getPool, closeDb } from './db.js';
import { previewCustomerOrderRecipient as preview, applyCustomerOrderRecipientCorrection as apply } from './orderRecipientCorrectionService.js';
import { ensureOrderRecipientCorrectionSchema, repairFinnPickupOrder } from './orderRecipientCorrectionSchema.js';
import { syncCustomerShippingWithClient, syncCustomerShippingAddressesInTransaction } from './customerShippingAutoSyncService.js';
import { repairFinnCurrentShippingAddress } from './finnCurrentShippingAddressRepair.js';

const socket = process.env.RECIPIENT_CORRECTION_TEST_PG_SOCKET;
if (!socket?.startsWith('/tmp/369-recipient-correction.') || !socket.endsWith('/socket')
  || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== '/dev/null'
  || process.env.RECIPIENT_CORRECTION_TEST_SANITIZED !== '1') throw Error('DEDICATED_UNIX_FIXTURE_REQUIRED');
const actor = { id: 7, username: 'fixture_admin' };
const orderId = 'ISOLATED-RECIPIENT';
let pool: pg.Pool, externalCalls = 0, watchPreview = false;
const previewQueries: string[] = [];
const isConflict = (error: unknown) => (error as any)?.code === 'CONFLICT';
const rows = async (table: string) => (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.row);
const order = async () => (await pool.query('SELECT * FROM orders WHERE order_id=$1', [orderId])).rows[0];
const audit = async () => rows('order_recipient_corrections');
const snapshot = async () => {
  const names = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of names) result[tablename] = await rows(tablename);
  return result;
};
const untouchedOrder = (row: any) => {
  const copy = { ...row };
  for (const key of ['first_name', 'last_name', 'company', 'street', 'house_number', 'zip', 'city', 'country', 'delivery_type', 'dhl_post_number', 'updated_at']) delete copy[key];
  return copy;
};
before(async () => {
  const fail = () => { externalCalls++; throw Error('NONFIXTURE_NETWORK_FORBIDDEN'); };
  mock.method(globalThis, 'fetch', fail as any);
  mock.method(http, 'request', fail as any); mock.method(http, 'get', fail as any);
  mock.method(https, 'request', fail as any); mock.method(https, 'get', fail as any);
  const connect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const first = args[0]; const options = Array.isArray(first) ? first[0] : first;
    const path = typeof options === 'string' ? options : options?.path;
    if (path !== `${socket}/.s.PGSQL.55467`) return fail();
    return (connect as any).apply(this, args);
  });
  const query = pg.Client.prototype.query;
  mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: any[]) {
    if (watchPreview) previewQueries.push(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '');
    return (query as any).apply(this, args);
  });
  await closeDb();
  ENV.databaseUrl = `postgresql://recipient_local@localhost:55467/postgres?host=${encodeURIComponent(socket!)}`;
  ENV.resendApiKey = ''; pool = (await getPool())!;
  await ensureOrderRecipientCorrectionSchema();
  await pool.query(readFileSync(new URL('../drizzle/migrations/0031_dhl_label_generations.sql', import.meta.url), 'utf8'));
  await pool.query('CREATE TABLE dhl_operations(id serial PRIMARY KEY,order_id varchar(50),state varchar(20))');
});
beforeEach(async () => {
  await pool.query(`TRUNCATE order_recipient_corrections,dhl_operations,dhl_label_operations,dhl_label_generations,
    customers,orders,order_items,articles,stock_history,invoices,partner_transactions,kwk_ledger,kwk_accounts RESTART IDENTITY CASCADE;
    INSERT INTO customers(id,name,first_name,last_name,phone,email,company,street,house_number,zip,city,country,dhl_post_number,preferred_delivery_type,updated_at)
      VALUES(44,'Ada von Test',NULL,NULL,'CUSTOMER_PHONE','customer@fixture.invalid','', 'Packstation 172','99','10115','Berlin','Germany','1116683275','home','2020-01-01');
    INSERT INTO orders(order_id,customer_id,first_name,last_name,email,phone,street,house_number,zip,city,country,company,delivery_type,dhl_post_number,
      subtotal,discount,shipping,shipping_country,total,payment_method,status,order_date,paid_at,bunq_payment_id,partner_discount,partner_commission,
      discount_breakdown,updated_at)
      VALUES('${orderId}',44,'Old','Recipient','old@fixture.invalid','ORDER_PHONE','Old Road','1','10115','Berlin','DE','Old Company','home','99999999',
        100,10,5,'DE',95,'SEPA','bezahlt','2020-01-01','2020-01-01','SYNTHETIC_PAYMENT',10,10,NULL,'2020-01-01');
  `);
  await pool.query(`INSERT INTO articles(id,sku,name,stock) VALUES(1,'FIXTURE-SKU','Fixture product',9);
    INSERT INTO order_items(order_id,name,type,price,quantity,article_id) VALUES('${orderId}','Fixture product','vial',100,1,1);
    INSERT INTO stock_history(article_id,change_type,quantity_before,quantity_change,quantity_after,order_id,user_name) VALUES(1,'verkauf',10,-1,9,'${orderId}','fixture');
    INSERT INTO invoices(invoice_number,order_number,date,date_iso,total_gross,html) VALUES('FIXTURE-INVOICE','${orderId}','01.01.2020','2020-01-01',95,'UNCHANGED_INVOICE');
    INSERT INTO partner_transactions(partner_id,type,amount,balance_after,order_id) VALUES(99,'provision',10,10,'${orderId}');
    INSERT INTO kwk_accounts(id,kwk_number,referral_code,name,email,phone,password_hash,credit_available) VALUES(1,'KWK-FIXTURE','KWK-FIXTURE','Fixture','kwk@fixture.invalid','FIXTURE','HASH',12.34);
    INSERT INTO kwk_ledger(kwk_id,order_id,amount,type,status) VALUES(1,'${orderId}',-2,'redeemed','confirmed');`);
});
after(async () => { assert.equal(externalCalls, 0); await closeDb(); ENV.databaseUrl = ''; mock.restoreAll(); });

async function addGeneration(state: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO dhl_label_generations(id,order_id,generation,state,recipient_snapshot,order_snapshot,reason,actor)
    VALUES($1,$2,1,$3,'{}','{}','fixture','fixture')`, [id, orderId, state]);
  return id;
}
async function unchangedReject(work: () => Promise<unknown>, check = isConflict) {
  const before = await snapshot();
  await assert.rejects(work, check);
  assert.deepEqual(await snapshot(), before);
}

test('preview is read-only, complete and needs no audit schema: no business row, DDL, receipt or audit writes', async () => {
  await pool.query('DROP TABLE order_recipient_corrections');
  const before = await snapshot();
  previewQueries.length = 0; watchPreview = true;
  let result;
  try { result = await preview(orderId, actor); } finally { watchPreview = false; }
  assert.equal(result.changed, true); assert.equal(result.after.deliveryType, 'packstation'); assert.equal(result.after.houseNumber, '172');
  assert.equal(result.after.dhlPostNumber, '1116683275'); assert.equal(result.after.company, null);
  assert.equal(result.before.dhlPostNumber, '99999999');
  assert.equal(result.before.company, 'Old Company'); assert.equal(typeof result.expiresAt, 'string');
  assert(Math.abs(new Date(result.expiresAt).getTime() - Date.now() - 600000) < 2000);
  assert(previewQueries.some(query => query.includes('REPEATABLE READ READ ONLY')));
  assert(!previewQueries.some(query => /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(query)));
  assert.deepEqual(await snapshot(), before);
  await ensureOrderRecipientCorrectionSchema();
});

test('apply replaces only full recipient, preserves 10/10 partner terms, money/invoice/payment/contact/stock and ledgers; valid-token replay survives later customer edits', async () => {
  const before = await snapshot(); const original = await order();
  const p = await preview(orderId, actor);
  assert.deepEqual(await apply(orderId, p.previewToken, actor), { success: true });
  const updated = await order();
  assert.deepEqual(untouchedOrder(updated), untouchedOrder(original));
  assert.equal(updated.partner_discount, '10.00'); assert.equal(updated.partner_commission, '10.00');
  assert.equal(updated.email, original.email); assert.equal(updated.phone, original.phone); assert.equal(updated.status, 'bezahlt');
  assert.equal(updated.first_name, 'Ada'); assert.equal(updated.last_name, 'von Test'); assert.equal(updated.street, 'Packstation');
  assert.equal(updated.house_number, '172'); assert.equal(updated.delivery_type, 'packstation'); assert.equal(updated.dhl_post_number, '1116683275');
  assert.equal(updated.company, null);
  const after = await snapshot();
  for (const name of Object.keys(before)) if (!['orders', 'order_recipient_corrections'].includes(name)) assert.deepEqual(after[name], before[name], name);
  const receipt = (await audit())[0];
  assert.equal(receipt.id, createHash('sha256').update(p.previewToken).digest('hex'));
  assert.equal(receipt.actor_id, actor.id); assert.equal(receipt.actor_name, actor.username);
  assert.deepEqual(receipt.before_snapshot, p.before); assert.deepEqual(receipt.after_snapshot, p.after);
  await pool.query("UPDATE customers SET street='Other Road',house_number='88',dhl_post_number=NULL,updated_at=NOW() WHERE id=44");
  const replayBefore = await snapshot();
  assert.deepEqual(await apply(orderId, p.previewToken, actor), { success: true, unchanged: true });
  assert.deepEqual(await snapshot(), replayBefore);
});

test('unchanged recipient records a receipt but does not touch order updated_at; repeated application is idempotent', async () => {
  const p = await preview(orderId, actor); await apply(orderId, p.previewToken, actor);
  const next = await preview(orderId, actor); assert.equal(next.changed, false);
  const before = await order(); assert.deepEqual(await apply(orderId, next.previewToken, actor), { success: true, unchanged: true });
  assert.deepEqual(await order(), before); assert.equal((await audit()).length, 2);
  const state = await snapshot(); await apply(orderId, next.previewToken, actor); assert.deepEqual(await snapshot(), state);
});

test('home correction clears old Postnummer and company, never copies customer phone/email', async () => {
  await pool.query("UPDATE customers SET street='New Road',house_number='9',dhl_post_number='1116683275',company='' WHERE id=44");
  const p = await preview(orderId, actor); assert.equal(p.after.deliveryType, 'home'); assert.equal(p.after.dhlPostNumber, null);
  const original = await order(); await apply(orderId, p.previewToken, actor);
  const updated = await order(); assert.equal(updated.dhl_post_number, null); assert.equal(updated.company, null);
  assert.equal(updated.phone, original.phone); assert.equal(updated.email, original.email);
});

test('stale full customer recipient rejects even when timestamp and canonical target remain unchanged', async () => {
  const p = await preview(orderId, actor);
  await pool.query("UPDATE customers SET street='packstation 172' WHERE id=44");
  await unchangedReject(() => apply(orderId, p.previewToken, actor));
});

test('customer row-version change and later invalid address fail with safe conflict', async () => {
  let p = await preview(orderId, actor);
  await pool.query("UPDATE customers SET notes='same-recipient-new-version' WHERE id=44");
  await unchangedReject(() => apply(orderId, p.previewToken, actor));
  p = await preview(orderId, actor);
  await pool.query("UPDATE customers SET dhl_post_number=NULL WHERE id=44");
  await unchangedReject(() => apply(orderId, p.previewToken, actor));
});

test('order row version and raw recipient changes invalidate preview, including same timestamp and same recipient update', async () => {
  let p = await preview(orderId, actor);
  await pool.query("UPDATE orders SET street='Changed' WHERE order_id=$1", [orderId]);
  await unchangedReject(() => apply(orderId, p.previewToken, actor));
  p = await preview(orderId, actor);
  await pool.query('UPDATE orders SET first_name=first_name WHERE order_id=$1', [orderId]);
  await unchangedReject(() => apply(orderId, p.previewToken, actor));
});

test('actor ID/name/order mismatch, tampered payload/signature and malformed token reject without writes', async () => {
  const p = await preview(orderId, actor);
  for (const [id, who, token] of [
    [orderId, { ...actor, id: 8 }, p.previewToken], [orderId, { ...actor, username: 'other_admin' }, p.previewToken],
    ['OTHER-ORDER', actor, p.previewToken], [orderId, actor, p.previewToken.slice(0, -5) + 'abcde'],
    [orderId, actor, 'x' + p.previewToken.slice(1)], [orderId, actor, p.previewToken + '.extra'], [orderId, actor, 'broken'],
  ] as const) await unchangedReject(() => apply(id, token, who));
});

test('strict domain/version/TTL/future-issued validation rejects even signed envelopes; exactly ten-minute expiry also blocks receipt replay', async () => {
  const p = await preview(orderId, actor);
  const envelope = JSON.parse(Buffer.from(p.previewToken.split('.')[0], 'base64url').toString());
  const sign = (value: any, domain = '369-order-customer-recipient-correction-v1') => {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return payload + '.' + createHmac('sha256', process.env.JWT_SECRET!).update(domain + '.' + payload).digest('base64url');
  };
  for (const value of [{ ...envelope, domain: 'another-feature' }, { ...envelope, version: 2 },
    { ...envelope, expiresAt: envelope.expiresAt + 1 }, { ...envelope, issuedAt: Date.now() + 1000000, expiresAt: Date.now() + 1600000 }]) {
    await unchangedReject(() => apply(orderId, sign(value), actor));
  }
  await unchangedReject(() => apply(orderId, sign(envelope, 'another-feature'), actor));
  await apply(orderId, p.previewToken, actor);
  const date = mock.method(Date, 'now', () => envelope.expiresAt);
  try { await unchangedReject(() => apply(orderId, p.previewToken, actor)); } finally { date.mock.restore(); }
});

test('JWT secret missing, weak, development fallback or unavailable fails closed before database use', async () => {
  const p = await preview(orderId, actor); const original = process.env.JWT_SECRET;
  try {
    for (const value of [undefined, 'short', 'dev-secret-change-me', 'a'.repeat(31)]) {
      if (value === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = value;
      await unchangedReject(() => preview(orderId, actor), error => (error as any).code === 'INTERNAL_SERVER_ERROR');
      await unchangedReject(() => apply(orderId, p.previewToken, actor), error => (error as any).code === 'INTERNAL_SERVER_ERROR');
    }
  } finally { process.env.JWT_SECRET = original; }
});

for (const status of ['versendet', 'zugestellt', 'storniert', 'abgeholt']) {
  test(`${status} orders reject preview and under-lock apply`, async () => {
    const p = await preview(orderId, actor); await pool.query('UPDATE orders SET status=$2 WHERE order_id=$1', [orderId, status]);
    await unchangedReject(() => preview(orderId, actor)); await unchangedReject(() => apply(orderId, p.previewToken, actor));
  });
}

test('all shipment/cancellation flags independently reject even if status is otherwise editable', async () => {
  for (const column of ['shipped_at', 'delivered_at', 'cancelled_at', 'tracking_number', 'tracking_carrier', 'shipping_label_url', 'shipping_label_content']) {
    const p = await preview(orderId, actor);
    await pool.query(`UPDATE orders SET ${column}=$2 WHERE order_id=$1`, [orderId, column.endsWith('_at') ? '2020-01-01' : 'SYNTHETIC']);
    await unchangedReject(() => preview(orderId, actor)); await unchangedReject(() => apply(orderId, p.previewToken, actor));
    await pool.query(`UPDATE orders SET ${column}=NULL WHERE order_id=$1`, [orderId]);
  }
});

test('any DHL generation except create_rejected blocks even when legacy header is clear', async () => {
  for (const state of ['active', 'cancel_pending', 'cancel_unknown', 'cancel_rejected', 'manifested', 'delivered', 'cancelled',
    'create_pending', 'create_unknown', 'documents_failed']) {
    const p = await preview(orderId, actor); await addGeneration(state);
    await unchangedReject(() => preview(orderId, actor)); await unchangedReject(() => apply(orderId, p.previewToken, actor));
    await pool.query('DELETE FROM dhl_label_generations');
  }
  await addGeneration('create_rejected'); const p = await preview(orderId, actor); await apply(orderId, p.previewToken, actor);
});

test('current and legacy pending/unknown DHL operations reject independently of rejected generation', async () => {
  const generation = await addGeneration('create_rejected');
  for (const state of ['pending', 'unknown']) {
    const p = await preview(orderId, actor);
    await pool.query(`INSERT INTO dhl_label_operations(id,order_id,generation_id,idempotency_key,request_hash,kind,state,actor,reason)
      VALUES($1,$2,$3,$4,$5,'create',$6,'fixture','fixture')`, [randomUUID(), orderId, generation, randomUUID(), 'a'.repeat(64), state]);
    await unchangedReject(() => preview(orderId, actor)); await unchangedReject(() => apply(orderId, p.previewToken, actor));
    await pool.query('DELETE FROM dhl_label_operations');
    await pool.query('INSERT INTO dhl_operations(order_id,state) VALUES($1,$2)', [orderId, state]);
    await unchangedReject(() => preview(orderId, actor)); await unchangedReject(() => apply(orderId, p.previewToken, actor));
    await pool.query('DELETE FROM dhl_operations');
  }
});

test('country and ZIP changes copy the CRM recipient without repricing or changing stored shipping country; aliases allowed', async () => {
  for (const patch of [{ country: 'AT', zip: '1010' }, { country: 'DE', zip: '18528' }]) {
    await pool.query('UPDATE customers SET country=$1,zip=$2,street=$3,dhl_post_number=NULL WHERE id=44', [patch.country, patch.zip, 'New Road']);
    const before = await snapshot(); const original = await order();
    const p = await preview(orderId, actor); await apply(orderId, p.previewToken, actor);
    const updated = await order();
    assert.equal(updated.country, patch.country); assert.equal(updated.zip, patch.zip);
    assert.deepEqual(untouchedOrder(updated), untouchedOrder(original));
    assert.equal(updated.shipping_country, 'DE'); assert.equal(updated.shipping, '5.00'); assert.equal(updated.total, '95.00');
    const after = await snapshot();
    for (const name of Object.keys(before)) if (!['orders', 'order_recipient_corrections'].includes(name)) assert.deepEqual(after[name], before[name], name);
  }
  await pool.query("UPDATE customers SET country='Deutschland',zip='10115' WHERE id=44");
  const p = await preview(orderId, actor); assert.equal(p.after.country, 'DE'); await apply(orderId, p.previewToken, actor);
});

test('label writer race: order row lock serializes correction, flags rechecked after writer commits', async () => {
  const p = await preview(orderId, actor); const writer = await pool.connect();
  try {
    await writer.query('BEGIN'); await writer.query('SELECT 1 FROM orders WHERE order_id=$1 FOR UPDATE', [orderId]);
    await writer.query("UPDATE orders SET shipping_label_content='RACING_LABEL',tracking_carrier='DHL' WHERE order_id=$1", [orderId]);
    const pending = apply(orderId, p.previewToken, actor).then(() => null, error => error);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked = !!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM orders WHERE order_id=$1 FOR UPDATE%'")).rows.length;
      if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    await writer.query('COMMIT'); assert.equal(blocked, true);
    assert(isConflict(await pending)); const current = await order();
    assert.equal(current.shipping_label_content, 'RACING_LABEL'); assert.equal(current.street, 'Old Road'); assert.equal((await audit()).length, 0);
  } finally { await writer.query('ROLLBACK'); writer.release(); }
});

test('parallel same-token correction has one audit, one recipient write and no ledger effects', async () => {
  const p = await preview(orderId, actor); const ledger = await rows('kwk_ledger'); const financial = untouchedOrder(await order());
  const results = await Promise.all([apply(orderId, p.previewToken, actor), apply(orderId, p.previewToken, actor)]);
  assert.equal(results.filter(result => result.unchanged).length, 1); assert.equal((await audit()).length, 1);
  assert.deepEqual(await rows('kwk_ledger'), ledger); assert.deepEqual(untouchedOrder(await order()), financial);
});

test('audit insert failure rolls back recipient correction completely', async () => {
  await pool.query(`CREATE FUNCTION fixture_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FIXTURE_AUDIT_FAILURE'; END $$;
    CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON order_recipient_corrections FOR EACH ROW EXECUTE FUNCTION fixture_reject_audit()`);
  try {
    const p = await preview(orderId, actor); const before = await snapshot();
    await assert.rejects(() => apply(orderId, p.previewToken, actor), /FIXTURE_AUDIT_FAILURE/);
    assert.deepEqual(await snapshot(), before);
  } finally { await pool.query('DROP TRIGGER fixture_reject_audit ON order_recipient_corrections; DROP FUNCTION fixture_reject_audit()'); }
});

test('targeted Finn repair adds only missing pickup type/Postnummer, preserving invoice, contacts and commercial fields; second run is inert', async () => {
  await pool.query(`UPDATE customers SET name='Finn-Ole Kummer',street='Packstation',house_number='172',zip='18528',city='Bergen auf Rügen',country='DE' WHERE id=44;
    UPDATE orders SET order_id='369-11384',first_name='Finn-Ole',last_name='Kummer',street='Packstation',house_number='172',zip='18528',city='Bergen auf Rügen',country='DE',delivery_type='home',dhl_post_number=NULL WHERE order_id='${orderId}'`);
  const before = await snapshot(); const original = (await rows('orders'))[0];
  await repairFinnPickupOrder(); const repaired = (await rows('orders'))[0];
  const omit = (row: any) => { const { delivery_type, dhl_post_number, updated_at, ...rest } = row; return rest; };
  assert.deepEqual(omit(repaired), omit(original)); assert.equal(repaired.delivery_type, 'packstation'); assert.equal(repaired.dhl_post_number, '1116683275');
  const after = await snapshot(); for (const name of Object.keys(before)) if (!['orders','order_recipient_corrections'].includes(name)) assert.deepEqual(after[name], before[name], name);
  assert.equal((await audit()).length, 1); await repairFinnPickupOrder(); assert.deepEqual(await snapshot(), after);
});

for (const status of ['offen', 'gepackt']) {
  test(`${status} with no shipment evidence accepts recipient-only correction`, async () => {
    await pool.query('UPDATE orders SET status=$2 WHERE order_id=$1', [orderId, status]);
    const original = await order(); const p = await preview(orderId, actor); await apply(orderId, p.previewToken, actor);
    assert.deepEqual(untouchedOrder(await order()), untouchedOrder(original)); assert.equal((await audit()).length, 1);
  });
}

test('a stored receipt never acknowledges another actor/order/customer even with otherwise valid signed token', async () => {
  const p = await preview(orderId, actor); await apply(orderId, p.previewToken, actor);
  for (const [column, value] of [['actor_id', 8], ['actor_name', 'other_admin'], ['order_id', 'OTHER-ORDER'], ['customer_id', 45]] as const) {
    await pool.query(`UPDATE order_recipient_corrections SET ${column}=$1`, [value]);
    await unchangedReject(() => apply(orderId, p.previewToken, actor));
    const original = column === 'actor_id' ? actor.id : column === 'actor_name' ? actor.username : column === 'order_id' ? orderId : 44;
    await pool.query(`UPDATE order_recipient_corrections SET ${column}=$1`, [original]);
  }
});

test('late DHL archive insert without any order-header change still blocks the correction', async () => {
  const p = await preview(orderId, actor);
  await addGeneration('create_unknown');
  await unchangedReject(() => apply(orderId, p.previewToken, actor));
});

// These helpers simulate the CRM save boundary: customer lock, complete UPDATE
// RETURNING row, and shipping synchronization on the exact same connection.
async function saveCustomerWithPg(patch: Record<string, unknown>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='10000ms'");
    await client.query('SELECT * FROM customers WHERE id=44 FOR UPDATE');
    const entries = Object.entries(patch);
    assert(entries.length > 0);
    assert(entries.every(([key]) => /^[a-z_]+$/.test(key) && !['id', 'updated_at'].includes(key)));
    const assignments = entries.map(([key], index) => `${key}=$${index + 1}`).join(',');
    const customer = (await client.query(`UPDATE customers SET ${assignments},updated_at=NOW() WHERE id=44 RETURNING *`, entries.map(([, value]) => value))).rows[0];
    const result = await syncCustomerShippingWithClient(client, customer, actor);
    await client.query('COMMIT');
    return { customer, result };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
async function cloneOrder(id: string, patch: Record<string, unknown> = {}) {
  await pool.query(`INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,
    to_jsonb(o)||$2::jsonb||jsonb_build_object('id',nextval(pg_get_serial_sequence('orders','id')),'order_id',$3::text))).*
    FROM orders o WHERE order_id=$1`, [orderId, JSON.stringify(patch), id]);
}
async function assertUnrelatedTablesUnchanged(before: Record<string, unknown>) {
  const after = await snapshot();
  for (const name of Object.keys(before)) if (!['customers', 'orders', 'order_recipient_corrections'].includes(name)) assert.deepEqual(after[name], before[name], name);
}
const homePatch = { name: 'Grace New Recipient', first_name: 'Grace', last_name: 'New Recipient',
  street: 'Entirely New Road', house_number: '23a', zip: '18528', city: 'Bergen auf Rügen', country: 'Deutschland',
  company: '', dhl_post_number: null, preferred_delivery_type: 'home' };

test('CRM save directly copies the full Packstation recipient only to exact linked editable orders and preserves all other columns/tables', async () => {
  await pool.query(`UPDATE orders SET discount_breakdown='[{"source":"partner","label":"fixture","amount":10}]',
    partner_source_id=99,partner_code='FIXTURE10',partner_number='PARTNER99',partner_program_snapshot='fixture-program',
    partner_settlement_method_snapshot='invoice',partner_commission_policy_snapshot='fixture-commission',
    partner_customer_discount_policy_snapshot='fixture-discount',partner_commission_percent_snapshot=10,
    partner_customer_discount_percent_snapshot=10,partner_commission_base_snapshot=90,credit_used=1,kwk_credit_used=2,
    kwk_credit_requested=2,kwk_credit_owner_id=1,communication_language='en',internal_note='DO NOT CHANGE',
    packing_photo_url='fixture://photo',weight_grams=500 WHERE order_id=$1`, [orderId]);
  await pool.query(`INSERT INTO customers SELECT (jsonb_populate_record(NULL::customers,
    to_jsonb(c)||'{"id":45,"customer_number":"OTHER-FIXTURE"}'::jsonb)).* FROM customers c WHERE id=44`);
  await cloneOrder('LINKED-OPEN', { status: 'offen' });
  await cloneOrder('LINKED-PACKED', { status: 'gepackt' });
  await cloneOrder('OTHER-CUSTOMER', { customer_id: 45, email: 'customer@fixture.invalid', phone: 'CUSTOMER_PHONE', first_name: 'Ada', last_name: 'von Test' });
  await cloneOrder('UNLINKED-MATCH', { customer_id: null, email: 'customer@fixture.invalid', phone: 'CUSTOMER_PHONE', first_name: 'Ada', last_name: 'von Test' });
  const before = await snapshot(); const originals = await rows('orders');
  const { result } = await saveCustomerWithPg({ name: 'Ada Updated Name', first_name: 'Ada', last_name: 'Updated Name',
    company: 'Must not leak into station', street: 'Packstation 321', house_number: 'OLD-HOME-99', zip: '18528',
    city: 'Bergen auf Rügen', country: 'Germany', dhl_post_number: '2226683275', preferred_delivery_type: 'home',
    phone: 'NEW_CRM_PHONE', email: 'new-customer@fixture.invalid' });
  assert.deepEqual(result, { updatedOrderIds: [orderId, 'LINKED-OPEN', 'LINKED-PACKED'], skippedOrderIds: [] });
  const updated = await rows('orders');
  for (const original of originals) {
    const current = updated.find(row => row.order_id === original.order_id)!;
    if (original.customer_id !== 44) { assert.deepEqual(current, original); continue; }
    assert.deepEqual(untouchedOrder(current), untouchedOrder(original));
    assert.deepEqual({ firstName: current.first_name, lastName: current.last_name, company: current.company,
      street: current.street, houseNumber: current.house_number, zip: current.zip, city: current.city,
      country: current.country, deliveryType: current.delivery_type, dhlPostNumber: current.dhl_post_number },
    { firstName: 'Ada', lastName: 'Updated Name', company: null, street: 'Packstation', houseNumber: '321',
      zip: '18528', city: 'Bergen auf Rügen', country: 'DE', deliveryType: 'packstation', dhlPostNumber: '2226683275' });
    const receipt = (await audit()).find(row => row.order_id === original.order_id)!;
    assert.equal(receipt.customer_id, 44); assert.equal(receipt.actor_id, actor.id); assert.equal(receipt.actor_name, actor.username);
    assert.equal(receipt.before_snapshot.houseNumber, '1'); assert.equal(receipt.after_snapshot.houseNumber, '321');
    assert.equal(receipt.after_snapshot.dhlPostNumber, '2226683275');
  }
  assert.equal((await audit()).length, 3);
  assert.deepEqual((await rows('customers')).find(row => row.id === 45), (before.customers as any[]).find(row => row.id === 45));
  await assertUnrelatedTablesUnchanged(before);
});

test('CRM home save clears obsolete company/Postnummer and replaces every recipient field without old/home-station mixing', async () => {
  await saveCustomerWithPg({ street: 'Packstation 172', house_number: '99', dhl_post_number: '1116683275' });
  const before = await snapshot(); const original = await order();
  const { result } = await saveCustomerWithPg({ ...homePatch, dhl_post_number: 'STALE_CRM_NUMBER' });
  assert.deepEqual(result.updatedOrderIds, [orderId]);
  const current = await order();
  assert.deepEqual(untouchedOrder(current), untouchedOrder(original));
  assert.equal(current.first_name, 'Grace'); assert.equal(current.last_name, 'New Recipient');
  assert.equal(current.street, 'Entirely New Road'); assert.equal(current.house_number, '23a');
  assert.equal(current.zip, '18528'); assert.equal(current.city, 'Bergen auf Rügen'); assert.equal(current.country, 'DE');
  assert.equal(current.company, null); assert.equal(current.delivery_type, 'home'); assert.equal(current.dhl_post_number, null);
  await assertUnrelatedTablesUnchanged(before);
});

test('CRM save accepts both ZIP and country moves while all commercial/payment/invoice/stock/ledger snapshots stay unchanged', async () => {
  for (const patch of [{ zip: '18528', city: 'Bergen auf Rügen', country: 'DE' }, { zip: '1010', city: 'Wien', country: 'AT' }]) {
    const before = await snapshot(); const original = await order();
    const { result } = await saveCustomerWithPg({ ...homePatch, ...patch });
    assert.deepEqual(result.updatedOrderIds, [orderId]);
    const current = await order();
    assert.equal(current.zip, patch.zip); assert.equal(current.country, patch.country); assert.equal(current.city, patch.city);
    assert.deepEqual(untouchedOrder(current), untouchedOrder(original));
    assert.equal(current.shipping_country, 'DE'); assert.equal(current.shipping, '5.00'); assert.equal(current.total, '95.00');
    assert.equal(current.partner_discount, '10.00'); assert.equal(current.partner_commission, '10.00');
    await assertUnrelatedTablesUnchanged(before);
  }
});

test('CRM profile commit leaves shipped/delivered/cancelled/pickup, tracking/label flags and every unsafe DHL archive order entirely unchanged', async () => {
  const protectedIds: string[] = [];
  for (const status of ['versendet', 'zugestellt', 'storniert', 'abgeholt']) {
    const id = `PROTECTED-${status}`; await cloneOrder(id, { status }); protectedIds.push(id);
  }
  for (const column of ['shipped_at', 'delivered_at', 'cancelled_at', 'tracking_number', 'tracking_carrier', 'shipping_label_url', 'shipping_label_content']) {
    const id = `FLAG-${column}`;
    await cloneOrder(id, { [column]: column.endsWith('_at') ? '2020-01-01' : 'SYNTHETIC_PROTECTED' }); protectedIds.push(id);
  }
  for (const state of ['active', 'cancel_pending', 'cancel_unknown', 'cancel_rejected', 'manifested', 'delivered', 'cancelled',
    'create_pending', 'create_unknown', 'documents_failed']) {
    const id = `ARCHIVE-${state}`; await cloneOrder(id); protectedIds.push(id);
    await pool.query(`INSERT INTO dhl_label_generations(id,order_id,generation,state,recipient_snapshot,order_snapshot,reason,actor)
      VALUES($1,$2,1,$3,'{}','{}','fixture','fixture')`, [randomUUID(), id, state]);
  }
  for (const state of ['pending', 'unknown']) {
    const legacyId = `LEGACY-${state}`; await cloneOrder(legacyId); protectedIds.push(legacyId);
    await pool.query('INSERT INTO dhl_operations(order_id,state) VALUES($1,$2)', [legacyId, state]);
    const id = `OPERATION-${state}`; await cloneOrder(id); protectedIds.push(id);
    const generation = randomUUID();
    await pool.query(`INSERT INTO dhl_label_generations(id,order_id,generation,state,recipient_snapshot,order_snapshot,reason,actor)
      VALUES($1,$2,1,'create_rejected','{}','{}','fixture','fixture')`, [generation, id]);
    await pool.query(`INSERT INTO dhl_label_operations(id,order_id,generation_id,idempotency_key,request_hash,kind,state,actor,reason)
      VALUES($1,$2,$3,$4,$5,'create',$6,'fixture','fixture')`, [randomUUID(), id, generation, randomUUID(), 'b'.repeat(64), state]);
  }
  const before = await snapshot(); const originals = await rows('orders');
  const { result } = await saveCustomerWithPg(homePatch);
  assert.deepEqual(result.updatedOrderIds, [orderId]);
  assert.equal((await pool.query('SELECT street FROM customers WHERE id=44')).rows[0].street, homePatch.street);
  const current = await rows('orders');
  for (const id of protectedIds) assert.deepEqual(current.find(row => row.order_id === id), originals.find(row => row.order_id === id), id);
  assert.equal((await audit()).length, 1);
  await assertUnrelatedTablesUnchanged(before);
});

test('CRM save can commit a profile-only change when every linked order is protected; rejected DHL creation remains editable', async () => {
  await pool.query('UPDATE orders SET status=$2 WHERE order_id=$1', [orderId, 'versendet']);
  const original = await order();
  const { result } = await saveCustomerWithPg({ ...homePatch, notes: 'PROFILE SAVE COMMITS' });
  assert.deepEqual(result, { updatedOrderIds: [], skippedOrderIds: [] });
  assert.deepEqual(await order(), original); assert.equal((await audit()).length, 0);
  assert.equal((await pool.query('SELECT notes FROM customers WHERE id=44')).rows[0].notes, 'PROFILE SAVE COMMITS');
  await pool.query('UPDATE orders SET status=$2 WHERE order_id=$1', [orderId, 'bezahlt']);
  await addGeneration('create_rejected');
  assert.deepEqual((await saveCustomerWithPg(homePatch)).result.updatedOrderIds, [orderId]);
});

test('CRM retry performs no extra order UPDATE, updated_at change or audit insert, even when customer save obtains a new row version', async () => {
  await saveCustomerWithPg(homePatch);
  const before = await snapshot(); const rowVersion = (await pool.query('SELECT xmin::text AS version FROM orders WHERE order_id=$1', [orderId])).rows[0].version;
  previewQueries.length = 0; watchPreview = true;
  let retry;
  try { retry = await saveCustomerWithPg(homePatch); } finally { watchPreview = false; }
  assert.deepEqual(retry.result, { updatedOrderIds: [], skippedOrderIds: [] });
  assert(!previewQueries.some(query => /\bUPDATE\s+orders\b/i.test(query)));
  assert(!previewQueries.some(query => /\bINSERT\s+INTO\s+order_recipient_corrections\b/i.test(query)));
  const after = await snapshot();
  assert.deepEqual(after.orders, before.orders); assert.deepEqual(after.order_recipient_corrections, before.order_recipient_corrections);
  assert.equal((await pool.query('SELECT xmin::text AS version FROM orders WHERE order_id=$1', [orderId])).rows[0].version, rowVersion);
  await assertUnrelatedTablesUnchanged(before);
});

test('CRM audit failure rolls back the updated customer and all linked order recipients atomically', async () => {
  await cloneOrder('ZZ-AUDIT-FAIL', { status: 'gepackt' });
  await pool.query(`CREATE FUNCTION fixture_reject_crm_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.order_id='ZZ-AUDIT-FAIL' THEN RAISE EXCEPTION 'FIXTURE_CRM_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fixture_reject_crm_audit BEFORE INSERT ON order_recipient_corrections FOR EACH ROW EXECUTE FUNCTION fixture_reject_crm_audit()`);
  try {
    const before = await snapshot();
    await assert.rejects(() => saveCustomerWithPg({ ...homePatch, notes: 'MUST ROLL BACK' }), /FIXTURE_CRM_AUDIT_FAILURE/);
    assert.deepEqual(await snapshot(), before);
  } finally { await pool.query('DROP TRIGGER fixture_reject_crm_audit ON order_recipient_corrections; DROP FUNCTION fixture_reject_crm_audit()'); }
});

test('real getDb Drizzle CRM transaction uses full camelCase UPDATE RETURNING row, parameterized adapter and shared rollback boundary', async () => {
  const db = (await getDb())!; const before = await snapshot(); const original = await order();
  const result = await db.transaction(async tx => {
    await tx.select().from(customers).where(eq(customers.id, 44)).for('update');
    const [customer] = await tx.update(customers).set({ name: 'Drizzle Full Recipient', firstName: 'Drizzle', lastName: 'Full Recipient',
      street: 'Packstation 876', houseNumber: 'OLD-HOUSE', zip: '18528', city: 'Bergen auf Rügen', country: 'DE',
      company: 'OLD-COMPANY', dhlPostNumber: '3336683275', updatedAt: sql`NOW()` }).where(eq(customers.id, 44)).returning();
    return syncCustomerShippingAddressesInTransaction(tx, customer, actor);
  });
  assert.deepEqual(result.updatedOrderIds, [orderId]);
  const current = await order();
  assert.equal(current.first_name, 'Drizzle'); assert.equal(current.last_name, 'Full Recipient');
  assert.equal(current.house_number, '876'); assert.equal(current.dhl_post_number, '3336683275'); assert.equal(current.company, null);
  assert.deepEqual(untouchedOrder(current), untouchedOrder(original));
  await assertUnrelatedTablesUnchanged(before);
  const committed = await snapshot();
  await assert.rejects(() => db.transaction(async tx => {
    await tx.select().from(customers).where(eq(customers.id, 44)).for('update');
    const [customer] = await tx.update(customers).set({ street: "O'Connor $7 Road", houseNumber: '8', company: "Researcher's Company",
      dhlPostNumber: null, updatedAt: sql`NOW()` }).where(eq(customers.id, 44)).returning();
    const rollbackResult = await syncCustomerShippingAddressesInTransaction(tx, customer, actor);
    assert.deepEqual(rollbackResult.updatedOrderIds, [orderId]);
    const uncommitted = await tx.execute(sql`SELECT street,company FROM orders WHERE order_id=${orderId}`);
    assert.equal(uncommitted.rows[0].street, "O'Connor $7 Road"); assert.equal(uncommitted.rows[0].company, "Researcher's Company");
    throw Error('FIXTURE_DRIZZLE_ROLLBACK');
  }), /FIXTURE_DRIZZLE_ROLLBACK/);
  assert.deepEqual(await snapshot(), committed);
});

test('CRM label-writer race serializes on the order lock, skips committed label and still commits customer profile', async () => {
  const writer = await pool.connect(); let pending: ReturnType<typeof saveCustomerWithPg> | undefined;
  try {
    await writer.query('BEGIN'); await writer.query('SELECT 1 FROM orders WHERE order_id=$1 FOR UPDATE', [orderId]);
    await writer.query("UPDATE orders SET shipping_label_content='CRM_RACING_LABEL',tracking_carrier='DHL' WHERE order_id=$1", [orderId]);
    pending = saveCustomerWithPg(homePatch);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked = !!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM orders WHERE customer_id=$1%FOR UPDATE%'")).rows.length;
      if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    await writer.query('COMMIT');
    const { result } = await pending;
    assert.equal(blocked, true); assert.deepEqual(result, { updatedOrderIds: [], skippedOrderIds: [orderId] });
    const current = await order();
    assert.equal(current.shipping_label_content, 'CRM_RACING_LABEL'); assert.equal(current.tracking_carrier, 'DHL');
    assert.equal(current.street, 'Old Road'); assert.equal((await audit()).length, 0);
    assert.equal((await pool.query('SELECT street FROM customers WHERE id=44')).rows[0].street, homePatch.street);
  } finally { await writer.query('ROLLBACK'); writer.release(); await pending?.catch(() => {}); }
});

async function setupCurrentFinnFixture() {
  await pool.query(`UPDATE customers SET name='Finn-Ole Kummer',first_name=NULL,last_name=NULL,company='OLD CRM COMPANY',
    street='Packstation 456',house_number='OLD HOME 99',zip='10115',city='Berlin',country='Germany',dhl_post_number='4446683275' WHERE id=44;
    UPDATE orders SET first_name='Finn-Ole',last_name='Kummer',street='Packstation',house_number='172',zip='18528',
      city='Bergen auf Rügen',country='DE',delivery_type='home',dhl_post_number=NULL WHERE order_id='${orderId}'`);
  await cloneOrder('FINN-OTHER-ORDER');
  await pool.query('UPDATE orders SET order_id=$2 WHERE order_id=$1', [orderId, '369-11384']);
}

test('current Finn repair copies the complete current CRM recipient despite a ZIP different from historical 18528; targets only Finn and preserves every commercial row', async () => {
  await setupCurrentFinnFixture();
  const before = await snapshot(); const originals = await rows('orders');
  await repairFinnCurrentShippingAddress();
  const current = await rows('orders'); const finn = current.find(row => row.order_id === '369-11384')!;
  assert.deepEqual(untouchedOrder(finn), untouchedOrder(originals.find(row => row.order_id === '369-11384')));
  assert.deepEqual(current.find(row => row.order_id === 'FINN-OTHER-ORDER'), originals.find(row => row.order_id === 'FINN-OTHER-ORDER'));
  assert.equal(finn.first_name, 'Finn-Ole'); assert.equal(finn.last_name, 'Kummer'); assert.equal(finn.company, null);
  assert.equal(finn.street, 'Packstation'); assert.equal(finn.house_number, '456'); assert.equal(finn.zip, '10115');
  assert.equal(finn.city, 'Berlin'); assert.equal(finn.country, 'DE'); assert.equal(finn.delivery_type, 'packstation');
  assert.equal(finn.dhl_post_number, '4446683275'); assert.equal(finn.shipping_country, 'DE'); assert.equal(finn.total, 95);
  assert.equal(finn.partner_discount, 10); assert.equal(finn.partner_commission, 10);
  const after = await snapshot();
  for (const name of Object.keys(before)) if (!['orders', 'order_recipient_corrections'].includes(name)) assert.deepEqual(after[name], before[name], name);
  assert((await audit()).every(row => row.order_id === '369-11384' && row.customer_id === 44));
});

test('current Finn repair one-time marker prevents any replay write or reset after the CRM profile subsequently changes', async () => {
  await setupCurrentFinnFixture();
  await repairFinnCurrentShippingAddress();
  const marker = createHash('sha256').update('owner:20261126:finn:369-11384:current-crm-shipping-v2').digest('hex');
  assert((await audit()).some(row => row.id === marker));
  await pool.query("UPDATE customers SET street='Later CRM Road',house_number='77',zip='1010',city='Wien',country='AT',dhl_post_number=NULL,updated_at=NOW() WHERE id=44");
  const before = await snapshot();
  await repairFinnCurrentShippingAddress();
  assert.deepEqual(await snapshot(), before);
  const finn = (await rows('orders')).find(row => row.order_id === '369-11384')!;
  assert.equal(finn.street, 'Packstation'); assert.equal(finn.house_number, '456'); assert.equal(finn.zip, '10115');
});

test('CRM blank-street pickup preserves the station number and Postnummer, defaulting to Packstation or honoring Postfiliale preference', async () => {
  for (const preferred of ['home', 'postfiliale']) {
    const original = await order();
    const { result } = await saveCustomerWithPg({ street: '', house_number: '543', zip: '10115', city: 'Berlin', country: 'DE',
      dhl_post_number: '5556683275', company: 'NO HOME MIX', preferred_delivery_type: preferred });
    assert.deepEqual(result.updatedOrderIds, [orderId]);
    const current = await order();
    assert.equal(current.delivery_type, preferred === 'postfiliale' ? 'postfiliale' : 'packstation');
    assert.equal(current.street, preferred === 'postfiliale' ? 'Postfiliale' : 'Packstation');
    assert.equal(current.house_number, '543'); assert.equal(current.dhl_post_number, '5556683275'); assert.equal(current.company, null);
    assert.deepEqual(untouchedOrder(current), untouchedOrder(original));
  }
});
