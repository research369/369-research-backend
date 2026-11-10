import assert from 'node:assert/strict';
import test, { before, after, beforeEach, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ENV } from './env.js';
import { getDb, getPool, closeDb } from './db.js';
import { orderRouter } from './orderRouter.js';
import { partnerRouter } from './partnerRouter.js';
import { router } from './trpc.js';
import { ensurePermissionsSchema, isPermissionsSchemaReady } from './permissionsSchema.js';
import { ensureGoodieSchema } from './goodieSchema.js';
import { ensureAdminChangeLogSchema } from './adminChangeLogService.js';
import { ensurePriorityOrderIntegritySchema } from './priorityOrderIntegrity.js';
import { ensureCustomerOrderBlockSchema } from './customerOrderBlockService.js';
import { ensureAccountSecuritySchema } from './accountSecuritySchema.js';
import { ensurePartnerFinancialSchema } from './partnerFinancialSchema.js';
import { ensureCustomerPromoAssignmentSchema } from './customerPromoAssignmentService.js';
import { ensureOrderCommunicationPhoneSchema } from './orderCommunicationPhoneService.js';
import { ensureCustomerDataChangeSchema } from './customerDataChangeService.js';
import { ensureDhlRelabelSchema } from './dhlRelabelSchema.js';
import { assertOrderFinanciallyEditable, lockOrder } from './orderStockReturnService.js';
import { orders, orderItems } from '../drizzle/schema.js';
import { createPartnerToken } from './partnerAuth.js';

const socket = process.env.OPERATIONS_TEST_PG_SOCKET;
if (!socket?.startsWith('/tmp/369-operations-permissions.') || !socket.endsWith('/socket') || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== '/dev/null') throw Error('DEDICATED_LOCAL_FIXTURE_REQUIRED');
let pool: any, db: any, external = 0;
const user = { id: 2, username: 'product_manager', role: 'product_manager', name: null, email: null };
const ctx = (principal: any = user) => ({ req: { headers: {} }, res: {}, user: principal }) as any;
const app = router({ order: orderRouter, partner: partnerRouter });
const caller = (principal: any = user) => app.createCaller(ctx(principal));
const forbidden = (e: any) => ['FORBIDDEN', 'UNAUTHORIZED'].includes(e.code);
const correction = () => ({ partnerId: 9001, amount: 1, expectedBalance: 12.06, description: 'Synthetic correction only', requestId: randomUUID() });
const stock = async () => Number((await pool.query('SELECT stock FROM articles WHERE id=9001')).rows[0].stock);
const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
async function seedOrder(id: string, extra: any = {}, sale = true) {
  await db.insert(orders).values({ orderId: id, firstName: 'Synthetic', lastName: 'Owner', email: 'synthetic@fixture.invalid', phone: '', street: 'Local', houseNumber: '1', zip: '8000', city: 'Local', country: 'CH', subtotal: '20', discount: '0', shipping: '18', shippingCountry: 'ch', total: '38', paymentMethod: 'SEPA', status: 'offen', orderDate: new Date(), ...extra });
  await db.insert(orderItems).values({ orderId: id, name: 'Original requested variant', type: 'peptide', price: '20', quantity: 1 });
  if (sale) {
    const old = await stock();
    await pool.query('UPDATE articles SET stock=stock-1 WHERE id=9001');
    await pool.query("INSERT INTO stock_history(article_id,change_type,quantity_before,quantity_change,quantity_after,order_id) VALUES(9001,'verkauf',$1,-1,$2,$3)", [old, old - 1, id]);
  }
}

