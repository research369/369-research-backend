import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { ENV } from "./env.js";
import { closeDb } from "./db.js";
import { partnerRouter } from "./partnerRouter.js";
import { kwkRouter } from "./kwkRouter.js";
import { createKwkToken } from "./kwkAuth.js";
import { ensurePartnerFinancialSchema, isPartnerFinancialSchemaReady } from "./partnerFinancialSchema.js";
import { createPartnerCreditTransactionQueryClient } from "./partnerCreditTransactionQuery.js";
import { redeemPartnerCreditInTransaction, reversePartnerFinancialEntriesForCancelledOrder, bookPaidPartnerCommission, type PartnerCreditQueryClient } from "./partnerCreditService.js";
import { cancelCreditInTransaction, redeemCreditInTransaction, syncKwkAccountCache, releaseCredit, bookPendingCredit, partialRefundCredit } from "./kwkService.js";
import { hasOtherPaidCodeOrder } from "./partnerCodeHistory.js";
import { updatePartnerTransactionStatus, recordPartnerPayout, previewHistoricalPartnerClaim, bookHistoricalPartnerClaim, type HistoricalPartnerClaimInput } from "./partnerFinancialAdminService.js";
import { correctOperationsPartnerCredit } from "./operationsPartnerCredit.js";

const enabled = process.env.LEDGER_LOCAL_POSTGRES === "true";
const url = "postgresql://ledger@127.0.0.1:55448/ledger_isolated";
// Never consumes DATABASE_URL. Fixed reserved loopback database only; no production fallback.
const pool = new pg.Pool({ connectionString: url, max: 8 });
const run = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled, timeout: 15000 }, fn);
const originalUrl = ENV.databaseUrl;
const originalFetch = globalThis.fetch;
let externalCalls = 0;
async function tx<T>(fn: (c: PartnerCreditQueryClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query("SET LOCAL statement_timeout='8000ms'"); const result = await fn(client); await client.query("COMMIT"); return result; }
  catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
async function balance(id=9) { return Number((await pool.query("SELECT credit_balance FROM partners WHERE id=$1", [id])).rows[0].credit_balance); }
async function seedOrder(id: string, values: Record<string, unknown> = {}) {
  const row = { order_id: id, first_name: "Synthetic", last_name: "Only", email: "owner@example.invalid", status: "offen", subtotal: 100, discount: 0, total: 100,
    order_date: new Date("2026-10-01T00:00:00Z"), shipping: 0, shipping_country: "DE", payment_method: "SEPA", phone: "", street: "Test", house_number: "1", zip: "00000", city: "Synthetic", country: "Deutschland",
    partner_source_id: 9, partner_number: "OWN9", partner_program_snapshot: "partner", partner_settlement_method_snapshot: "shop_credit", partner_commission_policy_snapshot: "each_paid_code_order",
    partner_commission_percent_snapshot: 10, partner_commission_base_snapshot: 100, partner_commission: 10, credit_used: 0, kwk_credit_used: 0, kwk_credit_requested: 0, ...values };
  const keys = Object.keys(row);
  await pool.query(`INSERT INTO orders(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`, Object.values(row));
}
async function partnerEntry(orderId: string, type: string, amount: number, status='normal', owner=9) {
  const result = await pool.query(`INSERT INTO partner_transactions(partner_id,order_id,type,amount,balance_after,status) VALUES($1,$2,$3,$4,100,$5) RETURNING id`, [owner,orderId,type,amount,status]);
  return Number(result.rows[0].id);
}
async function kwkEntry(orderId: string | null, type: string, amount: number, status='confirmed', owner=1) {
  await pool.query("INSERT INTO kwk_ledger(kwk_id,order_id,type,amount,status) VALUES($1,$2,$3,$4,$5)", [owner,orderId,type,amount,status]);
}
function adminContext(role="admin"): any {
  return { req: { headers: {} }, res: {}, user: { id: 1, username: "synthetic-admin", role, email: null, name: null } };
}
const defaultClaim = (orderId: string, amount=9): HistoricalPartnerClaimInput => ({ orderId, partnerId: 9, amount, expectedBalance: 100, percent: 10, mode: "evidenced_ten_percent", requestId: randomUUID(), reason: "synthetic evidenced historical contract", evidenceReference: "fixture:contract-v1" });

before(async () => {
  if (!enabled) return;
  assert.equal(process.env.DATABASE_URL, "");
  assert.equal(process.env.DOTENV_CONFIG_PATH, "/dev/null");
  globalThis.fetch = async () => { externalCalls++; throw new Error("EXTERNAL_HTTP_FORBIDDEN"); };
  // Schema is generated from THIS worktree's actual Drizzle definitions; actual enums/FKs/numerics/indexes.
  const schema = await readFile(new URL("../tests/fixtures/ledger-current-schema.sql", import.meta.url), "utf8");
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await pool.query(schema);
  await tx(c => ensurePartnerFinancialSchema(c));
  ENV.databaseUrl = url; // only fixed disposable target for existing standalone/router tests
  process.env.FEATURE_KWK_ENABLED = "true";
});
beforeEach(async () => {
  if (!enabled) return;
  // Immutable claim table is protected even in tests. Fresh schema ownership can TRUNCATE fixtures.
  await pool.query("TRUNCATE partner_historical_claims, partner_transactions, kwk_ledger, kwk_referrals, orders, partner_codes, partners, kwk_accounts, partner_programs RESTART IDENTITY CASCADE");
  await pool.query(`INSERT INTO partner_programs(key,label,customer_discount_policy,commission_policy,settlement_method,allow_self_order_credit,active) VALUES
    ('partner','Partner','first_paid_code_use','first_paid_code_order','shop_credit',true,true),
    ('creator','Creator','each_valid_code_use','each_paid_code_order','payout',false,true),
    ('none','None','each_valid_code_use','none','none',false,true)`);
  await pool.query(`INSERT INTO partners(id,name,email,code,partner_number,credit_balance,program_key) VALUES(9,'Synthetic','owner@example.invalid','TEST','OWN9',100,'partner'),(4,'Synthetic other','other@example.invalid','OTHER','OWN4',100,'creator')`);
  await pool.query(`INSERT INTO partner_codes(partner_id,display_code,code_normalized,commission_percent,customer_discount_percent) VALUES(9,'TEST','TEST',10,10),(4,'OTHER','OTHER',5,10)`);
  await pool.query(`INSERT INTO kwk_accounts(id,kwk_number,referral_code,name,email,phone,password_hash) VALUES(1,'KWK-1','KWK-1','Synthetic','kwk1@example.invalid','1','unused'),(2,'KWK-2','KWK-2','Synthetic','kwk2@example.invalid','2','unused')`);
});
after(async () => {
  if (enabled) { assert.equal(externalCalls,0); ENV.databaseUrl = originalUrl; globalThis.fetch = originalFetch; await closeDb(); }
  await pool.end();
});

run("migration replay preserves original balances and owners; claims immutable and indexes global", async () => {
  await seedOrder('migration'); await partnerEntry('migration','provision',7);
  await tx(c => ensurePartnerFinancialSchema(c)); await tx(c => ensurePartnerFinancialSchema(c));
  assert.equal(isPartnerFinancialSchemaReady(),true); assert.equal(await balance(),100);
  assert.equal((await pool.query("SELECT kwk_credit_owner_id FROM orders")).rows[0].kwk_credit_owner_id,null);
  await kwkEntry('migration','redeemed',-5); await assert.rejects(kwkEntry('migration','redeemed',-5,'confirmed',2), /duplicate key/);
});
run("admin transaction cancellation replay and competing cancellation create no negative normal corrections", async () => {
  await seedOrder('status'); const id = await partnerEntry('status','provision',10);
  const results = await Promise.all([tx(c => updatePartnerTransactionStatus({transactionId:id,status:'storniert'},c)),tx(c => updatePartnerTransactionStatus({transactionId:id,status:'storniert'},c))]);
  assert.equal(results.filter(r=>!r.alreadyApplied).length,1); assert.equal(await balance(),90);
  assert.equal((await pool.query("SELECT COUNT(*)::int count FROM partner_transactions")).rows[0].count,1);
  await tx(c => updatePartnerTransactionStatus({transactionId:id,status:'nicht_gewertet'},c)); assert.equal(await balance(),90);
  await tx(c => updatePartnerTransactionStatus({transactionId:id,status:'normal'},c)); assert.equal(await balance(),100);
  await tx(c => updatePartnerTransactionStatus({transactionId:id,status:'ausgeblendet'},c)); assert.equal(await balance(),90);
});
run("admin cancellation restores negative redemption and fully rolls back on caller failure", async () => {
  await seedOrder('statusneg'); const id = await partnerEntry('statusneg','einloesung',-10);
  await assert.rejects(tx(async c => { await updatePartnerTransactionStatus({transactionId:id,status:'storniert'},c); throw Error('injected'); }), /injected/);
  assert.equal(await balance(),100); assert.equal((await pool.query("SELECT status FROM partner_transactions WHERE id=$1",[id])).rows[0].status,'normal');
  await tx(c => updatePartnerTransactionStatus({transactionId:id,status:'storniert'},c)); assert.equal(await balance(),110);
});
run("cancelled inactive partner is reversed by original ledger owner, repeated/racing cancellation no-op", async () => {
  await seedOrder('cancel',{status:'storniert',cancelled_at:new Date()});
  await partnerEntry('cancel','provision',9); await partnerEntry('cancel','einloesung',-12);
  await pool.query("UPDATE partners SET is_active=0 WHERE id=9");
  await Promise.all([tx(c=>reversePartnerFinancialEntriesForCancelledOrder('cancel',c)),tx(c=>reversePartnerFinancialEntriesForCancelledOrder('cancel',c))]);
  assert.equal(await balance(),103);
  assert.deepEqual((await pool.query("SELECT DISTINCT status FROM partner_transactions")).rows.map(r=>r.status),['storniert']);
  assert.equal((await tx(c=>reversePartnerFinancialEntriesForCancelledOrder('cancel',c))).reversed,0);
});
run("storno status, partner entries and KWK cancellations share real Drizzle adapter transaction and rollback", async () => {
  await seedOrder('atomic',{credit_used:10,discount:10,kwk_credit_owner_id:1});
  await partnerEntry('atomic','einloesung',-10); await kwkEntry('atomic','credit_released',9,'confirmed',2); await kwkEntry('atomic','redeemed',-12,'confirmed',1);
  await pool.query("INSERT INTO kwk_referrals(kwk_id,order_id) VALUES(2,'atomic')");
  await assert.rejects(tx(async c=> {
    const db=drizzle(c as any), adapter=createPartnerCreditTransactionQueryClient(q=>db.execute(q));
    await c.query("UPDATE orders SET status='storniert', cancelled_at=NOW() WHERE order_id='atomic'");
    await reversePartnerFinancialEntriesForCancelledOrder('atomic',adapter); await cancelCreditInTransaction('atomic',adapter); throw Error('injected after ledger');
  }),/injected/);
  assert.equal(await balance(),100); assert.equal((await pool.query("SELECT status FROM orders")).rows[0].status,'offen');
  assert.equal((await pool.query("SELECT COUNT(*)::int count FROM kwk_ledger WHERE type='cancelled'")).rows[0].count,0);
  await tx(async c=>{
    const db=drizzle(c as any), adapter=createPartnerCreditTransactionQueryClient(q=>db.execute(q));
    await c.query("UPDATE orders SET status='storniert',cancelled_at=NOW() WHERE order_id='atomic'");
    await reversePartnerFinancialEntriesForCancelledOrder('atomic',adapter); await cancelCreditInTransaction('atomic',adapter);
  });
  assert.equal(await balance(),110);
  assert.deepEqual((await pool.query("SELECT id,credit_available FROM kwk_accounts ORDER BY id")).rows.map(r=>[r.id,Number(r.credit_available)]),[[1,0],[2,0]]);
});
run("partner owner conflicts and historical negative provisions fail closed with rollback", async () => {
  await seedOrder('conflict',{status:'storniert',partner_source_id:4}); await partnerEntry('conflict','provision',9);
  await assert.rejects(tx(c=>reversePartnerFinancialEntriesForCancelledOrder('conflict',c)),/OWNER_CONFLICT/); assert.equal(await balance(),100);
  await pool.query("UPDATE orders SET partner_source_id=9 WHERE order_id='conflict'; UPDATE partner_transactions SET amount=-9");
  await assert.rejects(tx(c=>reversePartnerFinancialEntriesForCancelledOrder('conflict',c)),/SIGN_REVIEW/); assert.equal(await balance(),100);
});
run("partner redemption finite positive allowed policy and goods ceilings; stale cancelled or already settled entries reject", async () => {
  for (const [id,values,error] of [
    ['negative',{credit_used:-10},/NEGATIVE/],['none',{credit_used:10,discount:10,partner_settlement_method_snapshot:'none'},/POLICY/],
    ['historicalpayout',{credit_used:10,discount:10,partner_settlement_method_snapshot:'payout'},/POLICY/],
    ['legacy',{credit_used:10,discount:10,partner_settlement_method_snapshot:null},/POLICY/],['paid',{credit_used:10,discount:10,paid_at:new Date()},/PAYMENT/],
    ['cancelred',{credit_used:10,discount:10,status:'storniert'},/CANCELLED/],['overgoods',{credit_used:110,discount:110},/EXCEEDS_GOODS/],
  ] as const) { await seedOrder(id,values); await assert.rejects(tx(c=>redeemPartnerCreditInTransaction(id,c)),error); }
  assert.equal(await balance(),100);
  await seedOrder('oldred',{credit_used:10,discount:10}); await partnerEntry('oldred','einloesung',-10,'storniert');
  await assert.rejects(tx(c=>redeemPartnerCreditInTransaction('oldred',c)),/CONFLICT_REVIEW/);
});
run("partner redemption races produce one debit, rollback removes debit and existing exact replay works", async () => {
  await seedOrder('redeem',{credit_used:10,discount:20,partner_commission_base_snapshot:90});
  await assert.rejects(tx(async c=>{await redeemPartnerCreditInTransaction('redeem',c); throw Error('rollback');}),/rollback/); assert.equal(await balance(),100);
  const results=await Promise.all([tx(c=>redeemPartnerCreditInTransaction('redeem',c)),tx(c=>redeemPartnerCreditInTransaction('redeem',c))]);
  assert.equal(results.filter(r=>!r.alreadyBooked).length,1); assert.equal(await balance(),90);
  assert.equal((await pool.query("SELECT COUNT(*)::int count FROM partner_transactions WHERE type='einloesung'")).rows[0].count,1);
});
run("payout requires actual active payout and commission policy, payload-bound replay; rollback atomic", async () => {
  const input={partnerId:9,amount:10,requestId:randomUUID()};
  await assert.rejects(tx(c=>recordPartnerPayout(input,c)),/PAYOUT_POLICY/);
  await pool.query("UPDATE partners SET program_key='creator' WHERE id=9");
  await pool.query("UPDATE partners SET is_active=0 WHERE id=9");
  await assert.rejects(tx(c=>recordPartnerPayout(input,c)),/PAYOUT_POLICY/);
  await pool.query("UPDATE partners SET is_active=1 WHERE id=9; UPDATE partner_programs SET commission_policy='none' WHERE key='creator'");
  await assert.rejects(tx(c=>recordPartnerPayout(input,c)),/PAYOUT_POLICY/);
  await pool.query("UPDATE partner_programs SET commission_policy='each_paid_code_order',active=false WHERE key='creator'");
  await assert.rejects(tx(c=>recordPartnerPayout(input,c)),/PAYOUT_POLICY/);
  await pool.query("UPDATE partner_programs SET active=true WHERE key='creator'");
  await assert.rejects(tx(async c=>{await recordPartnerPayout(input,c);throw Error('rollback');}),/rollback/); assert.equal(await balance(),100);
  await Promise.all([tx(c=>recordPartnerPayout(input,c)),tx(c=>recordPartnerPayout(input,c))]); assert.equal(await balance(),90);
  await assert.rejects(tx(c=>recordPartnerPayout({...input,amount:11},c)),/PAYLOAD_CONFLICT/);
});
run("first paid order is chronological, later paid shipment cannot disqualify earlier; concurrent bookings stable", async () => {
  const terms={partner_code:'TEST',partner_number:null,partner_commission_policy_snapshot:'first_paid_code_order',status:'versendet',shipped_at:new Date('2026-10-05'),email:' customer@example.invalid '};
  await seedOrder('earlier',{...terms,paid_at:new Date('2026-10-01')}); await seedOrder('later',{...terms,paid_at:new Date('2026-10-02')});
  assert.equal(await hasOtherPaidCodeOrder((s,v)=>pool.query(s,v),' test ',' CUSTOMER@example.invalid ','earlier'),false);
  assert.equal(await hasOtherPaidCodeOrder((s,v)=>pool.query(s,v),'TEST','customer@example.invalid','later'),true);
  const results=await Promise.all([tx(c=>bookPaidPartnerCommission('later',c)),tx(c=>bookPaidPartnerCommission('earlier',c))]);
  assert.equal(results[0].reason,'one_time_already_paid'); assert.equal(results[1].booked,true); assert.equal(await balance(),110);
  assert.equal((await tx(c=>bookPaidPartnerCommission('earlier',c))).reason,'already_booked');
});
run("first paid tie broken by orderId, missing first-use contact rejects while reusable anonymous creator books", async () => {
  const terms={partner_code:'TEST',partner_number:null,partner_commission_policy_snapshot:'first_paid_code_order',status:'versendet',shipped_at:new Date(),paid_at:new Date('2026-10-01')};
  await seedOrder('A',terms);await seedOrder('B',terms);
  assert.equal(await hasOtherPaidCodeOrder((s,v)=>pool.query(s,v),'TEST','owner@example.invalid','A'),false);
  assert.equal(await hasOtherPaidCodeOrder((s,v)=>pool.query(s,v),'TEST','owner@example.invalid','B'),true);
  await assert.rejects(hasOtherPaidCodeOrder((s,v)=>pool.query(s,v),'TEST',null),/KONTAKT/);
  await seedOrder('anonymous',{...terms,email:'',partner_commission_policy_snapshot:'each_paid_code_order',partner_settlement_method_snapshot:'payout',partner_source_id:4,partner_code:'OTHER'});
  assert.equal((await tx(c=>bookPaidPartnerCommission('anonymous',c))).booked,true);
});
run("KWK global owner-bound redemption concurrent replay and amount/goods/payment safety guards", async () => {
  await kwkEntry(null,'manual_correction',100);await kwkEntry(null,'manual_correction',100,'confirmed',2);
  await seedOrder('kwkred',{partner_source_id:null,partner_number:null,kwk_credit_owner_id:1,kwk_credit_requested:10,kwk_credit_used:10,discount:10});
  await assert.rejects(tx(c=>redeemCreditInTransaction(2,'kwkred',10,c)),/OWNER_REQUIRED/);
  await Promise.all([tx(c=>redeemCreditInTransaction(1,'kwkred',10,c)),tx(c=>redeemCreditInTransaction(1,'kwkred',10,c))]);
  assert.equal(Number((await pool.query("SELECT credit_available FROM kwk_accounts WHERE id=1")).rows[0].credit_available),90);
  await assert.rejects(tx(c=>redeemCreditInTransaction(1,'kwkred',Number.NaN,c)),/Ungültiger/);
  await assert.rejects(tx(c=>redeemCreditInTransaction(1,'kwkred',-10,c)),/Ungültiger/);
  await assert.rejects(tx(c=>redeemCreditInTransaction(1,'kwkred',11,c)),/stimmt nicht/);
  await seedOrder('kwkovergoods',{kwk_credit_owner_id:1,kwk_credit_requested:101,kwk_credit_used:101,discount:101});
  await assert.rejects(tx(c=>redeemCreditInTransaction(1,'kwkovergoods',101,c)),/EXCEEDS_REMAINING_GOODS/);
  await seedOrder('kwkpaid',{kwk_credit_owner_id:1,kwk_credit_requested:10,kwk_credit_used:10,discount:10,paid_at:new Date()});
  await assert.rejects(tx(c=>redeemCreditInTransaction(1,'kwkpaid',10,c)),/offene unbezahlte/);
  await pool.query("UPDATE orders SET status='storniert' WHERE order_id='kwkred'");
  await assert.rejects(tx(c=>redeemCreditInTransaction(1,'kwkred',10,c)),/CANCELLED/);
});
run("KWK unknown legacy owners cannot be claimed; new debit fully rolls back with order used amount/cache", async () => {
  await kwkEntry(null,'manual_correction',100);await seedOrder('legacykwk',{kwk_credit_requested:10,kwk_credit_used:10,discount:10});
  await assert.rejects(tx(c=>redeemCreditInTransaction(1,'legacykwk',10,c)),/OWNER_REQUIRED/);
  await pool.query("UPDATE orders SET kwk_credit_owner_id=1");
  await assert.rejects(tx(async c=>{await redeemCreditInTransaction(1,'legacykwk',10,c);throw Error('injected');}),/injected/);
  assert.equal((await pool.query("SELECT COUNT(*)::int count FROM kwk_ledger WHERE type='redeemed'")).rows[0].count,0);
});
run("KWK cancellation recurring/racing mixed original owners and zero net marker are idempotent", async () => {
  await seedOrder('kwkcancel',{status:'storniert',kwk_credit_owner_id:1});
  await kwkEntry('kwkcancel','credit_released',10,'confirmed',2); await kwkEntry('kwkcancel','refund',-3,'confirmed',2); await kwkEntry('kwkcancel','redeemed',-12);
  await pool.query("INSERT INTO kwk_referrals(kwk_id,order_id) VALUES(2,'kwkcancel')");
  await pool.query("UPDATE kwk_accounts SET status='deaktiviert',deleted_at=NOW()");
  await Promise.all([tx(c=>cancelCreditInTransaction('kwkcancel',c)),tx(c=>cancelCreditInTransaction('kwkcancel',c))]);
  assert.equal((await pool.query("SELECT COUNT(*)::int count FROM kwk_ledger WHERE type='cancelled'")).rows[0].count,2);
  assert.deepEqual((await pool.query("SELECT credit_available FROM kwk_accounts ORDER BY id")).rows.map(r=>Number(r.credit_available)),[0,0]);
  await seedOrder('zero',{status:'storniert'});await kwkEntry('zero','pending_credit',9,'pending');
  await tx(c=>cancelCreditInTransaction('zero',c));await tx(c=>cancelCreditInTransaction('zero',c));
  assert.equal((await pool.query("SELECT COUNT(*)::int count FROM kwk_ledger WHERE order_id='zero' AND type='cancelled'")).rows[0].count,1);
});
run("KWK owner conflict and negative original values fail closed without credit increase", async () => {
  await seedOrder('kwkbad',{status:'storniert',kwk_credit_owner_id:2});await kwkEntry('kwkbad','redeemed',-10);
  await assert.rejects(tx(c=>cancelCreditInTransaction('kwkbad',c)),/OWNER_CONFLICT/);
  await pool.query("UPDATE orders SET kwk_credit_owner_id=1; UPDATE kwk_ledger SET amount=10");
  await assert.rejects(tx(c=>cancelCreditInTransaction('kwkbad',c)),/SIGN_REVIEW/);
  assert.equal((await pool.query("SELECT COUNT(*)::int count FROM kwk_ledger WHERE type='cancelled'")).rows[0].count,0);
});
run("historical evidenced 10% claim immutable order and ledger provenance; replay and competing order requests deduplicate", async () => {
  await seedOrder('hist',{status:'versendet',paid_at:new Date(),shipped_at:new Date(),discount:10,partner_code:'TEST'});
  const beforeOrder=(await pool.query("SELECT row_to_json(orders) row FROM orders WHERE order_id='hist'")).rows[0].row;
  const preview=await previewHistoricalPartnerClaim(9,'hist',pool);assert.equal(preview.tenPercentUpperLimit,9);
  const input=defaultClaim('hist'); const results=await Promise.all([tx(c=>bookHistoricalPartnerClaim(input,'synthetic-admin',c)),tx(c=>bookHistoricalPartnerClaim(input,'synthetic-admin',c))]);
  assert.equal(results.filter(r=>!r.alreadyApplied).length,1);assert.equal(await balance(),109);
  assert.deepEqual((await pool.query("SELECT row_to_json(orders) row FROM orders WHERE order_id='hist'")).rows[0].row,beforeOrder);
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim({...input,amount:8},'synthetic-admin',c)),/PAYLOAD_CONFLICT/);
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim({...input,requestId:randomUUID(),expectedBalance:109},'synthetic-admin',c)),/CONFLICT_REVIEW/);
  await assert.rejects(pool.query("UPDATE partner_historical_claims SET reason='tamper'"),/immutable/);
  await assert.rejects(pool.query("DELETE FROM partner_historical_claims"),/immutable/);
});
run("historical claim guards wrong balance, >10%, unknown owner, no dispatch, rollback and original wrong creator snapshot", async () => {
  await seedOrder('histguards',{status:'versendet',paid_at:new Date(),shipped_at:new Date(),subtotal:219,discount:43.8,partner_commission:0,
    partner_code:'TEST',partner_program_snapshot:'creator',partner_settlement_method_snapshot:'payout',partner_commission_percent_snapshot:0});
  const input=defaultClaim('histguards',17.52);
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim({...input,evidenceReference:''},'admin',c)),/INPUT_INVALID/);
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim({...input,mode:'stored_order_amount'},'admin',c)),/PROVENANCE/);
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim({...input,expectedBalance:99},'admin',c)),/EXPECTED_BALANCE/);
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim({...input,amount:17.53},'admin',c)),/EXCEEDS_TEN_PERCENT/);
  await assert.rejects(tx(async c=>{await bookHistoricalPartnerClaim(input,'admin',c);throw Error('injected');}),/injected/);assert.equal(await balance(),100);
  await pool.query("UPDATE orders SET email='', partner_source_id=NULL,partner_number=NULL");
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim(input,'admin',c)),/OWNER_EVIDENCE/);
  await pool.query("UPDATE orders SET email='owner@example.invalid',partner_source_id=9,partner_number='OWN9',shipped_at=NULL");
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim(input,'admin',c)),/NOT_PAID_AND_SHIPPED/);
});
run("stored historical 8.32 claim uses original stored amount, never recomputes 8.33 or rewrites snapshot", async () => {
  await seedOrder('storedhist',{partner_source_id:4,partner_number:null,partner_code:'OTHER',email:'customer@example.invalid',status:'versendet',paid_at:new Date(),shipped_at:new Date(),
    subtotal:185,discount:18.5,partner_program_snapshot:'creator',partner_settlement_method_snapshot:'payout',partner_commission_base_snapshot:166.50,partner_commission_percent_snapshot:5,partner_commission:8.32});
  const input={...defaultClaim('storedhist',8.32),partnerId:4,mode:'stored_order_amount' as const};
  await assert.rejects(tx(c=>bookHistoricalPartnerClaim({...input,amount:8.33},'admin',c)),/PROVENANCE/);
  await tx(c=>bookHistoricalPartnerClaim(input,'admin',c));assert.equal(await balance(4),108.32);
  assert.equal(Number((await pool.query("SELECT partner_commission FROM orders WHERE order_id='storedhist'")).rows[0].partner_commission),8.32);
});
run("finance router endpoints enforce existing admin role and execute new locked services", async () => {
  await seedOrder('router');const id=await partnerEntry('router','provision',10);
  await assert.rejects(partnerRouter.createCaller(adminContext('product_manager')).updateTransactionStatus({transactionId:id,status:'storniert'}),/Berechtigung/);
  await partnerRouter.createCaller(adminContext()).updateTransactionStatus({transactionId:id,status:'storniert'});assert.equal(await balance(),90);
  await assert.rejects(partnerRouter.createCaller(adminContext()).recordPayout({partnerId:9,amount:10,requestId:randomUUID()}),/POLICY/);
  await assert.rejects(partnerRouter.createCaller(adminContext('packing')).historicalClaim(defaultClaim('router')),/Berechtigung/);
});
run("KWK native authenticated route cannot apply one session's credit to another owner's order", async () => {
  await kwkEntry(null,'manual_correction',100);await seedOrder('kwkroute',{kwk_credit_owner_id:2,kwk_credit_requested:10,kwk_credit_used:10,discount:10});
  const ctx=adminContext();ctx.user=null;ctx.req.headers.authorization=`Bearer ${createKwkToken(1)}`;
  await assert.rejects(kwkRouter.createCaller(ctx).redeemCredit({orderId:'kwkroute',amount:10}),/OWNER_REQUIRED/);
});

