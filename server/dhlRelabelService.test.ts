import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DhlRelabelService, DhlLabelError, recipientFromOrder, addressFingerprint, type LabelStore, type LabelSession, type LabelOrder, type LabelGeneration, type LabelOperation } from "./dhlRelabelService.js";
import type { PreparedDhlLabel } from "./dhlLabelPreparation.js";
import type { DhlShipmentResult } from "./dhlService.js";
import type { DhlCancellationResult } from "./dhlCancellationService.js";

const oldTracking="OLD-TEST-TRACKING";
function order(){return {orderId:"ISOLATED-DHL-TEST",firstName:"Old",lastName:"Recipient",company:"Old Company",street:"Old Street",houseNumber:"1",zip:"10115",city:"Berlin",country:"DE",email:"old@example.invalid",phone:"old-phone",deliveryType:"home",dhlPostNumber:"",status:"abgeschlossen",trackingNumber:oldTracking,trackingCarrier:"DHL",shippingLabelUrl:"/api/shipping/dhl/label/ISOLATED-DHL-TEST",shippingLabelContent:"OLD-PDF",subtotal:"100",total:"105",shipping:"5",paymentMethod:"bank_transfer",paidAt:new Date("2020-01-01"),packedAt:new Date("2020-01-02"),shippedAt:new Date("2020-01-03"),deliveredAt:null,updatedAt:new Date("2020-01-03")} as unknown as LabelOrder;}
function generation(o:LabelOrder):LabelGeneration{return {id:randomUUID(),generation:1,state:"active",trackingNumber:oldTracking,shippingProfile:null,recipient:recipientFromOrder(o),request:{legacy:true},orderSnapshot:structuredClone(o),reason:"legacy archive",actor:"test",labelContent:"OLD-PDF",originalLabelContent:"OLD-PDF",customsDocContent:"OLD-CN23",commercialInvoiceContent:"OLD-INVOICE",customsPrintContent:"OLD-PRINT",priorLabelUrl:o.shippingLabelUrl,cancellationSource:null,createdAt:new Date(),updatedAt:new Date()};}
/** Serialized short transactions, committed between external requests. No network/real database. */
class MemoryStore implements LabelStore {
 order=order();generations=[generation(this.order)];operations:LabelOperation[]=[];tail=Promise.resolve();publications=0;failSave=false;
 async withOrder<T>(_id:string,work:(s:LabelSession)=>Promise<T>):Promise<T>{
  const prior=this.tail;let release!:()=>void;this.tail=new Promise<void>(r=>release=r);await prior;
  const backup=structuredClone({order:this.order,generations:this.generations,operations:this.operations});
  try{return await work({order:this.order,generations:this.generations,operations:this.operations,
   saveGeneration:async g=>{if(this.failSave)throw Error("mock DB unavailable");const i=this.generations.findIndex(v=>v.id===g.id);if(i<0)this.generations.push(g);else this.generations[i]=g;},
   saveOperation:async o=>{const i=this.operations.findIndex(v=>v.id===o.id);if(i<0)this.operations.push(o);else this.operations[i]=o;},
   markNormalCreatePending:async()=>{this.order.trackingCarrier="DHL_PENDING";},
   releaseRejectedNormalCreate:async()=>{if(!this.order.trackingNumber&&!this.order.shippingLabelUrl&&this.order.trackingCarrier==="DHL_PENDING")this.order.trackingCarrier=null;},
   publishLabel:async g=>{this.publications++;Object.assign(this.order,{trackingNumber:g.trackingNumber,trackingCarrier:"DHL",shippingLabelUrl:`/api/shipping/dhl/label/${this.order.orderId}`,shippingLabelContent:g.labelContent});},
  });}catch(e){Object.assign(this,backup);throw e;}finally{release();}
 }
}
function fixture(){
 const store=new MemoryStore();const calls={cancel:0,create:0,prepare:[] as LabelOrder[]};
 const fake={cancelResult:{outcome:"cancelled"} as DhlCancellationResult,createResult:{success:true,trackingNumber:"NEW-TEST-TRACKING",labelBase64:"NEW-PDF",customsDocBase64:"NEW-CN23"} as DhlShipmentResult,documentsFail:false,gate:null as Promise<void>|null};
 const api={
  cancel:async()=>{calls.cancel++;if(fake.gate)await fake.gate;return fake.cancelResult;},
  prepare:async(o:LabelOrder,input:any)=>{calls.prepare.push(structuredClone(o));return {profileKey:input.shippingProfile??"DHL_DE_STANDARD",swissCustoms:null,shipmentInput:{orderId:o.orderId,consignee:{name1:o.company||`${o.firstName} ${o.lastName}`,addressStreet:o.street,addressHouse:o.houseNumber,postalCode:o.zip,city:o.city,country:o.country},weightGrams:1000}} as PreparedDhlLabel;},
  create:async()=>{calls.create++;if(fake.gate)await fake.gate;return fake.createResult;},
  documents:async()=>{if(fake.documentsFail)throw Error("mock CN23 pipeline failure");return {labelContent:"NEW-PDF",customsDocContent:"NEW-CN23",commercialInvoiceContent:null,customsPrintContent:null};},
 };
 const service=new DhlRelabelService(store,api);
 const cancel=(overrides:any={})=>({orderId:store.order.orderId,trackingNumber:oldTracking,reason:"Wrong address",idempotencyKey:randomUUID(),...overrides});
 const replace=(overrides:any={})=>({orderId:store.order.orderId,oldTrackingNumber:oldTracking,expectedGenerationId:store.generations[0].id,expectedAddressFingerprint:addressFingerprint(store.order),reason:"Explicit corrected snapshot",idempotencyKey:randomUUID(),shippingProfile:"DHL_DE_STANDARD",weightGrams:1000,recipient:{firstName:"New",lastName:"Recipient",company:"",street:"New Street",houseNumber:"10",zip:"20095",city:"Hamburg",country:"DE",email:"",phone:"",deliveryType:"home",dhlPostNumber:""},...overrides});
 return {store,calls,fake,service,cancel,replace};
}
async function errorCode(p:Promise<unknown>,code:string){await assert.rejects(p,(e:unknown)=>e instanceof DhlLabelError&&e.code===code);}
function operationalSnapshot(o:LabelOrder){const {trackingNumber,trackingCarrier,shippingLabelUrl,shippingLabelContent,...rest}=o;return rest;}