before(async () => {
  mock.method(globalThis, 'fetch', async () => { external++; throw Error('NETWORK_FORBIDDEN'); });
  await closeDb();
  ENV.databaseUrl = `postgresql://operations_local@localhost:56440/postgres?host=${encodeURIComponent(socket!)}`;
  ENV.resendApiKey = ''; ENV.bunqApiKey = ''; ENV.dhlApiKey = ''; ENV.dhlTrackingApiKey = ''; ENV.forgeApiKey = '';
  pool = await getPool(); db = await getDb();
  await pool.query("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'product_manager'");
  await pool.query("INSERT INTO users(id,username,password_hash,role) VALUES(2,'product_manager','unused','product_manager')");
  assert.equal(isPermissionsSchemaReady(), false);
  await assert.rejects(caller().order.list(), forbidden);
  await ensurePermissionsSchema(); await ensurePermissionsSchema();
  await ensureGoodieSchema(); await ensureAdminChangeLogSchema(); await ensurePriorityOrderIntegritySchema();
  await ensureCustomerOrderBlockSchema(); await ensureAccountSecuritySchema(); await ensurePartnerFinancialSchema();
  await ensureCustomerPromoAssignmentSchema(); await ensureOrderCommunicationPhoneSchema(); await ensureCustomerDataChangeSchema(); await ensureDhlRelabelSchema();
  await pool.query("CREATE TABLE IF NOT EXISTS substitution_config(id integer primary key,enabled boolean); INSERT INTO substitution_config VALUES(1,false) ON CONFLICT DO NOTHING; CREATE SEQUENCE local_order_seq; CREATE FUNCTION next_order_id() RETURNS text LANGUAGE SQL AS $$ SELECT 'LOCAL-' || nextval('local_order_seq') $$");
});
beforeEach(async () => {
  external = 0;
  await pool.query(`DROP TRIGGER IF EXISTS local_cleanup_fail ON orders;
    TRUNCATE customer_promo_assignments,order_communication_phone_override_events,customer_data_change_confirmations,customer_data_change_events,goodie_assignments,priority_stock_returns,priority_order_actions,priority_order_tasks,priority_checkout_receipts,dhl_label_operations,dhl_label_generations,stock_history,order_items,orders,customers,articles,partner_historical_claims,partner_transactions,partners,partner_programs,kwk_ledger,kwk_referrals,kwk_accounts,invoices,shop_settings,admin_change_events CASCADE;
    UPDATE users SET username='product_manager',role='product_manager' WHERE id=2;
    UPDATE operations_account_capability_grants SET revoked_at=NULL;
    INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,sale_price,variants)
    VALUES(9001,'SYNTHETIC-10MG','Synthetic (10 mg)','synthetic',10,1,1,'Peptide',20,0,'[]'),
    (9003,'BAC-3ML','BAC Wasser 3ml','bac-wasser-3ml',100,1,1,'Zubehör',4.16,0,'[]');
    INSERT INTO customers(id,customer_number,name,first_name,last_name,email,phone,street,house_number,zip,city,country)
    VALUES(9001,'999001','Synthetic Owner','Synthetic','Owner','synthetic@fixture.invalid','+41790000000','Local','1','8000','Local','CH');
    INSERT INTO partner_programs(key,label,customer_discount_policy,commission_policy,settlement_method,allow_self_order_credit,active)
    VALUES('partner','Partner','first_paid_code_use','first_paid_code_order','shop_credit',true,true);
    INSERT INTO partners(id,name,email,code,partner_number,credit_balance,program_key,commission_percent,customer_discount_percent,password_hash)
    VALUES(9001,'Synthetic','synthetic@fixture.invalid','SYNTHETIC','OWN-9001',12.06,'partner',10,10,'NEVER_EXPOSE');
    INSERT INTO kwk_accounts(id,kwk_number,referral_code,name,email,phone,password_hash) VALUES(9001,'KWK-9001','KWK-9001','Synthetic','kwk@fixture.invalid','1','unused');
    INSERT INTO shop_settings(key,value) VALUES('address_validation_enabled','false');`);
});
after(async () => { assert.equal(external, 0); await closeDb(); ENV.databaseUrl = ''; mock.restoreAll(); });

