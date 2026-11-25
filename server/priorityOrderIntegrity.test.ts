import assert from 'node:assert/strict';
import test,{before,after,beforeEach,mock} from 'node:test';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {sql} from 'drizzle-orm';
import {ENV} from './env.js';
import {getDb,getPool,closeDb} from './db.js';
import {orderRouter} from './orderRouter.js';
import {ensureGoodieSchema} from './goodieSchema.js';
import {ensureAdminChangeLogSchema} from './adminChangeLogService.js';
import {ensureCustomerOrderBlockSchema} from './customerOrderBlockService.js';
import {ensurePriorityOrderIntegritySchema,checkoutFingerprint,runOrderTask,queueOrderTask} from './priorityOrderIntegrity.js';
import {lockOrder,returnOrderStock,deleteOrderAtomically} from './orderStockReturnService.js';
import {orders,articles,stockHistory,orderItems} from '../drizzle/schema.js';
import {eq} from 'drizzle-orm';
import { createKwkToken, createKwkDemoToken } from './kwkAuth.js';
import { syncKwkAccountCache, redeemCredit } from './kwkService.js';
import { ensureAccountSecuritySchema } from './accountSecuritySchema.js';
import { ensurePermissionsSchema } from './permissionsSchema.js';
import { ensurePartnerFinancialSchema } from './partnerFinancialSchema.js';
import { ensureCustomerDataChangeSchema, resolveCheckoutCustomerDataChange, createCustomerDataChangeConfirmation } from './customerDataChangeService.js';
// ONLY dedicated reserved local PostgreSQL; no env URL, HTTP or provider keys.
const local = 'postgresql://priority_local@127.0.0.1:56439/postgres';
let pool:any, db:any, external=0;
function rawCaller() {return orderRouter.createCaller({req:{headers:{}},res:{},user:{id:1,username:'local-admin',role:'admin'}} as any);}
function caller() {
 const raw=rawCaller();
 return new Proxy(raw,{get(target,key){
   if(key==='create') return async(payload:Parameters<typeof raw.create>[0])=>{
     const priced=await raw.quote(payload);
     return raw.create({...payload,expectedQuoteHash:priced.quote.hash});
   };
   return Reflect.get(target,key);
 }});
}
function input(extra:any={}) {return {
  orderSource:'shop',sendOrderConfirmation:false,checkoutIdempotencyKey:'a'.repeat(64),
  items:[{name:'Synthetic',dosage:'10 mg',shopProductId:'synthetic',price:20,quantity:1,type:'peptide'}],
  customer:{firstName:'Synthetic',lastName:'Owner',email:'synthetic@example.test',phone:'+41790000000',street:'Local',houseNumber:'1',zip:'8000',city:'Local',country:'CH'},
  subtotal:20,discount:0,discountCode:null,shipping:18,shippingCountry:'ch',total:38,paymentMethod:'SEPA',date:'2026-11-06',...extra,
} as any;}
before(async()=>{
  assert.equal(process.env.DATABASE_URL,'');
  mock.method(globalThis,'fetch',async()=>{external++;throw Error('NETWORK_FORBIDDEN');});
  await closeDb(); ENV.databaseUrl=local; ENV.resendApiKey='';ENV.bunqApiKey='';ENV.dhlApiKey='';ENV.dhlTrackingApiKey='';ENV.forgeApiKey='';
  pool=await getPool();db=await getDb();
  await pool.query(`CREATE TABLE IF NOT EXISTS substitution_config(id integer primary key,enabled boolean);
    INSERT INTO substitution_config VALUES(1,false) ON CONFLICT DO NOTHING;
    CREATE SEQUENCE IF NOT EXISTS priority_test_order_seq;
    CREATE OR REPLACE FUNCTION next_order_id() RETURNS text LANGUAGE sql AS $$ SELECT 'TEST-' || nextval('priority_test_order_seq')::text $$;`);
  await ensureCustomerOrderBlockSchema();await ensureGoodieSchema();await ensureAdminChangeLogSchema();await ensurePriorityOrderIntegritySchema();
  await ensurePermissionsSchema();await ensureAccountSecuritySchema();await ensurePartnerFinancialSchema();
  await ensureCustomerDataChangeSchema();
  await ensurePriorityOrderIntegritySchema(); // idempotent migration repeat
});
beforeEach(async()=>{
 external=0;
 await pool.query(`DROP TRIGGER IF EXISTS priority_fail_item ON order_items;
   UPDATE substitution_config SET enabled=false WHERE id=1;
   DROP TRIGGER IF EXISTS priority_fail_delete ON orders;
   DROP TRIGGER IF EXISTS priority_fail_kwk_cancel ON kwk_ledger;
   DROP TRIGGER IF EXISTS priority_fail_cache ON kwk_accounts;
   TRUNCATE customer_data_change_confirmations,customer_data_change_events,goodie_assignments,priority_stock_returns,priority_order_actions,priority_order_tasks,priority_checkout_receipts,stock_history,order_items,orders,customers,articles,partners,partner_programs,kwk_accounts,partner_transactions,kwk_ledger,kwk_referrals,invoices,shop_settings CASCADE;
   INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,sale_price,variants)
   VALUES(9001,'SYNTHETIC-10MG','Synthetic (10 mg)','synthetic',10,1,1,'Peptide',20,0,'[]'),
   (9002,'SUBSTITUTED-5MG','Actual replacement (5 mg)','replacement',4,1,1,'Peptide',10,0,'[]'),
   (9003,'BAC-10ML','Actual BAC','bac-wasser',10,1,1,'Zubehör',5,0,'[]'),
   (9004,'BAC-3ML','BAC Wasser 3ml','bac-wasser-3ml',100,1,1,'Zubehör',4.16,0,'[]');
   INSERT INTO customers(id,customer_number,name,first_name,last_name,email,phone,street,house_number,zip,city,country)
   VALUES(9001,'999001','Synthetic Owner','Synthetic','Owner','synthetic@example.test','+41790000000','Local','1','8000','Local','CH');
   INSERT INTO kwk_accounts(id,kwk_number,referral_code,name,email,phone,password_hash)
   VALUES(1,'KWK-1','KWK-1','Synthetic KWK','kwk1@example.test','1','unused'),(2,'KWK-2','KWK-2','Synthetic KWK 2','kwk2@example.test','2','unused');
   INSERT INTO shop_settings(key,value) VALUES('address_validation_enabled','false');`);
});
after(async()=>{await closeDb();ENV.databaseUrl='';mock.restoreAll();});
async function count(table:string) {return Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);}
async function stock(id=9001) {return (await pool.query('SELECT stock FROM articles WHERE id=$1',[id])).rows[0].stock;}
async function smartSubFixture(smallerStock:number,enabled=true) {
 await pool.query('UPDATE substitution_config SET enabled=$1 WHERE id=1',[enabled]);
 await pool.query('UPDATE articles SET stock=$1,variants=$2::jsonb WHERE id=9001',[smallerStock,JSON.stringify([
   {dosage:'10 mg',sku:'SYNTHETIC-10MG',price:20},{dosage:'20 mg',sku:'SYNTHETIC-20MG',price:40},
 ])]);
 await pool.query(`INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,sale_price,variants)
   VALUES(9010,'SYNTHETIC-20MG','Synthetic (20 mg)','synthetic',0,1,0,'Peptide',40,0,'[]')`);
 return input({items:[{...input().items[0],dosage:'20 mg',price:40}],subtotal:40,total:58});
}
test('ACTUAL Smart Sub: quote and create retain selected 20-mg price, consume 2x10-mg and replay without a second deduction',async()=>{
 const payload=await smartSubFixture(2);
 const priced=await rawCaller().quote(payload);
 assert.equal(priced.quote.items.find((i:any)=>!i.isFreeGift)?.price,40);
 assert.equal(priced.quote.total,58);
 const submitted={...payload,expectedQuoteHash:priced.quote.hash};
 const order=await rawCaller().create(submitted);
 assert.ok('total' in order);
 assert.equal(order.total,58); assert.equal(await stock(),0); assert.equal(await stock(9010),0); assert.equal(await stock(9004),99);
 assert.equal(await count('orders'),1); assert.equal(await count('stock_history'),2); assert.equal(external,0);
 const again=await rawCaller().create(submitted);
 assert.equal(again.orderId,order.orderId); assert.equal(await stock(),0); assert.equal(await count('stock_history'),2);
});
test('ACTUAL Smart Sub: disabled switch or insufficient combined smaller/larger demand fails before order writes',async()=>{
 const payload=await smartSubFixture(2,false);
 await assert.rejects(rawCaller().quote(payload),/CHECKOUT_STOCK_DEMAND_NOT_COVERED|Bestand/);
 await pool.query('UPDATE substitution_config SET enabled=true WHERE id=1');
 const mixed=input({items:[payload.items[0],input().items[0]],subtotal:60,total:78});
 await assert.rejects(rawCaller().quote(mixed),/CHECKOUT_STOCK_DEMAND_NOT_COVERED|Bestand/);
 assert.equal(await count('orders'),0); assert.equal(await count('priority_checkout_receipts'),0); assert.equal(await count('stock_history'),0);
 assert.equal(await stock(),2); assert.equal(await stock(9004),100); assert.equal(external,0);
});
test('ACTUAL Smart Sub: sufficient combined smaller/larger demand deducts each underlying unit only once',async()=>{
 const payload=await smartSubFixture(3);
 const mixed=input({items:[payload.items[0],input().items[0]],subtotal:60,total:78});
 const priced=await rawCaller().quote(mixed);
 const order=await rawCaller().create({...mixed,expectedQuoteHash:priced.quote.hash});
 assert.ok('total' in order);
 assert.equal(order.total,78); assert.equal(await stock(),0); assert.equal(await stock(9010),0); assert.equal(await stock(9004),98);
 const used=await pool.query('SELECT SUM(-quantity_change)::int AS n FROM stock_history WHERE article_id=9001 AND order_id=$1',[order.orderId]);
 assert.equal(used.rows[0].n,3); assert.equal(await count('orders'),1); assert.equal(external,0);
});
test('ACTUAL Smart Sub: Plug&Play uses equivalent smaller stock without granting an extra BAC gift',async()=>{
 const payload=await smartSubFixture(2);
 payload.items[0].isPlugPlay=true;
 const priced=await rawCaller().quote(payload);
 assert.equal(priced.quote.total,73); assert.equal(priced.quote.items.some((i:any)=>i.isFreeGift),false);
 const order=await rawCaller().create({...payload,expectedQuoteHash:priced.quote.hash});
 assert.ok('total' in order);
 assert.equal(order.total,73); assert.equal(await stock(),0); assert.equal(await stock(9004),100); assert.equal(await count('stock_history'),1);
 assert.equal(external,0);
});
async function seedOrder(orderId='RETURN',extra:any={}) {
 await db.insert(orders).values({orderId,firstName:'Synthetic',lastName:'Owner',email:'synthetic@example.test',phone:'',street:'Local',houseNumber:'1',zip:'8000',city:'Local',country:'CH',subtotal:'20',discount:'0',shipping:'18',shippingCountry:'ch',total:'38',paymentMethod:'SEPA',status:'offen',orderDate:new Date(),...extra});
 await db.insert(orderItems).values({orderId,name:'Original requested variant',type:'peptide',price:'20',quantity:1});
}
async function movement(orderId:string,articleId:number,change:number,type='verkauf') {
 const before=await stock(articleId);await pool.query('UPDATE articles SET stock=stock+$1 WHERE id=$2',[change,articleId]);
 const row=await pool.query('INSERT INTO stock_history(article_id,change_type,quantity_before,quantity_change,quantity_after,order_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[articleId,type,before,change,before+change,orderId]);return row.rows[0].id;
}
test('actual router: identical-key concurrent requests commit one receipt/order/stock movement',async()=>{
 const [a,b]=await Promise.all([caller().create(input()),caller().create(input())]);
 assert.equal(a.orderId,b.orderId);assert.equal(await count('orders'),1);assert.equal(await count('priority_checkout_receipts'),1);assert.equal(await count('stock_history'),2);assert.equal(await stock(),9);assert.equal(await stock(9004),99);assert.equal(external,0);
 const c=await caller().create(input({date:'2026-11-07'}));assert.equal(c.orderId,a.orderId);assert.equal(await stock(),9);
});
test('actual router: different payload with same key conflicts and exposes no status PII',async()=>{
 const a=await caller().create(input());
 await assert.rejects(caller().create(input({items:[{...input().items[0],quantity:2}],subtotal:40,total:58})),/CHECKOUT_INTENT_CONFLICT/);
 const parsed={storeKey:'369research',communicationLanguage:'de',...input(),customer:{deliveryType:'home',...input().customer}};
 const status=await caller().checkoutStatus({checkoutIdempotencyKey:input().checkoutIdempotencyKey,payloadFingerprint:checkoutFingerprint(parsed)});
 assert.deepEqual(status,{state:'committed',orderId:a.orderId});
 assert.deepEqual(await caller().checkoutStatus({checkoutIdempotencyKey:input().checkoutIdempotencyKey,payloadFingerprint:'b'.repeat(64)}),{state:'not_found'});
 assert.equal(await count('orders'),1);
});
test('actual router: item insert failure rolls back receipt, order and stock; same key remains retryable',async()=>{
 await pool.query(`CREATE OR REPLACE FUNCTION priority_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LOCAL_INJECTED'; END $$;
 CREATE TRIGGER priority_fail_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION priority_fail();`);
 await assert.rejects(caller().create(input()),/Failed query|LOCAL_INJECTED/);
 assert.equal(await count('orders'),0);assert.equal(await count('priority_checkout_receipts'),0);assert.equal(await stock(),10);assert.equal(await count('stock_history'),0);
 await pool.query('DROP TRIGGER priority_fail_item ON order_items');await caller().create(input());assert.equal(await stock(),9);
});
test('actual router: CRM failure after commit returns success and durable repair task, replay no retry',async()=>{
 const original=pool.query.bind(pool); const intercept=mock.method(pool,'query',async(q:any,v?:any)=>{
   if(typeof q==='string' && /SELECT total, status, order_date/.test(q)) throw Error('LOCAL_CRM_FAILURE');return original(q,v);
 });
 const a=await caller().create(input());intercept.mock.restore();
 assert.equal(a.success,true);assert.equal(await count('orders'),1);
 assert.equal((await pool.query("SELECT state FROM priority_order_tasks WHERE order_id=$1 AND task='customer_metrics'",[a.orderId])).rows[0].state,'repair_required');
 await caller().create(input());assert.equal(await stock(),9);
});
test('actual task: payment instruction failure never rejects commit, mail unknown never auto-retries',async()=>{
 await db.transaction(async(tx:any)=>{await queueOrderTask(tx,'TASK','payment_instructions');await queueOrderTask(tx,'TASK','order_confirmation');});
 assert.equal(await runOrderTask(db,'TASK','payment_instructions',async()=>{throw Error('LOCAL_CONFIG_FAILURE');}),null);
 let sends=0;await runOrderTask(db,'TASK','order_confirmation',async()=>{sends++;throw Error('LOCAL_UNKNOWN');},true);
 await runOrderTask(db,'TASK','order_confirmation',async()=>{sends++;},true);assert.equal(sends,1);
 assert.equal((await pool.query("SELECT state FROM priority_order_tasks WHERE order_id='TASK' AND task='order_confirmation'")).rows[0].state,'unknown');
});
test('actual router: negative/fractional quantity rejected; duplicate demand rolls back instead of partial sale',async()=>{
 await assert.rejects(caller().create(input({items:[{...input().items[0],quantity:-1}]})));
 await assert.rejects(caller().create(input({items:[{...input().items[0],quantity:0.5}]})));
 await pool.query('UPDATE articles SET stock=1 WHERE id=9001');
 await assert.rejects(caller().create(input({items:[input().items[0],input().items[0]],subtotal:40,total:58})),/CHECKOUT_STOCK_DEMAND_NOT_COVERED/);
 assert.equal(await count('orders'),0);assert.equal(await stock(),1);assert.equal(await count('stock_history'),0);
});
test('actual public router: client accessory type cannot bypass catalog peptide inventory',async()=>{
 await caller().create(input({items:[{...input().items[0],type:'accessory'}]}));assert.equal(await stock(),9);
});
test('actual router: public no-key cannot create even with a confirmed quote',async()=>{
 const payload=input({checkoutIdempotencyKey:undefined});const priced=await rawCaller().quote(payload);
 await assert.rejects(rawCaller().create({...payload,expectedQuoteHash:priced.quote.hash}),/CHECKOUT_INTENT_KEY_REQUIRED/);
 assert.equal(await count('orders'),0);assert.equal(await count('priority_checkout_receipts'),0);assert.equal(await stock(),10);assert.equal(await stock(9004),100);
});
test('actual router: cancellation returns exact replacement and BAC movements once under race',async()=>{
 await seedOrder();const a=await movement('RETURN',9002,-2);const b=await movement('RETURN',9003,-1);
 // Negative local correction is not a sale and must never be returned.
 await movement('RETURN',9001,-3,'korrektur');
 const [x,y]=await Promise.all([caller().cancel({orderId:'RETURN',restock:true,reason:'Local explicit cancellation'}),caller().cancel({orderId:'RETURN',restock:true,reason:'Local explicit cancellation'})]);
 assert.equal(x.restoredStock+y.restoredStock,3);assert.equal(await stock(9002),4);assert.equal(await stock(9003),10);assert.equal(await stock(),7);
 assert.equal(await count('priority_stock_returns'),2);assert.deepEqual((await pool.query('SELECT original_movement_id FROM priority_stock_returns ORDER BY original_movement_id')).rows.map((r:any)=>r.original_movement_id),[a,b]);
 assert.equal(x.financialRepairRequired,false);assert.equal(y.financialRepairRequired,false);assert.equal(await count('priority_order_tasks'),0);
});
test('actual service: later error rolls status/stock/return mappings back together',async()=>{
  await seedOrder();await movement('RETURN',9002,-2);
 await assert.rejects(db.transaction(async(tx:any)=>{const o=await lockOrder(tx,'RETURN');await returnOrderStock(tx,o,'Local rollback','Admin');await tx.update(orders).set({status:'storniert'}).where(eq(orders.orderId,'RETURN'));throw Error('LOCAL_LATE_ERROR');}),/LOCAL_LATE_ERROR/);
 assert.equal(await stock(9002),2);assert.equal(await count('priority_stock_returns'),0);assert.equal((await pool.query("SELECT status FROM orders WHERE order_id='RETURN'")).rows[0].status,'offen');
});
test('actual router: unproven history and unlinked prior positive return fail closed',async()=>{
 await seedOrder();await assert.rejects(caller().cancel({orderId:'RETURN',restock:true,reason:'Local explicit cancellation'}),/ORDER_STOCK_HISTORY_REVIEW_REQUIRED/);
 await movement('RETURN',9002,-2);await movement('RETURN',9002,1,'retoure');
 await assert.rejects(caller().cancel({orderId:'RETURN',restock:true,reason:'Local explicit cancellation'}),/ORDER_STOCK_HISTORY_REVIEW_REQUIRED/);assert.equal(await count('priority_stock_returns'),0);
});
test('actual router: shipped cancellation no-restock allowed but automatic return/delete blocked',async()=>{
 await seedOrder('SHIPPED',{status:'versendet',shippedAt:new Date()});await movement('SHIPPED',9002,-1);
 await assert.rejects(caller().cancel({orderId:'SHIPPED',restock:true,reason:'Local explicit cancellation'}),/MANUAL_REVIEW/);
 await caller().cancel({orderId:'SHIPPED',restock:false,reason:'Local explicit cancellation'});
 await assert.rejects(caller().delete({orderId:'SHIPPED'}),/MANUAL_REVIEW/);assert.equal(await stock(9002),3);
});
test('actual router: delete financial/invoice-linked orders blocked without losing items',async()=>{
 await seedOrder('PAID',{status:'bezahlt',paidAt:new Date()});await assert.rejects(caller().deleteNoRestock({orderId:'PAID'}),/FINANCIAL_CORRECTION_REVIEW/);
 assert.equal(await count('order_items'),1);
 await seedOrder('INVOICE');await pool.query("INSERT INTO invoices(invoice_number,order_number,date,date_iso,total_gross,html) VALUES('LOCAL-INVOICE','INVOICE','06.11.2026','2026-11-06',38,'local')");
 await assert.rejects(caller().delete({orderId:'INVOICE'}),/FINANCIAL_CORRECTION_REVIEW/);assert.equal(await count('order_items'),2);
});
test('actual router: delete restock fails atomically if final header deletion fails; retry one return/audit',async()=>{
 await seedOrder();await movement('RETURN',9002,-2);
 await pool.query('CREATE TRIGGER priority_fail_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION priority_fail()');
 await assert.rejects(caller().delete({orderId:'RETURN'}),/Failed query|LOCAL_INJECTED/);
 assert.equal(await stock(9002),2);assert.equal(await count('order_items'),1);assert.equal(await count('priority_stock_returns'),0);
 await pool.query('DROP TRIGGER priority_fail_delete ON orders');const a=await caller().delete({orderId:'RETURN'});const b=await caller().delete({orderId:'RETURN'});
 assert.equal(a.restoredStock,2);assert.equal(b.alreadyDeleted,true);assert.equal(await stock(9002),4);assert.equal(await count('orders'),0);assert.equal(await count('priority_stock_returns'),1);
});
test('actual router: no-restock delete also rolls back item removal when header fails',async()=>{
 await seedOrder();await pool.query('CREATE TRIGGER priority_fail_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION priority_fail()');
 await assert.rejects(caller().deleteNoRestock({orderId:'RETURN'}));assert.equal(await count('order_items'),1);
});
test('actual router: edit item failure rolls financial header and positions back; paid edits guarded',async()=>{
 await seedOrder();await pool.query(`CREATE TRIGGER priority_fail_item BEFORE INSERT OR UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION priority_fail()`);
 await assert.rejects(caller().update({orderId:'RETURN',items:[{name:'Original requested variant',type:'peptide',price:30,quantity:1}],subtotal:30,discount:0,shipping:18,total:48}));
 assert.equal((await pool.query("SELECT total FROM orders WHERE order_id='RETURN'")).rows[0].total,'38.00');assert.equal(await count('order_items'),1);
 await pool.query("UPDATE orders SET paid_at=now() WHERE order_id='RETURN'");
 await assert.rejects(caller().update({orderId:'RETURN',items:[{name:'Original requested variant',type:'peptide',price:30,quantity:1}],subtotal:30,discount:0,shipping:18,total:48}),/FINANCIAL_CORRECTION_REVIEW/);
});

test('actual router: positive local correction never becomes an automatic second return',async()=>{
 await seedOrder();await movement('RETURN',9002,-2);await movement('RETURN',9002,1,'korrektur');
 await assert.rejects(caller().cancel({orderId:'RETURN',restock:true,reason:'Local explicit cancellation'}),/ORDER_STOCK_HISTORY_REVIEW_REQUIRED/);assert.equal(await count('priority_stock_returns'),0);
});
test('actual router: status-only cancellation does not silently restock and persists financial repair',async()=>{
  await seedOrder();await movement('RETURN',9002,-2);
  const r=await caller().updateStatus({orderId:'RETURN',status:'storniert'});
  assert.equal(r.success,true);assert.equal(r.financialRepairRequired,false);assert.equal(await count('priority_order_tasks'),0);assert.equal(await stock(9002),2);assert.equal(await count('priority_stock_returns'),0);
});
test('actual router: successful explicit article edit includes removed positions in same-tx stock plan',async()=>{
  await seedOrder();await db.update(orderItems).set({articleId:9002}).where(eq(orderItems.orderId,'RETURN'));
 await movement('RETURN',9002,-1);
 const id=(await pool.query("SELECT id FROM order_items WHERE order_id='RETURN'")).rows[0].id;
 await caller().update({orderId:'RETURN',items:[{name:'New explicit inventory item',type:'peptide',price:20,quantity:2,articleId:9001}],subtotal:40,discount:0,shipping:18,total:58});
 assert.equal(await stock(9002),4);assert.equal(await stock(),8);assert.equal(await count('priority_stock_returns'),1);
 await caller().cancel({orderId:'RETURN',restock:true,reason:'Local cancel after edit'});assert.equal(await stock(),10);assert.equal(await stock(9002),4);assert.equal(await count('priority_stock_returns'),2);
});

test('actual router: cancellation with original returns cannot reopen and reship without review',async()=>{
 await seedOrder();await movement('RETURN',9002,-1);await caller().cancel({orderId:'RETURN',restock:true,reason:'Local deliberate cancel'});
 await assert.rejects(caller().updateStatus({orderId:'RETURN',status:'offen'}),/REOPEN_REVIEW_REQUIRED/);assert.equal(await stock(9002),4);
});
test('actual router: repeated explicit item edits recognize already returned originals',async()=>{
 await seedOrder();await db.update(orderItems).set({articleId:9002}).where(eq(orderItems.orderId,'RETURN'));await movement('RETURN',9002,-1);
 for(const quantity of [2,3]) await caller().update({orderId:'RETURN',items:[{name:'New explicit inventory item',type:'peptide',price:20,quantity,articleId:9001}],subtotal:20*quantity,discount:0,shipping:18,total:20*quantity+18});
 assert.equal(await stock(9002),4);assert.equal(await stock(),7);
 await caller().cancel({orderId:'RETURN',restock:true,reason:'Local cancellation after two edits'});assert.equal(await stock(),10);
});

test('actual finance adapter: second ledger failure rolls back first ledger and status with caller transaction',async()=>{
 const {reverseOrderFinancesInTransaction}=await import('./priorityOrderFinancialAdapter.js');
 await seedOrder('FINANCE');
 await assert.rejects(db.transaction(async(tx:any)=>{
  await lockOrder(tx,'FINANCE');await tx.update(orders).set({status:'storniert'}).where(eq(orders.orderId,'FINANCE'));
  await reverseOrderFinancesInTransaction(tx,'FINANCE',{
   partner:async(_id,client)=>{await client.query("INSERT INTO priority_order_tasks(order_id,task,state) VALUES($1,'fake_partner','done')",['FINANCE']);},
   kwk:async()=>{throw Error('LOCAL_SECOND_LEDGER_FAILURE');},
  });
 }),/LOCAL_SECOND_LEDGER_FAILURE/);
 assert.equal((await pool.query("SELECT status FROM orders WHERE order_id='FINANCE'")).rows[0].status,'offen');
 assert.equal(await count('priority_order_tasks'),0);
});
test('actual finance adapter: shared adapter writes and order status commit together on success',async()=>{
 const {reverseOrderFinancesInTransaction}=await import('./priorityOrderFinancialAdapter.js');await seedOrder('FINANCE');
 const r=await db.transaction(async(tx:any)=>{
  await lockOrder(tx,'FINANCE');await tx.update(orders).set({status:'storniert'}).where(eq(orders.orderId,'FINANCE'));
  return reverseOrderFinancesInTransaction(tx,'FINANCE',{
   partner:async(_id,client)=>{await client.query("INSERT INTO priority_order_tasks(order_id,task,state) VALUES($1,'fake_partner','done')",['FINANCE']);},
   kwk:async(_id,client)=>{await client.query("INSERT INTO priority_order_tasks(order_id,task,state) VALUES($1,'fake_kwk','done')",['FINANCE']);},
  });
 });assert.equal(r.repairRequired,false);assert.equal(await count('priority_order_tasks'),2);assert.equal((await pool.query("SELECT status FROM orders WHERE order_id='FINANCE'")).rows[0].status,'storniert');
});

async function seedFinancialCancellation() {
  await seedOrder('INTEGRATED',{partnerSourceId:9,partnerNumber:'OWN9',creditUsed:'10',kwkCreditOwnerId:1});
  await movement('INTEGRATED',9002,-2);
  await pool.query(`INSERT INTO partners(id,name,email,code,partner_number,credit_balance) VALUES(9,'Synthetic partner','partner@example.test','TEST','OWN9',90);
    INSERT INTO partner_transactions(partner_id,order_id,type,amount,balance_after,status) VALUES(9,'INTEGRATED','einloesung',-10,90,'normal');
    INSERT INTO kwk_ledger(kwk_id,order_id,type,amount,status) VALUES
      (1,NULL,'manual_correction',50,'confirmed'),(1,'INTEGRATED','redeemed',-12,'confirmed'),
      (2,NULL,'manual_correction',50,'confirmed'),(2,'INTEGRATED','credit_released',9,'confirmed');
    INSERT INTO kwk_referrals(kwk_id,order_id) VALUES(2,'INTEGRATED');`);
  await syncKwkAccountCache(1,pool);await syncKwkAccountCache(2,pool);
}
async function integratedState() {
  return {
    order:(await pool.query("SELECT status,cancelled_at FROM orders WHERE order_id='INTEGRATED'")).rows[0],
    partner:(await pool.query('SELECT credit_balance FROM partners WHERE id=9')).rows[0],
    entries:(await pool.query('SELECT id,status,amount FROM partner_transactions ORDER BY id')).rows,
    ledger:(await pool.query('SELECT id,kwk_id,type,status,amount FROM kwk_ledger ORDER BY id')).rows,
    caches:(await pool.query('SELECT id,credit_available,credit_pending,credit_redeemed FROM kwk_accounts ORDER BY id')).rows,
    referral:(await pool.query('SELECT status FROM kwk_referrals')).rows,
    stock:await stock(9002),history:await count('stock_history'),returns:await count('priority_stock_returns'),actions:await count('priority_order_actions'),
  };
}
test('ACTUAL Order.cancel: second real KWK ledger failure rolls Partner, order, stock and caches back; positive retry/racing replay commits once',async()=>{
  await seedFinancialCancellation();const before=await integratedState();
  await pool.query(`CREATE OR REPLACE FUNCTION priority_cancel_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='cancelled' THEN RAISE EXCEPTION 'LOCAL_REAL_KWK_FAILURE'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER priority_fail_kwk_cancel BEFORE INSERT ON kwk_ledger FOR EACH ROW EXECUTE FUNCTION priority_cancel_fail();`);
  await assert.rejects(caller().cancel({orderId:'INTEGRATED',restock:true,reason:'Local integrated rollback'}),e=>/LOCAL_REAL_KWK_FAILURE|Failed query/.test(String(e)));
  assert.deepEqual(await integratedState(),before);assert.equal(external,0);
  await pool.query('DROP TRIGGER priority_fail_kwk_cancel ON kwk_ledger');
  const results=await Promise.all([caller().cancel({orderId:'INTEGRATED',restock:true,reason:'Local integrated retry'}),caller().cancel({orderId:'INTEGRATED',restock:true,reason:'Local integrated retry'})]);
  assert.equal(results.reduce((s,r)=>s+r.restoredStock,0),2);assert(results.every(r=>r.financialRepairRequired===false));
  const committed=await integratedState();assert.equal(committed.order.status,'storniert');assert(committed.order.cancelled_at);
  assert.equal(committed.partner.credit_balance,'100.00');assert.deepEqual(committed.entries.map((r:any)=>r.status),['storniert']);
  assert.deepEqual(committed.caches.map((r:any)=>r.credit_available),['50.00','50.00']);
  assert.equal(committed.ledger.filter((r:any)=>r.type==='cancelled').length,2);assert.equal(committed.stock,4);assert.equal(committed.returns,1);
  await caller().cancel({orderId:'INTEGRATED',restock:true,reason:'Local integrated replay'});
  assert.deepEqual(await integratedState(),committed);assert.equal(external,0);
});
test('ACTUAL Order.cancel: cache failure after Partner and KWK writes rolls all state back',async()=>{
  await seedFinancialCancellation();const before=await integratedState();
  await pool.query(`CREATE OR REPLACE FUNCTION priority_cache_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LOCAL_REAL_CACHE_FAILURE'; END $$;
    CREATE TRIGGER priority_fail_cache BEFORE UPDATE ON kwk_accounts FOR EACH ROW EXECUTE FUNCTION priority_cache_fail();`);
  await assert.rejects(caller().cancel({orderId:'INTEGRATED',restock:true,reason:'Local integrated cache rollback'}),e=>/LOCAL_REAL_CACHE_FAILURE|Failed query/.test(String(e)));
  assert.deepEqual(await integratedState(),before);assert.equal(external,0);
});
async function seedCheckoutCredit() {
  await pool.query("INSERT INTO kwk_ledger(kwk_id,type,amount,status) VALUES(1,'manual_correction',50,'confirmed')");
  await syncKwkAccountCache(1,pool);
}
const kwkInput=(extra:any={})=>input({kwkCreditUsed:10,kwkCreditKwkId:2,kwkCreditToken:createKwkToken(1),...extra});
test('ACTUAL checkout: productive auth ignores browser owner; owner/debit/cache commit together and receipt replay no double debit',async()=>{
  await seedCheckoutCredit();const [a,b]=await Promise.all([caller().create(kwkInput()),caller().create(kwkInput())]);
  assert.equal(a.orderId,b.orderId);assert.equal(await count('orders'),1);
  const o=(await pool.query('SELECT kwk_credit_owner_id,kwk_credit_requested,kwk_credit_used FROM orders')).rows[0];
  assert.deepEqual(o,{kwk_credit_owner_id:1,kwk_credit_requested:'10.00',kwk_credit_used:'10.00'});
  assert.equal((await pool.query("SELECT count(*)::int n FROM kwk_ledger WHERE type='redeemed'")).rows[0].n,1);
  assert.equal((await pool.query('SELECT credit_available FROM kwk_accounts WHERE id=1')).rows[0].credit_available,'40.00');
  assert.equal(await stock(),9);await caller().create(kwkInput());assert.equal(await stock(),9);assert.equal(external,0);
});
test('ACTUAL checkout: post-debit item failure rolls owner/order/receipt/debit/cache and stock back',async()=>{
  await seedCheckoutCredit();
  await pool.query('CREATE TRIGGER priority_fail_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION priority_fail()');
  await assert.rejects(caller().create(kwkInput()),/Failed query|LOCAL_INJECTED/);
  assert.equal(await count('orders'),0);assert.equal(await count('priority_checkout_receipts'),0);assert.equal(await stock(),10);assert.equal(await count('stock_history'),0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM kwk_ledger WHERE type='redeemed'")).rows[0].n,0);
  assert.equal((await pool.query('SELECT credit_available FROM kwk_accounts WHERE id=1')).rows[0].credit_available,'50.00');
});
test('ACTUAL checkout: demo/revoked/deactivated sessions denied before any order or stock writes',async()=>{
  await seedCheckoutCredit();
  await assert.rejects(caller().create(kwkInput({kwkCreditToken:createKwkDemoToken(1)})),/AUTHENTIFIZIERUNG/);
  await pool.query('UPDATE kwk_accounts SET session_version=1 WHERE id=1');
  await assert.rejects(caller().create(kwkInput()),/AUTHENTIFIZIERUNG/);
  await pool.query("UPDATE kwk_accounts SET session_version=0,status='deaktiviert' WHERE id=1");
  await assert.rejects(caller().create(kwkInput()),/AUTHENTIFIZIERUNG/);
  assert.equal(await count('orders'),0);assert.equal(await stock(),10);assert.equal(await count('stock_history'),0);assert.equal(external,0);
});
test('ACTUAL checkout: revocation after initial auth is rechecked after owner lock and rolls transaction back',async()=>{
  await seedCheckoutCredit();const original=db.transaction.bind(db);let revoked=false;
  const intercept=mock.method(db,'transaction',async(...args:any[])=>{
    if(!revoked){revoked=true;await pool.query('UPDATE kwk_accounts SET session_version=session_version+1 WHERE id=1');}
    return original(...args);
  });
  try {await assert.rejects(caller().create(kwkInput()),/SESSION_WIDERRUFEN/);} finally {intercept.mock.restore();}
  assert(revoked);assert.equal(await count('orders'),0);assert.equal(await stock(),10);assert.equal(await count('stock_history'),0);
  assert.equal((await pool.query('SELECT credit_available FROM kwk_accounts WHERE id=1')).rows[0].credit_available,'50.00');
});
test('ACTUAL preview: trusted synthetic KWK preview cannot write owner/order/ledger/stock',async()=>{
  await seedCheckoutCredit();const preview=orderRouter.createCaller({req:{headers:{}},res:{},user:null,operationsPreview:{kwkCreditAccountId:1}} as any);
  const r=await preview.create(input({kwkCreditUsed:10}));assert('operationsPreview' in r);
  assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);assert.equal(await stock(),10);
  assert.equal((await pool.query('SELECT credit_available FROM kwk_accounts WHERE id=1')).rows[0].credit_available,'50.00');
  assert.equal((await pool.query("SELECT count(*)::int n FROM kwk_ledger WHERE type='redeemed'")).rows[0].n,0);assert.equal(external,0);
});
test('ACTUAL legacy redeem wrapper: NULL owner fails closed without retroclaim or debit',async()=>{
  await seedCheckoutCredit();await seedOrder('LEGACY',{kwkCreditRequested:'10',kwkCreditUsed:'10',discount:'10'});
  await assert.rejects(redeemCredit(1,'LEGACY',10),/OWNER_REQUIRED/);
  assert.equal((await pool.query("SELECT kwk_credit_owner_id FROM orders WHERE order_id='LEGACY'")).rows[0].kwk_credit_owner_id,null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM kwk_ledger WHERE type='redeemed'")).rows[0].n,0);
});

test('ACTUAL checkout retry: renewed customer confirmation returns existing receipt once; changed address still conflicts',async()=>{
  const customer={...input().customer,street:'New Local'};
  async function confirmation() {
    const rows=(await pool.query('SELECT id,name,first_name AS "firstName",last_name AS "lastName",email,phone,street,house_number AS "houseNumber",zip,city,country FROM customers WHERE id=9001')).rows;
    const resolution=resolveCheckoutCustomerDataChange(rows,customer);assert.equal(resolution.kind,'matched');
    if(resolution.kind!=='matched')throw Error('LOCAL_RESOLUTION_REQUIRED');assert(resolution.requiresConfirmation);
    return (await createCustomerDataChangeConfirmation(db,resolution)).confirmationToken;
  }
  await assert.rejects(caller().create(input({customer})),/CUSTOMER_DATA_CHANGE_RECONFIRMATION_REQUIRED/);
  assert.equal(await count('orders'),0);assert.equal(await stock(),10);
  const first=await confirmation();const a=await caller().create(input({customer,customerDataChangeConfirmationToken:first}));
  assert.equal((await pool.query('SELECT street FROM customers WHERE id=9001')).rows[0].street,'Local');
  const second=await confirmation();assert.notEqual(second,first);
  const b=await caller().create(input({customer,customerDataChangeConfirmationToken:second}));assert.equal(b.orderId,a.orderId);
  assert.equal(await count('orders'),1);assert.equal(await count('priority_checkout_receipts'),1);assert.equal(await count('stock_history'),2);assert.equal(await count('customer_data_change_events'),1);assert.equal(await stock(),9);assert.equal(await stock(9004),99);
  await assert.rejects(caller().create(input({customer:{...customer,street:'Another Local'},customerDataChangeConfirmationToken:second})),/CHECKOUT_INTENT_CONFLICT/);
  assert.equal(await count('orders'),1);assert.equal(await stock(),9);assert.equal(external,0);
});

// General order.edit regression coverage: actual route and disposable PostgreSQL.
const editPayload=async(orderId:string,extra:any={})=>{
 const o=(await pool.query('SELECT * FROM orders WHERE order_id=$1',[orderId])).rows[0];
 const rows=(await pool.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id',[orderId])).rows;
 return {orderId,items:rows.map((i:any)=>({id:i.id,name:i.name,dosage:i.dosage || undefined,variant:i.variant || undefined,type:i.type,price:Number(i.price),quantity:i.quantity,articleId:i.article_id || undefined})),subtotal:Number(o.subtotal),discount:Number(o.discount),discountCode:o.discount_code,discountBreakdown:o.discount_breakdown || [],shipping:Number(o.shipping),total:Number(o.total),...extra};
};
const editSnapshot=async()=>{
 await new Promise(resolve=>setTimeout(resolve,30)); // settle existing fire-and-forget audit
 const state:any={};
 for(const table of ['orders','order_items','articles','stock_history','priority_stock_returns','priority_order_actions','priority_order_tasks','partner_transactions','kwk_ledger','kwk_referrals','invoices','admin_change_events'])state[table]=(await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
 return state;
};
const conflict=(key:string)=>(error:any)=>error.code==='CONFLICT' && error.message.includes(key);
test('ACTUAL order.update: paid/partner/KWK/invoice/shipped/cancelled no-ops preserve every row, ID, flag, timestamp and audit count',async()=>{
 await pool.query("INSERT INTO partners(id,name,email,code,partner_number) VALUES(9,'Synthetic','p@example.test','P9','OWN9')");
 for(const [id,extra] of [['PAID-NOOP',{status:'bezahlt',paidAt:new Date()}],['PARTNER-NOOP',{partnerSourceId:9,partnerCode:'P9',partnerCommission:'2',creditUsed:'3'}],['KWK-NOOP',{kwkCreditOwnerId:1,kwkCreditUsed:'4',kwkCreditRequested:'4'}],['INVOICE-NOOP',{}],['SHIPPED-NOOP',{status:'versendet',shippedAt:new Date()}],['CANCELLED-NOOP',{status:'storniert',cancelledAt:new Date()}]] as any){
  await seedOrder(id,extra);await movement(id,9002,-1);await pool.query('UPDATE order_items SET is_nasal_spray=true,is_nasal_diy_set=true,is_plug_play=true WHERE order_id=$1',[id]);
 }
 await pool.query("INSERT INTO partner_transactions(partner_id,order_id,type,amount,balance_after,status) VALUES(9,'PARTNER-NOOP','provision',2,2,'storniert'); INSERT INTO kwk_ledger(kwk_id,order_id,type,amount,status) VALUES(1,'KWK-NOOP','redeemed',-4,'confirmed'); INSERT INTO invoices(invoice_number,order_number,date,date_iso,total_gross,html) VALUES('NOOP-INVOICE','INVOICE-NOOP','20.11.2026','2026-11-20',38,'local')");
 const before=await editSnapshot();
 for(const id of ['PAID-NOOP','PARTNER-NOOP','KWK-NOOP','INVOICE-NOOP','SHIPPED-NOOP','CANCELLED-NOOP'])assert.deepEqual(await caller().update(await editPayload(id)),{success:true,unchanged:true});
 assert.deepEqual(await editSnapshot(),before);assert.equal(external,0);
});
test('ACTUAL order.update: legacy missing IDs, item and breakdown reordering, omitted breakdown and subcent normalization are no-op; IDs bind actual rows',async()=>{
 await seedOrder('NORMALIZE',{status:'bezahlt',paidAt:new Date(),subtotal:'40',total:'58',discountCode:'CODE',discountBreakdown:[{source:'manual_global_amount',label:'first',amount:0},{source:'unattributed',label:'second',amount:0}]});
 await db.insert(orderItems).values({orderId:'NORMALIZE',name:'Second',type:'peptide',price:'20',quantity:1,isPlugPlay:true});
 const p=await editPayload('NORMALIZE');const before=await editSnapshot();
 assert((await caller().update({...p,items:[...p.items].reverse(),discountBreakdown:[...p.discountBreakdown].reverse(),subtotal:40.0001,total:58.0001})).unchanged);
 assert((await caller().update({...p,items:p.items.map(({id,...item}:any)=>item),discountBreakdown:undefined})).unchanged);
 assert.deepEqual(await editSnapshot(),before);
 const swapped=p.items.map((item:any,index:number)=>({...item,id:p.items[1-index].id}));
 await assert.rejects(caller().update({...p,items:swapped}),conflict('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED'));
 await assert.rejects(caller().update({...p,items:[{...p.items[0],id:999999},p.items[1]]}),conflict('ORDER_ITEM_ID_CONFLICT'));
 await assert.rejects(caller().update({...p,items:p.items.map((item:any)=>({...item,id:p.items[0].id}))}),conflict('ORDER_ITEM_ID_CONFLICT'));
 for(const change of [{discountCode:'CHANGED'},{discountBreakdown:[{source:'unattributed',label:'changed',amount:0}]},{items:[{...p.items[0],dosage:'changed'},p.items[1]]}])await assert.rejects(caller().update({...p,...change}),conflict('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED'));
 assert.deepEqual(await editSnapshot(),before);
});
test('ACTUAL order.update: all amounts finite/nonnegative before no-op or stock writes, no one-cent tolerance; valid zero and decimal arithmetic',async()=>{
 await seedOrder('AMOUNTS');await pool.query("UPDATE order_items SET article_id=9002 WHERE order_id='AMOUNTS'");await movement('AMOUNTS',9002,-1);
 const p=await editPayload('AMOUNTS');const before=await editSnapshot();
 for(const patch of [{total:38.01},{subtotal:20.01,total:38.01},{total:NaN},{subtotal:Infinity},{shipping:Infinity},{discount:-1},{items:[{...p.items[0],price:-1}]},{items:[{...p.items[0],price:Infinity}]},{items:[{...p.items[0],quantity:2}],subtotal:40,discount:0,shipping:18,total:58.01},{discountBreakdown:[{source:'unattributed',label:'bad',amount:Infinity}]}])await assert.rejects(caller().update({...p,...patch}),(e:any)=>e.code==='BAD_REQUEST');
 assert.deepEqual(await editSnapshot(),before);
 const zero=await caller().update({...p,discount:20,shipping:0,total:0});assert.equal(zero.unchanged,false);
 assert.equal((await pool.query("SELECT total FROM orders WHERE order_id='AMOUNTS'")).rows[0].total,'0.00');
 await seedOrder('DECIMAL',{subtotal:'0.30',shipping:'0.00',total:'0.30'});await pool.query("UPDATE order_items SET price=0.1,quantity=3 WHERE order_id='DECIMAL'");
 const decimal=await editPayload('DECIMAL');assert((await caller().update({...decimal,subtotal:0.1*3,total:0.1*3})).unchanged);
});
test('ACTUAL order.update: unpaid unbooked metadata allows base-neutral edits; canonical snapshot commission sync, legacy missing terms explained, credit intent preserved',async()=>{
 await seedOrder('PARTNER-EDIT',{partnerSourceId:9,partnerCode:'P9',partnerCommission:'2',partnerProgramSnapshot:'partner',partnerCommissionPolicySnapshot:'each_paid_code_order',partnerCommissionPercentSnapshot:'10',partnerCommissionBaseSnapshot:'20'});
 let p=await editPayload('PARTNER-EDIT');await caller().update({...p,shipping:19,total:39});
 p=await editPayload('PARTNER-EDIT');await caller().update({...p,items:[{...p.items[0],price:30}],subtotal:30,total:49});
 const o=(await pool.query("SELECT partner_commission,partner_commission_base_snapshot,partner_discount,partner_code FROM orders WHERE order_id='PARTNER-EDIT'")).rows[0];
 assert.deepEqual(o,{partner_commission:'3.00',partner_commission_base_snapshot:'30.00',partner_discount:'0.00',partner_code:'P9'});assert.equal(await count('partner_transactions'),0);
 await seedOrder('LEGACY-EDIT',{partnerSourceId:9,partnerCode:'P9',partnerCommission:'2'});p=await editPayload('LEGACY-EDIT');
 await caller().update({...p,shipping:19,total:39});
 await assert.rejects(caller().update({...p,items:[{...p.items[0],price:30}],subtotal:30,total:48}),conflict('ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED'));
 await seedOrder('KWK-INTENT',{kwkCreditRequested:'3',kwkCreditUsed:'0',kwkCreditOwnerId:1});p=await editPayload('KWK-INTENT');await caller().update({...p,shipping:19,total:39});
 await assert.rejects(caller().update({...p,discount:3,total:35}),conflict('ORDER_CREDIT_INTENT_EDIT_REVIEW_REQUIRED'));
 for(const key of ['creditUsed','kwkCreditUsed']){const id=`UNCLEAR-${key}`;await seedOrder(id,{[key]:'3'});p=await editPayload(id);await assert.rejects(caller().update({...p,shipping:19,total:39}),conflict('ORDER_CREDIT_INTENT_EDIT_REVIEW_REQUIRED'));}
});
test('ACTUAL order.update: real paid/partner/KWK/referral/external invoice and shipped/cancelled changes conflict with actionable copy; no writes',async()=>{
 await pool.query("INSERT INTO partners(id,name,email,code,partner_number) VALUES(9,'Synthetic','p@example.test','P9','OWN9')");
 for(const [id,extra] of [['PAID-EDIT',{status:'bezahlt',paidAt:new Date()}],['BANK-EDIT',{bunqPaymentId:'local'}],['MATCH-EDIT',{bunqMatchedAt:new Date()}],['LEDGER-EDIT',{}],['KWK-EDIT',{}],['REFERRAL-EDIT',{}],['INVOICE-EDIT',{externalOrderReference:'EXTERNAL'}],['SHIP-EDIT',{status:'versendet',shippedAt:new Date()}],['CANCEL-EDIT',{status:'storniert'}]] as any)await seedOrder(id,extra);
 await pool.query("INSERT INTO partner_transactions(partner_id,order_id,type,amount,balance_after,status) VALUES(9,'LEDGER-EDIT','provision',0,0,'storniert'); INSERT INTO kwk_ledger(kwk_id,order_id,type,amount,status) VALUES(1,'KWK-EDIT','redeemed',0,'confirmed'); INSERT INTO kwk_referrals(kwk_id,order_id) VALUES(1,'REFERRAL-EDIT'); INSERT INTO invoices(invoice_number,order_number,date,date_iso,total_gross,html) VALUES('EDIT-INVOICE','EXTERNAL','20.11.2026','2026-11-20',0,'local')");
 const before=await editSnapshot();for(const id of ['PAID-EDIT','BANK-EDIT','MATCH-EDIT','LEDGER-EDIT','KWK-EDIT','REFERRAL-EDIT','INVOICE-EDIT','SHIP-EDIT','CANCEL-EDIT'])await assert.rejects(caller().update(await editPayload(id,{shipping:19,total:39})),(e:any)=>e.code==='CONFLICT' && /Korrektur|Prüfung/.test(e.message));
 assert.deepEqual(await editSnapshot(),before);
});
test('ACTUAL order.update: successful ordinary monetary edit keeps item IDs and all flags; replacement-stock rollback is atomic',async()=>{
 await seedOrder('STABLE');await pool.query("UPDATE order_items SET article_id=9002,is_nasal_spray=true,is_nasal_diy_set=true,is_plug_play=true WHERE order_id='STABLE'");await movement('STABLE',9002,-1);
 const p=await editPayload('STABLE');const old=(await pool.query("SELECT * FROM order_items WHERE order_id='STABLE'")).rows[0];
 await caller().update({...p,items:[{...p.items[0],price:30}],subtotal:30,total:48});
 const changed=(await pool.query("SELECT * FROM order_items WHERE order_id='STABLE'")).rows[0];assert.deepEqual({...changed,price:old.price},old);assert.equal(await count('stock_history'),1);
 await pool.query('CREATE TRIGGER priority_fail_item BEFORE INSERT OR UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION priority_fail()');const before=await editSnapshot();
 await assert.rejects(caller().update({...p,items:[{...p.items[0],articleId:9001,quantity:2}],subtotal:40,total:58}),/LOCAL_INJECTED|Failed query/);
 assert.deepEqual(await editSnapshot(),before);assert.equal(external,0);
});
test('ACTUAL order.update: concurrent note-only addNote and paid no-op never overwrite notes or financials; auth precedes no-op',async()=>{
 await seedOrder('NOTE-RACE',{status:'bezahlt',paidAt:new Date()});const p=await editPayload('NOTE-RACE');
 await Promise.all([caller().addNote({orderId:'NOTE-RACE',note:'Local synthetic note'}),caller().update(p)]);
 assert.equal((await pool.query("SELECT internal_note FROM orders WHERE order_id='NOTE-RACE'")).rows[0].internal_note,'Local synthetic note');
 for(const user of [null,{id:2,username:'p',role:'product_manager'},{id:3,username:'packing',role:'packing'},{id:4,username:'u',role:'user'}])await assert.rejects(orderRouter.createCaller({req:{headers:{}},res:{},user} as any).update(p),(e:any)=>e.code===(!user?'UNAUTHORIZED':'FORBIDDEN'));
});

test('ACTUAL order.update: duplicate identical legacy rows compare as a multiset; no-op never fires write triggers; one-cent true delta is never rounded away',async()=>{
 await seedOrder('DUPLICATE',{subtotal:'40',total:'58',status:'bezahlt',paidAt:new Date()});await db.insert(orderItems).values({orderId:'DUPLICATE',name:'Original requested variant',type:'peptide',price:'20',quantity:1,isPlugPlay:true});
 const p=await editPayload('DUPLICATE');const before=await editSnapshot();
 await pool.query('CREATE TRIGGER priority_fail_item BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION priority_fail()');
 assert((await caller().update({...p,items:p.items.map(({id,...i}:any)=>i)})).unchanged);assert.deepEqual(await editSnapshot(),before);
 await assert.rejects(caller().update({...p,items:p.items.map((i:any)=>({...i,price:20.01})),subtotal:40.02,total:58.02}),conflict('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED'));
 assert.deepEqual(await editSnapshot(),before);
});
test('ACTUAL order.update: unbooked metadata item edit with explicit ID preserves flags and ID with exact stock replacement; requested KWK base unchanged',async()=>{
 await seedOrder('METADATA-ITEM',{partnerSourceId:9,partnerCode:'P9',kwkCreditRequested:'3',kwkCreditOwnerId:1});
 await pool.query("UPDATE order_items SET article_id=9002,is_nasal_spray=true,is_nasal_diy_set=true,is_plug_play=true WHERE order_id='METADATA-ITEM'");await movement('METADATA-ITEM',9002,-1);
 const p=await editPayload('METADATA-ITEM');await caller().update({...p,items:[{...p.items[0],name:'Actual new article',articleId:9001,price:10,quantity:2}]});
 const i=(await pool.query("SELECT id,is_nasal_spray,is_nasal_diy_set,is_plug_play,article_id,quantity FROM order_items WHERE order_id='METADATA-ITEM'")).rows[0];
 assert.equal(i.id,p.items[0].id);assert.equal(i.is_nasal_spray,true);assert.equal(i.is_nasal_diy_set,true);assert.equal(i.is_plug_play,true);assert.equal(i.article_id,9001);assert.equal(i.quantity,2);
 assert.equal(await stock(9002),4);assert.equal(await stock(9001),8);assert.equal(await count('priority_stock_returns'),1);assert.equal(await count('partner_transactions'),0);assert.equal(await count('kwk_ledger'),0);
 assert.equal((await pool.query("SELECT kwk_credit_requested FROM orders WHERE order_id='METADATA-ITEM'")).rows[0].kwk_credit_requested,'3.00');
});
test('ACTUAL order.update: derived partner discount, explicit override and protected credit breakdown need granular review; zero paid true edit still conflicts',async()=>{
 await seedOrder('DERIVED-DISCOUNT',{partnerSourceId:9,partnerCode:'P9',partnerDiscount:'2',partnerCommission:'2',partnerProgramSnapshot:'partner',partnerCommissionPolicySnapshot:'each_paid_code_order',partnerCommissionPercentSnapshot:'10',partnerCommissionBaseSnapshot:'20'});
 let p=await editPayload('DERIVED-DISCOUNT');await caller().update({...p,shipping:19,total:39});
 await assert.rejects(caller().update({...p,items:[{...p.items[0],price:30}],subtotal:30,total:48}),conflict('ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED'));
 await seedOrder('OVERRIDE',{partnerSourceId:9,partnerCode:'P9',partnerCommission:'2',partnerProgramSnapshot:'partner',partnerCommissionPolicySnapshot:'each_paid_code_order',partnerCommissionPercentSnapshot:'10',partnerCommissionBaseSnapshot:'20'});
 await pool.query("INSERT INTO partner_order_credit_overrides(order_id,amount,reason,is_active) VALUES('OVERRIDE',5,'Local explicit override',1)");p=await editPayload('OVERRIDE');
 await assert.rejects(caller().update({...p,items:[{...p.items[0],price:30}],subtotal:30,total:48}),conflict('ORDER_PARTNER_TERMS_EDIT_REVIEW_REQUIRED'));
 await seedOrder('BREAKDOWN-CREDIT',{discountBreakdown:[{source:'kwk_credit',label:'Intent',amount:0}]});p=await editPayload('BREAKDOWN-CREDIT');
 await assert.rejects(caller().update({...p,discountBreakdown:[]}),conflict('ORDER_CREDIT_INTENT_EDIT_REVIEW_REQUIRED'));
 await seedOrder('PAID-ZERO',{status:'bezahlt',paidAt:new Date(),discount:'20',shipping:'0',total:'0'});p=await editPayload('PAID-ZERO');assert((await caller().update(p)).unchanged);
 await assert.rejects(caller().update({...p,discount:19,total:1}),conflict('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED'));
});

// Nov 25: synthetic catalogue fixtures only, NOT real product definitions/SKUs/prices.
async function separateSetFixture(stockCount=6) {
 await pool.query(`INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,variants)
 VALUES(9020,'LOCAL-ACCESSORY-SET','Synthetic DIY Nasenspray Zubehörset','local-accessory-set',$1,1,1,'Zubehör',13.25,'[]')`,[stockCount]);
 await pool.query(`UPDATE articles SET categories='["Peptide","Nasensprays"]'::jsonb WHERE id=9001`);
 return {name:'Forged peptide kit',shopProductId:'local-accessory-set',price:0.01,quantity:2,type:'peptide'};
}
test('NOV25 actual PG: separate set plus vial quote/receipt/persisted items have same prices/counts/stock, no kit autoposition; replay once',async()=>{
 const set=await separateSetFixture();
 const payload=input({coldShippingRequested:true,items:[{...input().items[0],quantity:4},set]});
 const q=(await rawCaller().quote(payload)).quote;
 assert.equal(q.items.length,3);assert.equal(q.subtotal,106.5);assert.equal(q.discount,8);assert.equal(q.shipping,18);assert.equal(q.total,116.5);
 assert.equal(q.items[1].price,13.25);assert.equal(q.items[1].type,'accessory');assert.equal(q.items[2].quantity,4);
 assert(q.items.every((i:any)=>!i.isNasalDiySet&&!i.isNasalSpray));
 const submitted={...payload,expectedQuoteHash:q.hash};const created=await rawCaller().create(submitted);
 const receipt=(await pool.query('SELECT response FROM priority_checkout_receipts')).rows[0].response;
 const rows=(await pool.query('SELECT name,type,price,quantity,is_nasal_spray,is_nasal_diy_set FROM order_items ORDER BY id')).rows;
 assert.equal(rows.length,q.items.length);assert.deepEqual(rows.map((i:any)=>[i.name,i.type,Number(i.price),i.quantity]),q.items.map((i:any)=>[i.name,i.type,i.price,i.quantity]));
 assert.deepEqual(receipt.quote,JSON.parse(JSON.stringify(q)));assert.equal(receipt.orderSnapshot.items.length,3);
 assert.equal(await stock(),6);assert.equal(await stock(9020),4);assert.equal(await stock(9004),96);assert.equal(await stock(9003),10);
 assert.equal(await count('stock_history'),3);assert(rows.every((i:any)=>!i.is_nasal_spray&&!i.is_nasal_diy_set));
 const before=await pool.query('SELECT * FROM stock_history ORDER BY id');const replay=await rawCaller().create(submitted);
 assert.equal(replay.orderId,created.orderId);assert.deepEqual((await pool.query('SELECT * FROM stock_history ORDER BY id')).rows,before.rows);
 assert.equal(await count('orders'),1);assert.equal(await count('priority_checkout_receipts'),1);assert.equal(external,0);
});
test('NOV25 actual PG: standalone set gets no BAC/quantity discount/SmartSub, stock shortage fails closed without unpacking',async()=>{
 const set=await separateSetFixture(4);const payload=input({items:[{...set,quantity:4}]});
 const q=(await rawCaller().quote(payload)).quote;assert.equal(q.items.length,1);assert.equal(q.subtotal,53);assert.equal(q.discount,0);
 await rawCaller().create({...payload,expectedQuoteHash:q.hash});assert.equal(await stock(9020),0);assert.equal(await stock(9004),100);assert.equal(await stock(9003),10);assert.equal(await count('stock_history'),1);
 await pool.query('UPDATE substitution_config SET enabled=true WHERE id=1');
 await assert.rejects(rawCaller().quote(input({items:[set],checkoutIdempotencyKey:'b'.repeat(64)})),/CHECKOUT_STOCK_DEMAND_NOT_COVERED/);
 assert.equal(await count('orders'),1);assert.equal(external,0);
});
for(const flags of [{isNasalSpray:true},{isNasalDiySet:true},{isNasalSpray:true,isNasalDiySet:true},{variant:'[Nasenspray]'},{variant:'DIY-Set'}])test(`NOV25 actual PG retired request ${JSON.stringify(flags)} quote/create reject before writes`,async()=>{
 const clean=input();const q=(await rawCaller().quote(clean)).quote;const payload=input({items:[{...clean.items[0],...flags}],expectedQuoteHash:q.hash});
 await assert.rejects(rawCaller().quote(payload),/CHECKOUT_NASAL_FORMAT_RETIRED/);
 await assert.rejects(rawCaller().create(payload),/CHECKOUT_NASAL_FORMAT_RETIRED/);
 assert.equal(await count('orders'),0);assert.equal(await count('priority_checkout_receipts'),0);assert.equal(await count('stock_history'),0);assert.equal(await stock(),10);assert.equal(await stock(9003),10);assert.equal(external,0);
});
for(const prepared of ['primary','name','hidden-child'])test(`NOV25 actual PG prepared nasal ${prepared} not remapped to vials`,async()=>{
 const q=(await rawCaller().quote(input())).quote;let payload=input({expectedQuoteHash:q.hash});
 if(prepared==='primary')await pool.query("UPDATE articles SET category='Nasensprays' WHERE id=9001");
 if(prepared==='name')await pool.query("UPDATE articles SET name='Ready Nasenspray (10 mg)' WHERE id=9001");
 if(prepared==='hidden-child'){
  payload=await smartSubFixture(2);await pool.query("UPDATE articles SET name='Ready Nasenspray (20 mg)' WHERE id=9010");payload.expectedQuoteHash=q.hash;
 }
 await assert.rejects(rawCaller().quote(payload),/CHECKOUT_PREPARED_NASAL_NOT_SELLABLE/);await assert.rejects(rawCaller().create(payload),/CHECKOUT_PREPARED_NASAL_NOT_SELLABLE/);
 assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);assert.equal(external,0);
});
test('NOV25 actual PG catalog set price changed after quote conflicts; final lock detects prepared conversion before order number/stock',async()=>{
 const set=await separateSetFixture();const payload=input({items:[input().items[0],set]});const q=(await rawCaller().quote(payload)).quote;
 await pool.query('UPDATE articles SET selling_price=14 WHERE id=9020');
 await assert.rejects(rawCaller().create({...payload,expectedQuoteHash:q.hash}),/CHECKOUT_QUOTE_CHANGED/);
 await pool.query('UPDATE articles SET selling_price=13.25 WHERE id=9020');
 const original=db.transaction.bind(db);let changed=false;const intercept=mock.method(db,'transaction',async(...args:any[])=>{
  if(!changed){changed=true;await pool.query("UPDATE articles SET category='Nasensprays' WHERE id=9001");}return original(...args);
 });
 try{await assert.rejects(rawCaller().create({...payload,expectedQuoteHash:q.hash}),/CHECKOUT_QUOTE_CHANGED/);}finally{intercept.mock.restore();}
 assert(changed);assert.equal(await count('orders'),0);assert.equal(await count('priority_checkout_receipts'),0);assert.equal(await count('stock_history'),0);assert.equal(await stock(9020),6);assert.equal(external,0);
});
test('NOV25 actual PG secondary nasal tags preserve SmartSub and BAC with separate set, no cold note',async()=>{
 const payload=await smartSubFixture(2);const set=await separateSetFixture();payload.items.push({...set,quantity:1});payload.coldShippingRequested=true;
 const q=(await rawCaller().quote(payload)).quote;assert.equal(q.items.length,3);assert.equal(q.subtotal,53.25);assert.equal(q.shipping,18);assert.equal(q.total,71.25);
 const out=await rawCaller().create({...payload,expectedQuoteHash:q.hash});assert.equal(await stock(),0);assert.equal(await stock(9020),5);assert.equal(await stock(9004),99);assert.equal(await stock(9003),10);
 const note=(await pool.query('SELECT internal_note FROM orders WHERE order_id=$1',[out.orderId])).rows[0].internal_note;
 assert.doesNotMatch(note,/Kühlversand/);assert.match(note,/Smart Substitution/);assert.equal(external,0);
});
test('NOV25 actual PG exclusive main campaign retains 36.9%, blocks benefit stacking and suppresses tiers/2for3, no cold surcharge',async()=>{
 await pool.query(`INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1),('promo_2for3_enabled','true'),('promo_2for3_products','[]')`,[JSON.stringify({enabled:true,percentage:36.9,startsAt:null,expiresAt:'2099-01-01T00:00:00Z',freeShippingEnabled:true,freeShippingMinOrder:0,freeShippingRegions:['ch'],exclusiveCampaign:true,coldShippingSurcharge:15,freeBacWaterPerPaidVial:true,stackWithPromotionCodes:false,stackWithPartnerCreatorCodes:false,stackWithKwk:false,labelDe:'Synthetic exclusive',labelEn:'Synthetic exclusive'})]);
 const payload=input({coldShippingRequested:true,items:[{...input().items[0],quantity:4}]});const q=(await rawCaller().quote(payload)).quote;
 assert.equal(q.subtotal,80);assert.equal(q.discount,29.52);assert.equal(q.shipping,0);assert.equal(q.items.length,2);assert.equal(q.items[1].quantity,4);
 assert.equal(q.discountBreakdown.some((i:any)=>i.source==='quantity_discount'),false);
 await assert.rejects(rawCaller().quote({...payload,discountCode:'OTHER'}),/exklusiv/);
 await rawCaller().create({...payload,expectedQuoteHash:q.hash});assert.equal(await stock(),6);assert.equal(await stock(9004),96);assert.equal(external,0);
});
