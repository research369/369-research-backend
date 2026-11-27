import assert from "node:assert/strict";
import test, {before, beforeEach, after, mock} from "node:test";
import {ENV} from "./env.js";
import {closeDb, getDb, getPool} from "./db.js";
import {orderRouter, createOrderSchema} from "./orderRouter.js";
import {checkoutFingerprint, ensurePriorityOrderIntegritySchema} from "./priorityOrderIntegrity.js";
import {ensureGoodieSchema} from "./goodieSchema.js";
import {ensureAdminChangeLogSchema} from "./adminChangeLogService.js";
import {ensureCustomerOrderBlockSchema} from "./customerOrderBlockService.js";
import {ensurePermissionsSchema} from "./permissionsSchema.js";
import {ensureAccountSecuritySchema} from "./accountSecuritySchema.js";
import {ensurePartnerFinancialSchema} from "./partnerFinancialSchema.js";
import {ensureCustomerDataChangeSchema} from "./customerDataChangeService.js";

// Parent owns initdb/start/base schema generation. This suite never starts a DB,
// installs packages, reads ordinary DB URLs, or contacts a provider.
// Explicit synthetic DB name prevents truncating other local test databases.
const local = process.env.PRECISION_TEST_DATABASE_URL;
const enabled = process.env.PRECISION_SYNTHETIC_POSTGRES_TESTS === "true";
const checkedLocal = () => {
  assert(local, "PRECISION_TEST_DATABASE_URL required");
  const u=new URL(local);
  assert(["localhost","127.0.0.1","[::1]"].includes(u.hostname), "only loopback PostgreSQL allowed");
  assert.equal(u.pathname,"/precision_synthetic_test", "dedicated precision_synthetic_test DB required");
  assert(!u.password,"synthetic trust-auth DB only");
  return local;
};
let pool:any, external=0;
const key="synthetic-precision-pg-gateway-00000000000000000000";
const caller=(scoped=true)=>orderRouter.createCaller({req:{headers:scoped?{"x-369-precision-commerce-key":key}:{}},res:{},user:null} as any);
const request=(extra:any={})=>({
  storeKey:"369research",orderSource:"shop",communicationLanguage:"de",checkoutIdempotencyKey:"a".repeat(64),
  items:[{name:"Browser name",shopProductId:"semax",dosage:"10 mg",quantity:1,price:0.01,type:"peptide",isNasalSpray:true,isNasalDiySet:true,isPlugPlay:false}],
  customer:{firstName:"Synthetic",lastName:"Precision",email:"precision@example.test",phone:"030123456789",street:"Synthetic",houseNumber:"1",zip:"10115",city:"Berlin",country:"DE"},
  subtotal:0.01,discount:0,discountCode:null,shipping:0,shippingCountry:"de",total:0.01,paymentMethod:"SEPA",date:"2026-11-27",...extra,
} as any);
async function tableCount(table:string){return Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);}
async function stocks(){return (await pool.query("SELECT sku,stock FROM articles ORDER BY id")).rows;}
async function quoted(r:any=request()) {const q=await caller().quote(r);return {...r,expectedQuoteHash:q.quote.hash};}