test('mandatory schema grants exactly account 2; audit reason retained; migration replay never unrevokes', async () => {
  const grants = (await pool.query('SELECT * FROM operations_account_capability_grants ORDER BY capability')).rows;
  assert.equal(grants.length, 3);
  assert(grants.every((g: any) => g.user_id === 2 && g.username === 'product_manager' && g.required_role === 'product_manager' && /2026-11-09 Userauthorize.*Pakko/.test(g.grant_reason)));
  await pool.query("UPDATE operations_account_capability_grants SET revoked_at=NOW() WHERE capability='order_cleanup'");
  await ensurePermissionsSchema();
  assert((await pool.query("SELECT revoked_at FROM operations_account_capability_grants WHERE capability='order_cleanup'")).rows[0].revoked_at);
  await assert.rejects(caller().order.delete({ orderId: 'MISSING' }), forbidden);
  assert.deepEqual(await caller().order.list(), []);
});
test('missing grant, wrong migration identity and DB/schema failure never become permissions; admin stays unchanged', async () => {
  await pool.query("DELETE FROM operations_account_capability_grants WHERE capability='operations_read'");
  await assert.rejects(caller().order.list(), forbidden);
  await pool.query("UPDATE users SET username='renamed' WHERE id=2");
  await ensurePermissionsSchema();
  assert.equal((await pool.query("SELECT count(*)::int n FROM operations_account_capability_grants WHERE capability='operations_read'")).rows[0].n, 0);
  await pool.query("UPDATE users SET username='product_manager',role='user' WHERE id=2");
  await ensurePermissionsSchema();
  assert.equal((await pool.query("SELECT count(*)::int n FROM operations_account_capability_grants WHERE capability='operations_read'")).rows[0].n, 0);
  await pool.query("UPDATE users SET role='product_manager' WHERE id=2");
  await ensurePermissionsSchema();
  const intercept = mock.method(pool, 'query', async () => { throw Error('LOCAL_DB_FAILURE'); });
  try {
    await assert.rejects(caller().order.list(), forbidden);
    await assert.rejects(ensurePermissionsSchema(), /LOCAL_DB_FAILURE/);
    assert.equal(isPermissionsSchemaReady(), false);
  } finally { intercept.mock.restore(); }
  await assert.rejects(caller().order.list(), forbidden);
  assert.deepEqual(await caller({ ...user, role: 'admin' }).order.list(), []);
  await ensurePermissionsSchema();
  assert.deepEqual(await caller().order.list(), []);
});
test('actual routers: wrong id/username/role, other PM, packing/user and no auth denied on all scoped endpoints', async () => {
  await seedOrder('DENIED');
  for (const principal of [null, { ...user, id: 3 }, { ...user, username: 'another_pm' }, { ...user, id: 3, username: 'another_pm' }, { ...user, role: 'user' }, { ...user, role: 'packing' }]) {
    const c = caller(principal);
    for (const work of [() => c.order.list(), () => c.order.get({ orderId: 'DENIED' }), () => c.order.delete({ orderId: 'DENIED' }), () => c.order.deleteNoRestock({ orderId: 'DENIED' }), () => c.order.cancel({ orderId: 'DENIED', restock: true, reason: 'Synthetic reason' }), () => c.partner.operationsAccount({ partnerId: 9001 }), () => c.partner.operationsAdjustCredit(correction())]) await assert.rejects(work(), forbidden);
  }
  assert.equal(await count('orders'), 1); assert.equal(await stock(), 9); assert.equal(await count('admin_change_events'), 0);
});
test('actual DB identity mismatch and each capability revocation fail closed immediately; no grant cache', async () => {
  await seedOrder('IDENTITY');
  await pool.query("UPDATE users SET username='renamed' WHERE id=2");
  await assert.rejects(caller().order.get({ orderId: 'IDENTITY' }), forbidden);
  await pool.query("UPDATE users SET username='product_manager',role='user' WHERE id=2");
  await assert.rejects(caller().order.list(), forbidden);
  await pool.query("UPDATE users SET role='product_manager' WHERE id=2");
  for (const [capability, operation] of [
    ['operations_read', () => caller().order.list()],
    ['partner_credit_adjust', () => caller().partner.operationsAdjustCredit(correction())],
    ['order_cleanup', () => caller().order.cancel({ orderId: 'IDENTITY', restock: false, reason: 'Synthetic reason' })],
  ] as const) {
    await pool.query('UPDATE operations_account_capability_grants SET revoked_at=NOW() WHERE capability=$1', [capability]);
    await assert.rejects(operation(), forbidden);
    await pool.query('UPDATE operations_account_capability_grants SET revoked_at=NULL WHERE capability=$1', [capability]);
  }
  assert.equal((await caller().order.get({ orderId: 'IDENTITY' })).orderId, 'IDENTITY');
});
test('actual granted PM never acquires update/status/payment/password or legacy partner admin permissions', async () => {
  const c = caller();
  for (const operation of [
    () => c.order.update({ orderId: 'MISSING', items: [], subtotal: 0, discount: 0, shipping: 0, total: 0 }),
    () => c.order.updateStatus({ orderId: 'MISSING', status: 'bezahlt' }),
    () => c.order.matchBunqPayments(),
    () => c.order.bunqPayments(),
    () => c.order.assignBunqPayment({ orderId: 'MISSING', paymentId: 9001, paymentAmount: '1.00' }),
    () => c.partner.adjustCredit({ partnerId: 9001, amount: 1, description: 'Synthetic', requestId: randomUUID() }),
    () => c.partner.setPassword({ partnerId: 9001, password: 'synthetic-only' }),
  ]) await assert.rejects(operation(), forbidden);
  assert.equal(await count('admin_change_events'), 0);
});
test('actual granted PM list/get and operations account read; successful scoped correction audited as product_manager', async () => {
  await seedOrder('READ');
  assert.equal((await caller().order.list()).length, 1);
  assert.equal((await caller().order.get({ orderId: 'READ' })).orderId, 'READ');
  const account = await caller().partner.operationsAccount({ partnerId: 9001 });
  assert.equal(account.creditBalance, 12.06);
  assert(!JSON.stringify(account).includes('NEVER_EXPOSE')); assert(!('passwordHash' in account));
  await caller().partner.operationsAdjustCredit(correction());
  const event = (await pool.query("SELECT * FROM admin_change_events WHERE action='partner.operationsAdjustCredit'")).rows[0];
  assert.equal(event.actor, 'product_manager'); assert(!event.changed_fields.includes('description'));
});
test('actual PM deletes open 10% partner/credit intent without ledger exactly once under concurrent replay; EDIT stays strict', async () => {
  await seedOrder('INTENT', { partnerSourceId: 9001, partnerNumber: 'OWN-9001', partnerCode: 'SYNTHETIC', partnerDiscount: '2', creditUsed: '12.06', partnerCommission: '2', kwkCreditRequested: '3', kwkCreditUsed: '3' });
  await assert.rejects(db.transaction(async (tx: any) => assertOrderFinanciallyEditable(tx, await lockOrder(tx, 'INTENT'))), /FINANCIAL_CORRECTION_REVIEW/);
  const result = await Promise.all([caller().order.delete({ orderId: 'INTENT' }), caller().order.delete({ orderId: 'INTENT' })]);
  assert.equal(result.filter(r => 'alreadyDeleted' in r && r.alreadyDeleted).length, 1);
  assert.equal(await stock(), 10); assert.equal(await count('orders'), 0); assert.equal(await count('order_items'), 0); assert.equal(await count('priority_stock_returns'), 1); assert.equal(await count('priority_order_actions'), 1);
  assert((await pool.query("SELECT actor FROM admin_change_events WHERE action='order.delete'")).rows.every((e: any) => e.actor === 'product_manager'));
  await assert.rejects(caller().order.deleteNoRestock({ orderId: 'INTENT' }), /ORDER_DELETE_INTENT_CONFLICT/);
});
test('actual PM no-restock cleanup allowed only for unbooked intent and leaves inventory unchanged', async () => {
  await seedOrder('NO-RESTOCK', { creditUsed: '12.06', partnerNumber: 'OWN-9001' });
  await caller().order.deleteNoRestock({ orderId: 'NO-RESTOCK' });
  await caller().order.deleteNoRestock({ orderId: 'NO-RESTOCK' });
  assert.equal(await stock(), 9); assert.equal(await count('priority_stock_returns'), 0); assert.equal(await count('orders'), 0);
});
test('actual hard delete blocks paid/state/matched/payment evidence and real Partner/KWK/referral/invoice, retains every item', async () => {
  for (const [id, extra] of [ ['PAID', { paidAt: new Date() }], ['STATE', { status: 'bezahlt' }], ['PACKED', { packedAt: new Date() }], ['MATCHED', { bunqMatchedAt: new Date() }], ['PAYMENT', { bunqPaymentId: 'LOCAL-PAYMENT' }], ['PARTNER', {}], ['KWK', {}], ['REFERRAL', {}], ['INVOICE', { externalOrderReference: 'LOCAL-EXTERNAL' }] ] as const) await seedOrder(id, extra);
  await pool.query(`INSERT INTO partner_transactions(partner_id,order_id,type,amount,balance_after,status) VALUES(9001,'PARTNER','einloesung',-1,11.06,'storniert');
    INSERT INTO kwk_ledger(kwk_id,order_id,type,amount,status) VALUES(9001,'KWK','redeemed',-1,'confirmed');
    INSERT INTO kwk_referrals(kwk_id,order_id) VALUES(9001,'REFERRAL');
    INSERT INTO invoices(invoice_number,order_number,date,date_iso,total_gross,html) VALUES('LOCAL-INVOICE','LOCAL-EXTERNAL','09.11.2026','2026-11-09',38,'synthetic');`);
  const oldStock = await stock();
  for (const id of ['PAID', 'STATE', 'PACKED', 'MATCHED', 'PAYMENT', 'PARTNER', 'KWK', 'REFERRAL', 'INVOICE']) {
    await assert.rejects(caller().order.delete({ orderId: id }), /FINANCIAL_CORRECTION_REVIEW/);
    await assert.rejects(caller().order.deleteNoRestock({ orderId: id }), /FINANCIAL_CORRECTION_REVIEW/);
  }
  assert.equal(await count('orders'), 9); assert.equal(await count('order_items'), 9); assert.equal(await stock(), oldStock); assert.equal(await count('priority_order_actions'), 0); assert.equal(await count('admin_change_events'), 0);
});
test('actual hard delete retains header labels, raw content, tracking, shipped and archived labels', async () => {
  for (const [id, extra] of [ ['URL', { shippingLabelUrl: 'synthetic' }], ['CONTENT', { shippingLabelContent: 'synthetic' }], ['TRACK', { trackingNumber: 'synthetic' }], ['SHIPPED', { shippedAt: new Date() }], ['ARCHIVED', {}] ] as const) await seedOrder(id, extra);
  await pool.query("INSERT INTO dhl_label_generations(id,order_id,generation,state,recipient_snapshot,order_snapshot,reason,actor) VALUES($1,'ARCHIVED',1,'cancelled','{}','{}','Synthetic','local')", [randomUUID()]);
  for (const id of ['URL', 'CONTENT', 'TRACK', 'SHIPPED', 'ARCHIVED']) await assert.rejects(caller().order.deleteNoRestock({ orderId: id }), /SHIPPING_REVIEW|MANUAL_REVIEW/);
  assert.equal(await count('orders'), 5); assert.equal(await count('order_items'), 5);
});
test('actual scoped delete rolls stock/items/audit back when final header delete fails; retry restores once', async () => {
  await seedOrder('ROLLBACK');
  await pool.query("CREATE FUNCTION local_fail_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LOCAL_DELETE_FAILURE'; END $$; CREATE TRIGGER local_cleanup_fail BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION local_fail_cleanup()");
  await assert.rejects(caller().order.delete({ orderId: 'ROLLBACK' }), /Failed query|LOCAL_DELETE_FAILURE/);
  assert.equal(await stock(), 9); assert.equal(await count('order_items'), 1); assert.equal(await count('priority_stock_returns'), 0); assert.equal(await count('priority_order_actions'), 0); assert.equal(await count('admin_change_events'), 0);
  await pool.query('DROP TRIGGER local_cleanup_fail ON orders');
  await caller().order.delete({ orderId: 'ROLLBACK' }); assert.equal(await stock(), 10);
});
test('actual scoped paid cancel reverses booked Partner transaction, never hard deletes paid order/items/ledger', async () => {
  await seedOrder('CANCEL-PAID', { status: 'bezahlt', paidAt: new Date(), partnerSourceId: 9001, partnerNumber: 'OWN-9001', creditUsed: '1' });
  await pool.query("INSERT INTO partner_transactions(partner_id,order_id,type,amount,balance_after,status) VALUES(9001,'CANCEL-PAID','einloesung',-1,12.06,'normal')");
  await caller().order.cancel({ orderId: 'CANCEL-PAID', restock: true, reason: 'Synthetic explicit cancellation' });
  assert.equal(await count('orders'), 1); assert.equal(await count('order_items'), 1); assert.equal(await count('partner_transactions'), 1); assert.equal(await stock(), 10);
  assert.equal((await pool.query("SELECT status FROM partner_transactions WHERE order_id='CANCEL-PAID'")).rows[0].status, 'storniert');
  await assert.rejects(caller().order.delete({ orderId: 'CANCEL-PAID' }), /FINANCIAL_CORRECTION_REVIEW/);
  assert.equal((await pool.query("SELECT actor FROM admin_change_events WHERE action='order.cancel'")).rows[0].actor, 'product_manager');
});
test('actual admin unchanged: bypass grants, can read and clean up; no accidental PM-wide grant', async () => {
  await pool.query('UPDATE operations_account_capability_grants SET revoked_at=NOW()');
  await seedOrder('ADMIN');
  const admin = caller({ ...user, id: 1, username: 'local-admin', role: 'admin' });
  assert.equal((await admin.order.list()).length, 1);
  await admin.order.delete({ orderId: 'ADMIN' });
  assert.equal(await stock(), 10);
  assert.equal((await pool.query("SELECT actor FROM admin_change_events WHERE action='order.delete'")).rows[0].actor, 'local-admin');
});

