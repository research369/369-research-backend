import assert from 'node:assert/strict';
import test, { before, after, beforeEach, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import pg from 'pg';
import { ENV } from './env.js';
import { getPool, closeDb } from './db.js';
import { previewCustomerOrderRecipient as preview, applyCustomerOrderRecipientCorrection as apply } from './orderRecipientCorrectionService.js';
import { ensureOrderRecipientCorrectionSchema, repairFinnPickupOrder } from './orderRecipientCorrectionSchema.js';

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

test('country or ZIP route change rejects instead of repricing; same postal route aliases allowed', async () => {
  for (const patch of [{ country: 'AT', zip: '10115' }, { country: 'DE', zip: '18528' }]) {
    await pool.query('UPDATE customers SET country=$1,zip=$2,street=$3,dhl_post_number=NULL WHERE id=44', [patch.country, patch.zip, 'New Road']);
    await unchangedReject(() => preview(orderId, actor));
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