test("actual cancellation exactly once across same-key retries; tracking, label, status/payment stay unchanged",async()=>{
 const f=fixture();const before=structuredClone(f.store.order);const input=f.cancel();
 const a=await f.service.execute("cancel",input,"admin:1");const b=await f.service.execute("cancel",input,"admin:1");
 assert.deepEqual(a,b);assert.equal(a.body.state,"cancelled");assert.equal(f.calls.cancel,1);assert.deepEqual(f.store.order,before);assert.equal(f.store.generations[0].labelContent,"OLD-PDF");
 assert.equal(f.store.operations[0].actor,"admin:1");assert.equal(f.store.operations[0].reason,"Wrong address");
});
test("concurrent different-key cancellation cannot issue a second DELETE",async()=>{
 const f=fixture();let unlock!:()=>void;f.fake.gate=new Promise<void>(r=>unlock=r);
 const first=f.service.execute("cancel",f.cancel(),"admin");await new Promise(r=>setImmediate(r));
 await errorCode(f.service.execute("cancel",f.cancel(),"admin"),"OPERATION_PENDING");assert.equal(f.calls.cancel,1);unlock();await first;
});
test("same-key pending retry reports pending without a second DELETE",async()=>{
 const f=fixture();let unlock!:()=>void;f.fake.gate=new Promise<void>(r=>unlock=r);const input=f.cancel();
 const first=f.service.execute("cancel",input,"admin");await new Promise(r=>setImmediate(r));
 const retry=await f.service.execute("cancel",input,"admin");assert.equal(retry.body.code,"OPERATION_PENDING");assert.equal(f.calls.cancel,1);unlock();await first;
});
test("manifest rejection prevents replacement and administrative attestation",async()=>{
 const f=fixture();f.fake.cancelResult={outcome:"manifested",error:"Shipment already manifested"};
 assert.equal((await f.service.execute("cancel",f.cancel(),"admin")).body.code,"MANIFESTED");
 await errorCode(f.service.execute("replace",f.replace(),"admin"),"MANIFESTED");await errorCode(f.service.execute("attest",{...f.cancel(),externallyCancelled:true},"admin"),"MANIFESTED");assert.equal(f.calls.create,0);
});
test("deliveredAt blocks DELETE and attestation but historical completion alone does not",async()=>{
 const f=fixture();f.store.order.deliveredAt=new Date();
 await errorCode(f.service.execute("cancel",f.cancel(),"admin"),"DELIVERED");await errorCode(f.service.execute("attest",{...f.cancel(),externallyCancelled:true},"admin"),"DELIVERED");assert.equal(f.calls.cancel,0);
});
test("DELETE timeout stays unknown through new service instance and blocks blind new-key requests",async()=>{
 const f=fixture();f.fake.cancelResult={outcome:"unknown",error:"timeout"};const input=f.cancel();
 assert.equal((await f.service.execute("cancel",input,"admin")).body.code,"OUTCOME_UNKNOWN");
 await errorCode(f.service.execute("cancel",f.cancel(),"admin"),"OUTCOME_UNKNOWN");await errorCode(f.service.execute("replace",f.replace(),"admin"),"OUTCOME_UNKNOWN");
 assert.equal((await f.service.execute("cancel",input,"admin")).body.code,"OUTCOME_UNKNOWN");assert.equal(f.calls.cancel,1);assert.equal((await f.service.history(f.store.order.orderId)).blocked,true);
});
test("explicit external attestation resolves unknown DELETE only with old tracking and reason",async()=>{
 const f=fixture();f.fake.cancelResult={outcome:"unknown"};await f.service.execute("cancel",f.cancel(),"admin");
 await errorCode(f.service.execute("attest",{...f.cancel(),reason:"",externallyCancelled:true},"admin"),"INVALID_INPUT");
 await errorCode(f.service.execute("attest",{...f.cancel(),trackingNumber:"wrong",externallyCancelled:true},"admin"),"LABEL_CONFLICT");
 await f.service.execute("attest",{...f.cancel(),reason:"Verified cancelled in portal",externallyCancelled:true},"admin:2");
 assert.equal(f.store.generations[0].cancellationSource,"admin_attestation");assert.equal((await f.service.history(f.store.order.orderId)).blocked,false);
 await f.service.execute("replace",f.replace(),"admin");assert.equal(f.calls.create,1);assert.equal(f.calls.cancel,1);
});
test("confirmed cancellation -> one replacement on completed order; full address and blank company honored, old documents retained",async()=>{
 const f=fixture();const before=operationalSnapshot(structuredClone(f.store.order));await f.service.execute("cancel",f.cancel(),"admin");const input=f.replace();
 const a=await f.service.execute("replace",input,"admin");const b=await f.service.execute("replace",input,"admin");
 assert.deepEqual(a,b);assert.equal(a.body.state,"active");assert.equal(f.calls.create,1);assert.equal(f.store.publications,1);
 assert.equal(f.calls.prepare[0].company,"");assert.equal(f.calls.prepare[0].street,"New Street");assert.equal(f.calls.prepare[0].email,"");assert.equal(f.calls.prepare[0].phone,"");assert.equal(f.calls.prepare[0].city,"Hamburg");
 assert.deepEqual(operationalSnapshot(f.store.order),before);assert.equal(f.store.order.trackingNumber,"NEW-TEST-TRACKING");
 assert.equal(f.store.generations[0].trackingNumber,oldTracking);assert.equal(f.store.generations[0].labelContent,"OLD-PDF");assert.equal(f.store.generations[0].commercialInvoiceContent,"OLD-INVOICE");
 assert.equal(await f.service.document(f.store.order.orderId,f.store.generations[0].id,"label"),"OLD-PDF");assert.equal(await f.service.document(f.store.order.orderId,f.store.generations[0].id,"invoice"),"OLD-INVOICE");
 await errorCode(f.service.execute("replace",f.replace(),"admin"),"LABEL_CONFLICT");assert.equal(f.calls.create,1);
});
test("full recipient schema rejects missing company/address/contact rather than merging",async()=>{
 const f=fixture();await f.service.execute("cancel",f.cancel(),"admin");
 for(const key of ["company","street","city","phone","email","dhlPostNumber"]){const input=f.replace();delete input.recipient[key];await errorCode(f.service.execute("replace",input,"admin"),"INVALID_INPUT");}
 assert.equal(f.calls.create,0);
});
test("stale source address fingerprint or prior generation is rejected before POST",async()=>{
 const f=fixture();await f.service.execute("cancel",f.cancel(),"admin");const input=f.replace();f.store.order.company="changed concurrently";
 await errorCode(f.service.execute("replace",input,"admin"),"STALE_SNAPSHOT");await errorCode(f.service.execute("replace",f.replace({expectedGenerationId:randomUUID()}),"admin"),"STALE_SNAPSHOT");assert.equal(f.calls.create,0);
});
test("normal create cannot bypass active/cancelled relabel generation",async()=>{
 const f=fixture();await errorCode(f.service.execute("create",{orderId:f.store.order.orderId},"admin"),"LABEL_CONFLICT");await f.service.execute("cancel",f.cancel(),"admin");await errorCode(f.service.execute("create",{orderId:f.store.order.orderId},"admin"),"LABEL_CONFLICT");assert.equal(f.calls.create,0);
});
test("normal create uses same durable guard: unknown POST never releases lock",async()=>{
 const f=fixture();f.store.generations=[];Object.assign(f.store.order,{trackingNumber:null,trackingCarrier:null,shippingLabelUrl:null,shippingLabelContent:null});f.fake.createResult={success:false,outcome:"unknown",statusCode:0,error:"timeout"};
 const input={orderId:f.store.order.orderId,idempotencyKey:randomUUID()};assert.equal((await f.service.execute("create",input,"admin")).body.code,"OUTCOME_UNKNOWN");
 await errorCode(f.service.execute("create",{orderId:f.store.order.orderId},"admin"),"OUTCOME_UNKNOWN");assert.equal((await f.service.execute("create",input,"admin")).body.code,"OUTCOME_UNKNOWN");assert.equal(f.calls.create,1);
 await errorCode(f.service.execute("attest",{...f.cancel(),externallyCancelled:true},"admin"),"OUTCOME_UNKNOWN");
});
test("replacement POST timeout retains cancelled old tracking and permanently guards retries",async()=>{
 const f=fixture();await f.service.execute("cancel",f.cancel(),"admin");f.fake.createResult={success:false,outcome:"unknown",error:"lost POST response"};const input=f.replace();
 assert.equal((await f.service.execute("replace",input,"admin")).body.code,"OUTCOME_UNKNOWN");await errorCode(f.service.execute("replace",f.replace(),"admin"),"OUTCOME_UNKNOWN");
 assert.equal(f.store.order.trackingNumber,oldTracking);assert.equal(f.store.generations[0].state,"cancelled");assert.equal(f.calls.create,1);assert.equal(f.store.publications,0);
});
test("documents failure retains raw label/tracking/CN23, no duplicate nor false full success",async()=>{
 const f=fixture();await f.service.execute("cancel",f.cancel(),"admin");f.fake.documentsFail=true;const input=f.replace();
 const r=await f.service.execute("replace",input,"admin");assert.equal(r.body.code,"DOCUMENTS_FAILED");assert.equal(r.body.trackingNumber,"NEW-TEST-TRACKING");
 const g=f.store.generations[1];assert.equal(g.originalLabelContent,"NEW-PDF");assert.equal(g.customsDocContent,"NEW-CN23");assert.equal(g.state,"documents_failed");
 await errorCode(f.service.execute("replace",f.replace(),"admin"),"OUTCOME_UNKNOWN");assert.equal(f.store.order.trackingNumber,oldTracking);assert.equal(f.calls.create,1);
});
test("definite rejection can be retried but unknown gateway outcome cannot",async()=>{
 const f=fixture();await f.service.execute("cancel",f.cancel(),"admin");f.fake.createResult={success:false,outcome:"rejected",statusCode:400,error:"invalid address"};
 assert.equal((await f.service.execute("replace",f.replace(),"admin")).body.code,"DHL_REJECTED");f.fake.createResult={success:true,trackingNumber:"NEW-TEST-TRACKING",labelBase64:"NEW-PDF"};await f.service.execute("replace",f.replace(),"admin");assert.equal(f.calls.create,2);
});
test("same idempotency key with changed payload cannot issue any additional call",async()=>{
 const f=fixture();const input=f.cancel();await f.service.execute("cancel",input,"admin");await errorCode(f.service.execute("cancel",{...input,reason:"Different reason"},"admin"),"IDEMPOTENCY_CONFLICT");assert.equal(f.calls.cancel,1);
});
test("concurrent replacements issue one POST and normal create cannot bypass pending",async()=>{
 const f=fixture();await f.service.execute("cancel",f.cancel(),"admin");let unlock!:()=>void;f.fake.gate=new Promise<void>(r=>unlock=r);
 const first=f.service.execute("replace",f.replace(),"admin");await new Promise(r=>setImmediate(r));
 await errorCode(f.service.execute("replace",f.replace(),"admin"),"OPERATION_PENDING");await errorCode(f.service.execute("create",{orderId:f.store.order.orderId},"admin"),"OPERATION_PENDING");assert.equal(f.calls.create,1);unlock();await first;
});
test("existing legacy DHL_PENDING marker is never released by normal create",async()=>{
 const f=fixture();f.store.generations=[];Object.assign(f.store.order,{trackingNumber:null,shippingLabelUrl:null,trackingCarrier:"DHL_PENDING"});
 await errorCode(f.service.execute("create",{orderId:f.store.order.orderId},"admin"),"LABEL_CONFLICT");assert.equal(f.calls.create,0);
});
test("DB failure after booking leaves committed pending operation, blocks all retries",async()=>{
 const f=fixture();await f.service.execute("cancel",f.cancel(),"admin");const original=(f as any).service;
 // Fail the raw-document save only after the external create returned.
 const api=(original as any).api;const create=api.create;api.create=async(p:any)=>{const r=await create(p);f.store.failSave=true;return r;};
 await assert.rejects(f.service.execute("replace",f.replace(),"admin"),/mock DB/);f.store.failSave=false;
 await errorCode(f.service.execute("replace",f.replace(),"admin"),"OPERATION_PENDING");assert.equal(f.calls.create,1);
});