run("operations correction -25.01 has explicit negative-balance consent and atomic visible journal", async () => {
  await pool.query("UPDATE partners SET credit_balance=12.06 WHERE id=9");
  const input = {partnerId:9,amount:-25.01,expectedBalance:12.06,description:"Fehlbuchungskorrektur",requestId:randomUUID(),allowNegativeBalance:false};
  await assert.rejects(tx(c=>correctOperationsPartnerCredit(input,"synthetic-ops",c)), /NEGATIVE_BALANCE_REQUIRES_EXPLICIT_APPROVAL/);
  assert.equal(await balance(),12.06);
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM partner_transactions")).rows[0].n),0);
  const approved={...input,allowNegativeBalance:true};
  const results=await Promise.all([tx(c=>correctOperationsPartnerCredit(approved,"synthetic-ops",c)),tx(c=>correctOperationsPartnerCredit(approved,"synthetic-ops",c))]);
  assert.equal(results.filter(r=>!r.alreadyApplied).length,1);
  assert.equal(await balance(),-12.95);
  const entries=(await pool.query("SELECT type,amount,balance_after,description,status,admin_note FROM partner_transactions")).rows;
  assert.equal(entries.length,1);assert.equal(entries[0].type,"korrektur");assert.equal(Number(entries[0].amount),-25.01);
  assert.equal(Number(entries[0].balance_after),-12.95);assert.equal(entries[0].description,"Fehlbuchungskorrektur");
  assert.equal(entries[0].status,"normal");assert.match(entries[0].admin_note,/actor=synthetic-ops/);
  const replay=await tx(c=>correctOperationsPartnerCredit(approved,"synthetic-ops",c));assert.equal(replay.alreadyApplied,true);
  assert.equal(await balance(),-12.95);
});
run("operations correction binds replay payload, owner and expected balance without second deduction", async()=>{
  const input={partnerId:9,amount:-25.01,expectedBalance:100,description:"Fehlbuchungskorrektur",requestId:randomUUID(),allowNegativeBalance:false};
  await tx(c=>correctOperationsPartnerCredit(input,"synthetic-ops",c));
  for(const delta of [{amount:-25.02},{description:"Other correction"},{expectedBalance:99},{partnerId:4}]){
    await assert.rejects(tx(c=>correctOperationsPartnerCredit({...input,...delta},"synthetic-ops",c)),/PAYLOAD_CONFLICT/);
  }
  await assert.rejects(tx(c=>correctOperationsPartnerCredit({...input,requestId:randomUUID()},"synthetic-ops",c)),/BALANCE_CHANGED/);
  assert.equal(await balance(),74.99);assert.equal(await balance(4),100);
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM partner_transactions")).rows[0].n),1);
});
run("operations correction never changes a payout balance and rolls back wallet plus journal on failure",async()=>{
  const input={partnerId:9,amount:-25.01,expectedBalance:100,description:"Fehlbuchungskorrektur",requestId:randomUUID(),allowNegativeBalance:false};
  await assert.rejects(tx(c=>correctOperationsPartnerCredit({...input,partnerId:4},"synthetic-ops",c)),/NOT_SHOP_CREDIT/);
  await assert.rejects(tx(async c=>{await correctOperationsPartnerCredit(input,"synthetic-ops",c);throw Error("injected correction rollback");}),/injected/);
  assert.equal(await balance(),100);assert.equal(await balance(4),100);
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM partner_transactions")).rows[0].n),0);
});
run("future paid shipped 10-percent earning offsets negative correction once without changing paid order",async()=>{
  await pool.query("UPDATE partners SET credit_balance=-12.95 WHERE id=9");
  await seedOrder("future-10-10",{subtotal:284,discount:28.40,shipping:25,total:280.60,
    partner_commission_base_snapshot:255.60,partner_commission_percent_snapshot:10,partner_commission:25.56,
    status:"versendet",paid_at:new Date("2026-11-09T00:00:00Z"),shipped_at:new Date("2026-11-09T00:01:00Z")});
  await bookPaidPartnerCommission("future-10-10");await bookPaidPartnerCommission("future-10-10");
  assert.equal(await balance(),12.61);
  const rows=(await pool.query("SELECT amount,type FROM partner_transactions WHERE order_id='future-10-10'")).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].type,"provision");assert.equal(Number(rows[0].amount),25.56);
  const order=(await pool.query("SELECT subtotal,discount,total FROM orders WHERE order_id='future-10-10'")).rows[0];
  assert.equal(Number(order.subtotal),284);assert.equal(Number(order.discount),28.40);assert.equal(Number(order.total),280.60);
});
