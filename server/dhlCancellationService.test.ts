import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ENV } from "./env.js";
import { cancelDhlShipment } from "./dhlCancellationService.js";
import { createDhlShipmentDE, createDhlShipmentEU, createDhlShipmentCH, type DhlShipmentInput } from "./dhlService.js";

function credentials(){Object.assign(ENV,{dhlApiKey:"MOCK-KEY-NOT-REAL",dhlBusinessUsername:"mock-user",dhlBusinessPassword:"mock-password",dhlBillingNumber:"00000000000000",dhlBillingNumberEu:"00000000000000",dhlSandbox:true});}
async function mocked<T>(implementation:typeof fetch,work:()=>Promise<T>){const original=globalThis.fetch;const env={...ENV};credentials();globalThis.fetch=implementation;try{return await work();}finally{globalThis.fetch=original;Object.assign(ENV,env);}}
const tracking="0034043333301020028792443";
const response=(status:number,itemStatus:number,detail="")=>new Response(JSON.stringify({status:{status,title:"Status"},items:[{shipmentNo:tracking,sstatus:{status:itemStatus,title:"Status",detail}}]}),{status});

test("DELETE exact official required query parameters, auth, matching shipment sstatus and no body",async()=>{
 let calls=0;
 await mocked(async(url,init)=>{calls++;const u=new URL(String(url));assert.equal(u.origin,"https://api-sandbox.dhl.com");assert.equal(u.pathname,"/parcel/de/shipping/v2/orders");assert.deepEqual([...u.searchParams],[ ["profile","STANDARD_GRUPPENPROFIL"],["shipment",tracking] ]);assert.equal(init?.method,"DELETE");assert.equal(init?.body,undefined);assert.ok(init?.signal);const headers=new Headers(init?.headers);assert.equal(headers.get("dhl-api-key"),"MOCK-KEY-NOT-REAL");assert.equal(headers.get("authorization"),`Basic ${Buffer.from("mock-user:mock-password").toString("base64")}`);return response(200,200);},async()=>assert.equal((await cancelDhlShipment(tracking)).outcome,"cancelled"));
 assert.equal(calls,1);
});
test("207 matching successful item is accepted, envelope-only/mismatched shipment is not proof",async()=>{
 await mocked(async()=>response(207,200),async()=>assert.equal((await cancelDhlShipment(tracking)).outcome,"cancelled"));
 for(const payload of [{status:{status:200}}, {items:[{shipmentNo:"different",sstatus:{status:200}}]}, {items:[{shipmentNo:tracking,sstatus:{statusCode:200}}]}, {items:[{shipmentNo:tracking,sstatus:{status:200}},{shipmentNo:"extra",sstatus:{status:200}}]}]){
  await mocked(async()=>new Response(JSON.stringify(payload),{status:200}),async()=>assert.equal((await cancelDhlShipment(tracking)).outcome,"unknown"));
 }
});
test("already deleted/not found 400 never confirms cancellation",async()=>{
 await mocked(async()=>response(200,400,"Shipment does not exist or was already deleted"),async()=>assert.equal((await cancelDhlShipment(tracking)).outcome,"rejected"));
 await mocked(async()=>response(400,400,"Already deleted"),async()=>assert.equal((await cancelDhlShipment(tracking)).outcome,"rejected"));
});
test("DHL manifest rejection recognized even inside 200/207 envelope",async()=>{
 for(const status of [200,207,400])await mocked(async()=>response(status,400,"Shipment is already manifested (Tagesabschluss)"),async()=>assert.equal((await cancelDhlShipment(tracking)).outcome,"manifested"));
});
test("DELETE network timeout, malformed JSON and server failure remain unknown",async()=>{
 for(const stub of [async()=>{throw Error("mock timeout");},async()=>new Response("not-json",{status:200}),async()=>response(500,500,"gateway failed")])await mocked(stub,async()=>assert.equal((await cancelDhlShipment(tracking)).outcome,"unknown"));
});
test("verified DELETE parameters and result schema exist in saved official DHL OpenAPI",async()=>{
 const yaml=await readFile(new URL("../docs/dhl-parcel-de-shipping-v2_4.yaml",import.meta.url),"utf8");const section=yaml.slice(yaml.indexOf("    delete:"),yaml.indexOf("components:"));
 assert.match(section,/operationId: ordersAccountDelete/);assert.match(section,/- name: profile[\s\S]*?required: true/);assert.match(section,/- name: shipment[\s\S]*?required: true/);assert.match(section,/#\/components\/schemas\/LabelDataResponse/);assert.match(section,/prior to them being manifested/);
});
function input(country="DE"):DhlShipmentInput{return {orderId:"ISOLATED-MOCK-ONLY",billingNumber:"00000000000000",consignee:{name1:"Mock Recipient",addressStreet:"Example",addressHouse:"1",postalCode:"10115",city:"Berlin",country},weightGrams:1000};}
test("DE and EU POST timeouts, invalid JSON, missing tracking, 500/408 outcomes cannot release durable guard",async()=>{
 for(const create of [createDhlShipmentDE,createDhlShipmentEU])for(const stub of [async()=>{throw Error("mock timeout");},async()=>new Response("bad",{status:200}),async()=>new Response('{"items":[{}]}',{status:200}),async()=>response(500,500),async()=>response(408,408)])await mocked(stub,async()=>{const r=await create(input(create===createDhlShipmentEU?"AT":"DE"));assert.equal(r.success,false);assert.equal(r.outcome,"unknown");});
});
test("DE and EU known 400 are explicit rejections; existing payload and shipper unchanged",async()=>{
 for(const create of [createDhlShipmentDE,createDhlShipmentEU])await mocked(async(_url,init)=>{assert.equal(init?.method,"POST");const p=JSON.parse(String(init?.body));assert.equal(p.shipments[0].shipper.name1,"Core Versand und Logistik");assert.equal(p.shipments[0].shipper.addressStreet,"Klingenhagen");assert.equal(p.shipments[0].shipper.addressHouse,"31");assert.equal(p.shipments[0].details.weight.value,1000);return new Response(JSON.stringify({detail:"validation failure"}),{status:400});},async()=>assert.equal((await create(input(create===createDhlShipmentEU?"AT":"DE"))).outcome,"rejected"));
});
test("CH created tracking with missing document is retained as unknown and never resubmitted",async()=>{
 let posts=0;const i=input("CH");i.swissCustoms={orderId:i.orderId,packageWeightGrams:1000,shippingEur:5,subtotalEur:50,discountEur:0,goodsValueEur:50,lines:[{orderItemId:1,description:"Mock research material",quantity:1,unitWeightGrams:100,unitValueEur:50,lineValueEur:50,hsCode:"",countryOfOrigin:""}]} as any;
 await mocked(async(_url,init)=>{if(init?.method==="POST")posts++;return new Response(JSON.stringify({items:[{shipmentNo:tracking}]}),{status:200});},async()=>{const r=await createDhlShipmentCH(i);assert.equal(r.success,false);assert.equal(r.outcome,"unknown");assert.equal(r.trackingNumber,tracking);});assert.equal(posts,1);
});

test("POST error envelope carrying tracking is unknown and retains tracking/raw document evidence",async()=>{
 for(const create of [createDhlShipmentDE,createDhlShipmentEU])await mocked(async()=>new Response(JSON.stringify({items:[{shipmentNo:tracking,label:{b64:"MOCK-PDF"},sstatus:{status:400}}]}),{status:400}),async()=>{const r=await create(input(create===createDhlShipmentEU?"AT":"DE"));assert.equal(r.outcome,"unknown");assert.equal(r.trackingNumber,tracking);assert.equal(r.labelBase64,"MOCK-PDF");});
});
test("POST success envelope with contradictory per-shipment status is not a successful label",async()=>{
 for(const create of [createDhlShipmentDE,createDhlShipmentEU])await mocked(async()=>response(200,500),async()=>{const r=await create(input(create===createDhlShipmentEU?"AT":"DE"));assert.equal(r.success,false);assert.equal(r.outcome,"unknown");assert.equal(r.trackingNumber,tracking);});
});
