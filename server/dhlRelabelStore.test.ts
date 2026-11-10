import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { orders } from "../drizzle/schema.js";
import { PgDhlLabelStore } from "./dhlRelabelStore.js";
import { DhlLabelError } from "./dhlRelabelService.js";

function mockDatabase(){
 const calls:{sql:string;params:any[]}[]=[];let released=false;
 const o:any={orderId:"MOCK-DHL-PG",firstName:"Legacy",lastName:"Name",company:"Legacy Company",street:"Old Road",houseNumber:"1",zip:"10115",city:"Berlin",country:"DE",email:"mock@example.invalid",phone:"",deliveryType:"home",dhlPostNumber:"",trackingNumber:"OLD-MOCK",trackingCarrier:"DHL",shippingLabelUrl:"/api/shipping/dhl/label/MOCK-DHL-PG",shippingLabelContent:"OLD-PDF",deliveredAt:null,status:"abgeschlossen"};
 const client={
  query:async(query:any,params:any[]=[])=>{
   const sql=typeof query==="string"?query:query.text;calls.push({sql,params});
   if(sql.startsWith("SELECT order_id FROM orders"))return {rowCount:1,rows:[{order_id:o.orderId}]};
   if(sql.toLowerCase().startsWith('select "id"'))return {rowCount:1,rows:[Object.keys(getTableColumns(orders)).map(k=>o[k]??null)]};
   if(sql.startsWith("SELECT commercial_invoice_content"))return {rowCount:1,rows:[{commercial_invoice_content:"OLD-INVOICE",customs_print_content:"OLD-CUSTOMS-PRINT"}]};
   return {rowCount:1,rows:[]};
  },release:()=>released=true,
 };
 const store=new PgDhlLabelStore(async()=>({connect:async()=>client} as any));
 return {store,calls,o,released:()=>released};
}
test("PG adapter locks order, lazily archives original label/tracking/address/docs before mutation, commits and releases",async()=>{
 const f=mockDatabase();
 await f.store.withOrder(f.o.orderId,async s=>{
  assert.equal(s.order.orderId,f.o.orderId);assert.equal(s.generations.length,1);const g=s.generations[0];assert.equal(g.trackingNumber,"OLD-MOCK");assert.equal(g.labelContent,"OLD-PDF");assert.equal(g.recipient.company,"Legacy Company");assert.equal(g.commercialInvoiceContent,"OLD-INVOICE");assert.equal(g.customsPrintContent,"OLD-CUSTOMS-PRINT");assert.equal(g.request.originalRecipientUnverified,true);
  assert.equal(g.orderSnapshot.status,"abgeschlossen");
 });
 assert.equal(f.calls[0].sql,"BEGIN");assert.match(f.calls[1].sql,/FOR UPDATE/);assert.equal(f.calls.at(-1)?.sql,"COMMIT");assert.equal(f.released(),true);
 assert.ok(f.calls.some(c=>c.sql.startsWith("INSERT INTO dhl_label_generations")));assert.ok(!f.calls.some(c=>c.sql.startsWith("UPDATE orders")));
});
test("PG publish writes ONLY four label/tracking fields and preserves archived CH docs before current docs overwrite",async()=>{
 const f=mockDatabase();await f.store.withOrder(f.o.orderId,async s=>{const g={...s.generations[0],id:randomUUID(),generation:2,trackingNumber:"NEW-MOCK",labelContent:"NEW-LABEL",commercialInvoiceContent:"NEW-INVOICE",customsPrintContent:"NEW-PRINT"};await s.saveGeneration(g);await s.publishLabel(g);});
 const update=f.calls.find(c=>c.sql.startsWith("UPDATE orders"))!;assert.ok(update);assert.match(update.sql,/tracking_number=\$1,tracking_carrier='DHL',shipping_label_url=\$2,shipping_label_content=\$3/);assert.doesNotMatch(update.sql,/status|paid_at|stock|updated_at|first_name|company|street|phone|email|shipped_at|delivered_at/);
 const archived=f.calls.findIndex(c=>c.sql.startsWith("INSERT INTO dhl_label_generations")&&c.params[2]===1);const currentDocs=f.calls.findIndex(c=>c.sql.startsWith("UPDATE order_swiss_customs_declarations"));assert.ok(archived>=0&&archived<currentDocs);
});
test("PG transaction failure rolls back without unguarded order writes, connection released",async()=>{
 const f=mockDatabase();await assert.rejects(f.store.withOrder(f.o.orderId,async()=>{throw Error("mock transaction failure");}),/mock transaction/);assert.equal(f.calls.at(-1)?.sql,"ROLLBACK");assert.equal(f.released(),true);
});
test("missing DB fails closed before any external API operation",async()=>{
 const store=new PgDhlLabelStore(async()=>null);await assert.rejects(store.withOrder("MOCK",async()=>{}),(e:unknown)=>e instanceof DhlLabelError&&e.code==="DATABASE_UNAVAILABLE");
});
test("migration is additive, durable unresolved unique guard has no TTL; startup loads exact SQL",async()=>{
 const sql=await readFile(new URL("../drizzle/migrations/0031_dhl_label_generations.sql",import.meta.url),"utf8");const startup=await readFile(new URL("./dhlRelabelSchema.ts",import.meta.url),"utf8");const index=await readFile(new URL("./index.ts",import.meta.url),"utf8");
 assert.match(sql,/CREATE TABLE IF NOT EXISTS dhl_label_generations/);assert.match(sql,/UNIQUE \(order_id, idempotency_key\)/);assert.match(sql,/CREATE UNIQUE INDEX IF NOT EXISTS dhl_label_one_unresolved_operation[\s\S]*?WHERE state IN \('pending','unknown'\)/);assert.doesNotMatch(sql,/UPDATE orders|DELETE FROM|DROP TABLE/);assert.match(startup,/0031_dhl_label_generations.sql/);assert.match(index,/await ensureDhlRelabelSchema\(\)/);
});
test("all new mutate/history/document routes retain existing admin-only auth without role widening",async()=>{
 const router=await readFile(new URL("./dhlExpressRouter.ts",import.meta.url),"utf8");assert.match(router,/user.role !== "admin"/);assert.match(router,/dhlExpressRouter.post\(`\/api\/shipping\/dhl\/\$\{path\}`,requireWawiAdmin/);assert.match(router,/label-history\/:orderId",requireWawiAdmin/);assert.match(router,/\$\{path\}\/:orderId\/:generationId`,requireWawiAdmin/);assert.doesNotMatch(router,/role === "product_manager"|role === "support"/);
});
