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
// ONLY dedicated reserved local PostgreSQL; no env URL, HTTP or provider keys.
const local = 'postgresql://priority_local@127.0.0.1:56439/postgres';
let pool:any, db:any, external=0;
function caller() {return orderRouter.createCaller({req:{headers:{}},res:{},user:{id:1,username:'local-admin',role:'admin'}} as any);}
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
  await pool.query(`CREATE TABLE IF NOT EXISTS kwk_ledger(id serial primary key,kwk_id integer,order_id varchar(32),amount numeric,type text,status text,note text,created_by text);
    CREATE TABLE IF NOT EXISTS kwk_referrals(id serial primary key,order_id varchar(32),status text);
    CREATE TABLE IF NOT EXISTS substitution_config(id integer primary key,enabled boolean);
    INSERT INTO substitution_config VALUES(1,false) ON CONFLICT DO NOTHING;
    CREATE SEQUENCE IF NOT EXISTS priority_test_order_seq;
    CREATE OR REPLACE FUNCTION next_order_id() RETURNS text LANGUAGE sql AS $$ SELECT 'TEST-' || nextval('priority_test_order_seq')::text $$;`);
  await ensureCustomerOrderBlockSchema();await ensureGoodieSchema();await ensureAdminChangeLogSchema();await ensurePriorityOrderIntegritySchema();
  await ensurePriorityOrderIntegritySchema(); // idempotent migration repeat
});
beforeEach(async()=>{
 external=0;
 await pool.query(`DROP TRIGGER IF EXISTS priority_fail_item ON order_items;
   DROP TRIGGER IF EXISTS priority_fail_delete ON orders;
   TRUNCATE goodie_assignments,priority_stock_returns,priority_order_actions,priority_order_tasks,priority_checkout_receipts,stock_history,order_items,orders,customers,articles,partner_transactions,kwk_ledger,kwk_referrals,invoices,shop_settings CASCADE;
   INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,sale_price,variants)
   VALUES(9001,'SYNTHETIC-10MG','Synthetic (10 mg)','synthetic',10,1,1,'Peptide',20,0,'[]'),
   (9002,'SUBSTITUTED-5MG','Actual replacement (5 mg)','replacement',4,1,1,'Peptide',10,0,'[]'),
   (9003,'BAC-10ML','Actual BAC','bac-wasser',10,1,1,'Zubehör',5,0,'[]');
   INSERT INTO customers(id,customer_number,name,first_name,last_name,email,phone,street,house_number,zip,city,country)
   VALUES(9001,'999001','Synthetic Owner','Synthetic','Owner','synthetic@example.test','+41790000000','Local','1','8000','Local','CH');
   INSERT INTO shop_settings(key,value) VALUES('address_validation_enabled','false');`);
});
after(async()=>{await closeDb();ENV.databaseUrl='';mock.restoreAll();});
async function count(table:string) {return Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);}
async function stock(id=9001) {return (await pool.query('SELECT stock FROM articles WHERE id=$1',[id])).rows[0].stock;}
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
 assert.equal(a.orderId,b.orderId);assert.equal(await count('orders'),1);assert.equal(await count('priority_checkout_receipts'),1);assert.equal(await count('stock_history'),1);assert.equal(await stock(),9);assert.equal(external,0);
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
 await assert.rejects(caller().create(input({items:[input().items[0],input().items[0]],subtotal:40,total:58})),/ORDER_STOCK_DEMAND_NOT_COVERED/);
 assert.equal(await count('orders'),0);assert.equal(await stock(),1);assert.equal(await count('stock_history'),0);
});
test('actual public router: client accessory type cannot bypass catalog peptide inventory',async()=>{
 await caller().create(input({items:[{...input().items[0],type:'accessory'}]}));assert.equal(await stock(),9);
});
test('actual router: legacy no-key remains callable',async()=>{
 await caller().create(input({checkoutIdempotencyKey:undefined}));assert.equal(await count('orders'),1);
});
test('actual router: cancellation returns exact replacement and BAC movements once under race',async()=>{
 await seedOrder();const a=await movement('RETURN',9002,-2);const b=await movement('RETURN',9003,-1);
 // Negative local correction is not a sale and must never be returned.
 await movement('RETURN',9001,-3,'korrektur');
 const [x,y]=await Promise.all([caller().cancel({orderId:'RETURN',restock:true,reason:'Local explicit cancellation'}),caller().cancel({orderId:'RETURN',restock:true,reason:'Local explicit cancellation'})]);
 assert.equal(x.restoredStock+y.restoredStock,3);assert.equal(await stock(9002),4);assert.equal(await stock(9003),10);assert.equal(await stock(),7);
 assert.equal(await count('priority_stock_returns'),2);assert.deepEqual((await pool.query('SELECT original_movement_id FROM priority_stock_returns ORDER BY original_movement_id')).rows.map((r:any)=>r.original_movement_id),[a,b]);
 assert.equal(x.financialRepairRequired,true);assert.equal((await pool.query("SELECT state FROM priority_order_tasks WHERE order_id='RETURN' AND task='financial_cancellation'")).rows[0].state,'repair_required');
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
 await seedOrder();await pool.query(`CREATE TRIGGER priority_fail_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION priority_fail()`);
 await assert.rejects(caller().update({orderId:'RETURN',items:[{name:'Original requested variant',type:'peptide',price:30,quantity:1}],subtotal:30,discount:0,shipping:18,total:48}));
 assert.equal((await pool.query("SELECT total FROM orders WHERE order_id='RETURN'")).rows[0].total,'38.00');assert.equal(await count('order_items'),1);
 await pool.query("UPDATE orders SET paid_at=now() WHERE order_id='RETURN'");
 await assert.rejects(caller().update({orderId:'RETURN',items:[{name:'Original requested variant',type:'peptide',price:20,quantity:1}],subtotal:20,discount:0,shipping:18,total:38}),/FINANCIAL_CORRECTION_REVIEW/);
});

test('actual router: positive local correction never becomes an automatic second return',async()=>{
 await seedOrder();await movement('RETURN',9002,-2);await movement('RETURN',9002,1,'korrektur');
 await assert.rejects(caller().cancel({orderId:'RETURN',restock:true,reason:'Local explicit cancellation'}),/ORDER_STOCK_HISTORY_REVIEW_REQUIRED/);assert.equal(await count('priority_stock_returns'),0);
});
test('actual router: status-only cancellation does not silently restock and persists financial repair',async()=>{
 await seedOrder();await movement('RETURN',9002,-2);
 const r=await caller().updateStatus({orderId:'RETURN',status:'storniert'});
 assert.equal(r.success,true);assert.equal(r.financialRepairRequired,true);assert.equal(await stock(9002),2);assert.equal(await count('priority_stock_returns'),0);
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