test('actual authenticated partner 10/10 serverquote checkout: goods 284, CH shipping 18, credit 12.06; no Creator 20%', async () => {
  await pool.query("UPDATE articles SET selling_price=284 WHERE id=9001");
  await pool.query("INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,variants) VALUES(9002,'BAC-10ML','Synthetic BAC','bac-wasser',10,1,1,'Zubehör',5,'[]')");
  const customer = { firstName: 'Synthetic', lastName: 'Owner', email: 'synthetic@fixture.invalid', phone: '+41790000000', street: 'Local', houseNumber: '1', zip: '8000', city: 'Local', country: 'CH' };
  const publicCaller = orderRouter.createCaller({ ...ctx(null), req: { headers: { authorization: `Bearer ${createPartnerToken(9001)}` } } });
  const request = { orderSource: 'shop' as const, sendOrderConfirmation: false, checkoutIdempotencyKey: 'b'.repeat(64), items: [{ name: 'Synthetic (10 mg)', dosage: '10 mg', shopProductId: 'synthetic', price: 284, quantity: 1, type: 'peptide' }], customer, subtotal: 284, discount: 0, discountCode: null, shipping: 18, shippingCountry: 'ch' as const, total: 302, paymentMethod: 'SEPA' as const, date: '2026-11-09', partnerNumber: 'OWN-9001', creditUsed: 12.06 };
  const priced = await publicCaller.quote(request);
  const result = await publicCaller.create({ ...request, expectedQuoteHash: priced.quote.hash });
  const o = (await pool.query('SELECT subtotal,shipping,discount,total,partner_discount,credit_used,partner_commission_base_snapshot,partner_commission,partner_commission_percent_snapshot,partner_code,partner_program_snapshot,partner_settlement_method_snapshot FROM orders WHERE order_id=$1', [result.orderId])).rows[0];
  assert.deepEqual(o, { subtotal: '284.00', shipping: '18.00', discount: '40.46', total: '261.54', partner_discount: '28.40', credit_used: '12.06', partner_commission_base_snapshot: '255.60', partner_commission: '25.56', partner_commission_percent_snapshot: '10.00', partner_code: null, partner_program_snapshot: 'partner', partner_settlement_method_snapshot: 'shop_credit' });
  assert.equal((await pool.query("SELECT count(*)::int n FROM partner_transactions WHERE order_id=$1 AND type='einloesung'", [result.orderId])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM partner_transactions WHERE order_id=$1 AND type='provision'", [result.orderId])).rows[0].n, 0);
  assert.ok(result.orderId);
  await assert.rejects(caller().order.delete({ orderId: result.orderId }), /FINANCIAL_CORRECTION_REVIEW/);
  assert.equal(external, 0);
});