before(async()=>{
  if(!enabled)return;
  assert.equal(process.env.DATABASE_URL || "","");assert.equal(process.env.RAILWAY_DB_URL || "","");
  for(const name of ["RESEND_API_KEY","BUNQ_API_KEY","DHL_API_KEY","DHL_TRACKING_API_KEY","FORGE_API_KEY"])assert.equal(process.env[name] || "","");
  await closeDb();ENV.databaseUrl=checkedLocal();ENV.resendApiKey="";ENV.bunqApiKey="";ENV.dhlApiKey="";ENV.dhlTrackingApiKey="";ENV.forgeApiKey="";
  process.env.PRECISION_COMMERCE_ENABLED="true";process.env.PRECISION_COMMERCE_GATEWAY_KEY=key;
  mock.method(globalThis,"fetch",async()=>{external++;throw Error("PRECISION_EXTERNAL_PROVIDER_FORBIDDEN");});
  pool=await getPool();await getDb();assert.equal((await pool.query("SELECT current_database() AS name")).rows[0].name,"precision_synthetic_test");
  await pool.query(`CREATE TABLE IF NOT EXISTS substitution_config(id integer primary key,enabled boolean);
    INSERT INTO substitution_config VALUES(1,false) ON CONFLICT DO NOTHING;
    CREATE SEQUENCE IF NOT EXISTS precision_test_order_seq;
    CREATE OR REPLACE FUNCTION next_order_id() RETURNS text LANGUAGE sql AS $$ SELECT 'PRECISION-TEST-' || nextval('precision_test_order_seq')::text $$;`);
  await ensureCustomerOrderBlockSchema();await ensureGoodieSchema();await ensureAdminChangeLogSchema();await ensurePriorityOrderIntegritySchema();
  await ensurePermissionsSchema();await ensureAccountSecuritySchema();await ensurePartnerFinancialSchema();await ensureCustomerDataChangeSchema();
});
beforeEach(async()=>{
  if(!enabled)return;external=0;
  await pool.query(`DROP TRIGGER IF EXISTS precision_fail_item ON order_items;
    TRUNCATE customer_data_change_confirmations,customer_data_change_events,goodie_assignments,priority_stock_returns,priority_order_actions,priority_order_tasks,priority_checkout_receipts,stock_history,order_items,orders,customers,articles,partners,partner_programs,kwk_accounts,partner_transactions,kwk_ledger,kwk_referrals,invoices,shop_settings,promo_codes,bundle_items,bundles CASCADE;
    UPDATE substitution_config SET enabled=false WHERE id=1;
    INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,sale_price,variants)
    VALUES(9001,'SEMAX-10MG','Synthetic Semax (10 mg)','semax',10,1,1,'Peptide',20,0,'[]'),
      (9002,'RETATRUTIDE-10MG','Synthetic Triple (10 mg)','3g-triple-g',10,1,1,'Peptide',50,0,'[]'),
      (9003,'BAC-10ML','Synthetic BAC Wasser (10 ml)','bac-wasser',10,1,1,'Zubehör',5,0,'[]'),
      (9004,'BAC-3ML','Synthetic BAC Wasser 3ml','bac-wasser-3ml',100,1,1,'Zubehör',4,0,'[]');
    INSERT INTO customers(id,customer_number,name,first_name,last_name,email,phone,street,house_number,zip,city,country)
    VALUES(9001,'999001','Synthetic Precision','Synthetic','Precision','precision@example.test','030123456789','Synthetic','1','10115','Berlin','DE');
    INSERT INTO shop_settings(key,value) VALUES('address_validation_enabled','false');`);
  // Prevent all postcommit provider work while retaining durable obligations.
  await pool.query(`CREATE OR REPLACE FUNCTION precision_tasks_no_provider() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    DROP TRIGGER IF EXISTS precision_task_claim_block ON priority_order_tasks;
    CREATE TRIGGER precision_task_claim_block BEFORE UPDATE ON priority_order_tasks FOR EACH ROW EXECUTE FUNCTION precision_tasks_no_provider();`);
});
after(async()=>{if(enabled){await closeDb();ENV.databaseUrl="";mock.restoreAll();}});
const pgtest=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!enabled},fn);
pgtest("PG precision quote is read-only; real create/receipt has +7 kit and one BAC10",async()=>{
  const before=await stocks(),q=await caller().quote(request());assert.equal(q.quote.subtotal,27);assert.equal(q.quote.shipping,8);
  assert.deepEqual(await stocks(),before);for(const t of ["orders","order_items","stock_history","priority_checkout_receipts"])assert.equal(await tableCount(t),0);
  const r={...request(),expectedQuoteHash:q.quote.hash},out=await caller().create(r);assert("total" in out);assert.equal(out.total,35);
  const rows=(await pool.query("SELECT name,price,quantity,article_id,is_nasal_spray,is_nasal_diy_set,is_plug_play FROM order_items ORDER BY id")).rows;
  assert.equal(rows.length,4);assert.equal(rows[0].is_nasal_spray,true);assert.equal(rows[0].is_nasal_diy_set,true);assert.equal(rows[0].is_plug_play,false);assert.equal(rows.filter((r:any)=>r.name.includes("BAC Wasser")).length,1);
  assert.deepEqual(await stocks(),[{sku:"SEMAX-10MG",stock:9},{sku:"RETATRUTIDE-10MG",stock:10},{sku:"BAC-10ML",stock:9},{sku:"BAC-3ML",stock:100}]);
  const recovered=await caller().checkoutReceipt({checkoutIdempotencyKey:r.checkoutIdempotencyKey,payloadFingerprint:checkoutFingerprint(createOrderSchema.parse(r))});assert.equal(recovered.state,"committed");if(recovered.state==="committed"){assert.equal(recovered.receipt.orderId,out.orderId);assert.equal(recovered.receipt.quote.hash,q.quote.hash);assert(recovered.receipt.customer);}
  assert.equal(external,0);
});
pgtest("PG precision aggregate paid BAC10 + kit makes one journal entry",async()=>{
  const r=request({items:[...request().items,{name:"BAC",shopProductId:"bac-wasser",dosage:"10 ml",quantity:2,price:0,type:"accessory"}]}),out=await caller().create(await quoted(r));
  const moves=(await pool.query("SELECT article_id,count(*)::int AS movements,sum(quantity_change)::int AS change FROM stock_history WHERE order_id=$1 GROUP BY article_id ORDER BY article_id",[out.orderId])).rows;
  assert.deepEqual(moves,[{article_id:9001,movements:1,change:-1},{article_id:9003,movements:1,change:-3}]);
});
pgtest("PG precision same-key race/replay creates exactly one order and journal",async()=>{
  const r=await quoted(),[a,b]=await Promise.all([caller().create(r),caller().create(r)]);assert.equal(a.orderId,b.orderId);assert.equal(await tableCount("orders"),1);assert.equal(await tableCount("priority_checkout_receipts"),1);assert.equal(await tableCount("stock_history"),2);
  await caller().create({...r,date:"2027-01-01",expectedQuoteHash:"b".repeat(64)});assert.equal(await tableCount("stock_history"),2);
  await assert.rejects(caller().create({...r,items:[{...r.items[0],quantity:2}]}),/CHECKOUT_INTENT_CONFLICT/);
  await assert.rejects(caller(false).create(r),/CHECKOUT_INTENT_CONFLICT/);
});
pgtest("PG precision last BAC10 competing customers cannot oversell",async()=>{
  await pool.query("UPDATE articles SET stock=1 WHERE id=9003");
  const a=await quoted(),b=await quoted(request({checkoutIdempotencyKey:"b".repeat(64),customer:{...request().customer,email:"second@example.test",phone:"030987654321"}}));
  const results=await Promise.allSettled([caller().create(a),caller().create(b)]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(await tableCount("orders"),1);assert.equal(await tableCount("priority_checkout_receipts"),1);assert.equal((await pool.query("SELECT stock FROM articles WHERE id=9003")).rows[0].stock,0);
});
pgtest("PG precision changed BAC10 price/identity/stock forces requote without partial writes",async()=>{
  for(const change of ["UPDATE articles SET selling_price=8 WHERE id=9003","UPDATE articles SET stock=0 WHERE id=9003","UPDATE articles SET shop_product_id='changed' WHERE id=9003"]){
    const r=await quoted();await pool.query(change);await assert.rejects(caller().create(r),/QUOTE_CHANGED|BAC10|STOCK_DEMAND/);assert.equal(await tableCount("orders"),0);assert.equal(await tableCount("stock_history"),0);
    await pool.query("UPDATE articles SET selling_price=5,stock=10,shop_product_id='bac-wasser' WHERE id=9003");
  }
});
pgtest("PG precision item failure rolls back all stock/order/receipt and retry works once",async()=>{
  const r=await quoted(),before=await stocks();await pool.query(`CREATE OR REPLACE FUNCTION precision_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PRECISION_ROLLBACK'; END $$;
    CREATE TRIGGER precision_fail_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION precision_fail_insert();`);
  await assert.rejects(caller().create(r));assert.deepEqual(await stocks(),before);for(const t of ["orders","stock_history","priority_checkout_receipts"])assert.equal(await tableCount(t),0);
  await pool.query("DROP TRIGGER precision_fail_item ON order_items");await caller().create(r);assert.equal(await tableCount("orders"),1);assert.equal(await tableCount("stock_history"),2);
});
pgtest("PG ordinary flow remains vial-only; precision cartridge +15 is whitelist-bound",async()=>{
  await assert.rejects(caller(false).quote(request()),/NASAL_FORMAT_RETIRED/);
  const r=request({items:[{...request().items[0],shopProductId:"3g-triple-g",isPlugPlay:true,isNasalSpray:false,isNasalDiySet:false}]}),q=await caller().quote(r);assert.equal(q.quote.subtotal,65);assert.equal(q.quote.shipping,8);assert.equal(q.quote.items.length,1);
  await caller().create({...r,expectedQuoteHash:q.quote.hash});assert.equal((await pool.query("SELECT stock FROM articles WHERE id=9003")).rows[0].stock,10);assert.equal(external,0);
});
pgtest("PG precision changed-customer quote never writes, separate confirmation is consumed on create",async()=>{
  const r=request({customer:{...request().customer,street:"New synthetic street"}}),q=await caller().quote(r);
  assert.equal(q.customerDataChangeConfirmation?.requiresConfirmation,true);assert.equal(q.customerDataChangeConfirmation?.confirmationToken,null);assert.equal(await tableCount("customer_data_change_confirmations"),0);assert.equal(await tableCount("orders"),0);
  const preview=await caller().checkoutCustomerConfirmation({storeKey:"369research",orderSource:"shop",customer:r.customer});assert(preview.requiresConfirmation);assert(preview.confirmationToken);assert.equal(await tableCount("customer_data_change_confirmations"),1);assert.equal(await tableCount("orders"),0);assert.equal(await tableCount("stock_history"),0);
  const out=await caller().create({...r,expectedQuoteHash:q.quote.hash,customerDataChangeConfirmationToken:preview.confirmationToken});assert(out.success);assert.equal(await tableCount("orders"),1);assert.equal(await tableCount("customer_data_change_events"),1);
  const record=(await pool.query("SELECT consumed_at FROM customer_data_change_confirmations")).rows[0];assert(record.consumed_at);assert.equal(external,0);
  await assert.rejects(caller(false).checkoutCustomerConfirmation({storeKey:"369research",orderSource:"shop",customer:r.customer}),/SCOPE_REQUIRED/);
});
