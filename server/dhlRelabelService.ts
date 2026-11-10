import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ENV } from "./env.js";
import type { orders } from "../drizzle/schema.js";
import type { PreparedDhlLabel } from "./dhlLabelPreparation.js";
import type { DhlShipmentResult } from "./dhlService.js";
import type { DhlCancellationResult } from "./dhlCancellationService.js";

export class DhlLabelError extends Error {
  constructor(public status:number, public code:string, message:string){super(message);}
}
const recipientSchema=z.object({firstName:z.string().trim().min(1).max(200),lastName:z.string().trim().min(1).max(200),company:z.string().trim().max(200),street:z.string().trim().min(1).max(300),houseNumber:z.string().trim().min(1).max(100),zip:z.string().trim().min(1).max(30),city:z.string().trim().min(1).max(100),country:z.string().trim().min(1).max(100),email:z.string().trim().max(320),phone:z.string().trim().max(50),deliveryType:z.enum(["home","packstation","postfiliale"]),dhlPostNumber:z.string().trim().max(20)}).strict();
export type LabelRecipient=z.infer<typeof recipientSchema>;
export type LabelOrder=typeof orders.$inferSelect;
export type GenerationState="active"|"cancel_pending"|"cancel_unknown"|"cancel_rejected"|"manifested"|"delivered"|"cancelled"|"create_pending"|"create_unknown"|"create_rejected"|"documents_failed";
export type OperationKind="create"|"cancel"|"attest"|"replace";
export interface OperationResult {httpStatus:number;body:Record<string,any>}
export interface LabelGeneration {
 id:string;generation:number;state:GenerationState;trackingNumber:string|null;shippingProfile:string|null;
 recipient:LabelRecipient;request:Record<string,any>;orderSnapshot:LabelOrder;reason:string;actor:string;
 labelContent:string|null;originalLabelContent:string|null;customsDocContent:string|null;commercialInvoiceContent:string|null;customsPrintContent:string|null;priorLabelUrl:string|null;
 cancellationSource:"dhl"|"admin_attestation"|null;createdAt:Date;updatedAt:Date;
}
export interface LabelOperation {id:string;generationId:string;idempotencyKey:string;requestHash:string;kind:OperationKind;state:"pending"|"succeeded"|"rejected"|"unknown";actor:string;reason:string;result:OperationResult|null;createdAt:Date;finishedAt:Date|null}
export interface LabelSession {order:LabelOrder;generations:LabelGeneration[];operations:LabelOperation[];saveGeneration(g:LabelGeneration):Promise<void>;saveOperation(o:LabelOperation):Promise<void>;publishLabel(g:LabelGeneration):Promise<void>;markNormalCreatePending():Promise<void>;releaseRejectedNormalCreate():Promise<void>}
export interface LabelStore {withOrder<T>(orderId:string, work:(s:LabelSession)=>Promise<T>):Promise<T>}
interface Dependencies {prepare(order:LabelOrder,input:{weightGrams?:number;shippingProfile?:string}):Promise<PreparedDhlLabel>;create(p:PreparedDhlLabel):Promise<DhlShipmentResult>;documents(p:PreparedDhlLabel,result:DhlShipmentResult):Promise<{labelContent:string|null;customsDocContent:string|null;commercialInvoiceContent:string|null;customsPrintContent:string|null}>;cancel(tracking:string):Promise<DhlCancellationResult>}
export function recipientFromOrder(order:LabelOrder):LabelRecipient {
 return Object.fromEntries(["firstName","lastName","company","street","houseNumber","zip","city","country","email","phone","deliveryType","dhlPostNumber"].map(k=>[k,String((order as any)[k]??(k==="deliveryType"?"home":""))])) as LabelRecipient;
}
function canonical(value:any):string {return JSON.stringify(value&&typeof value==="object"?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);}
export function addressFingerprint(order:LabelOrder){return createHash("sha256").update(canonical(recipientFromOrder(order))).digest("hex");}
function current(s:LabelSession){return [...s.generations].reverse().find(g=>g.state!=="create_rejected");}
function unresolved(s:LabelSession){return s.operations.find(o=>o.state==="pending"||o.state==="unknown");}
function knownDelivered(s:LabelSession,g:LabelGeneration){return g.state==="delivered"||Boolean(s.order.deliveredAt);}
function matchesOrder(s:LabelSession,g:LabelGeneration){return Boolean(g.trackingNumber)&&g.trackingNumber===s.order.trackingNumber;}
function assertCurrent(s:LabelSession,g:LabelGeneration|undefined,tracking:string){
 if(!g||g.trackingNumber!==tracking||!matchesOrder(s,g))throw new DhlLabelError(409,"LABEL_CONFLICT","Alte Trackingnummer entspricht nicht dem aktuellen DHL-Label");
 if(g.state==="manifested")throw new DhlLabelError(409,"MANIFESTED","DHL-Sendung ist bereits manifestiert; kein Storno oder Ersatzlabel möglich");
 if(knownDelivered(s,g))throw new DhlLabelError(409,"DELIVERED","Zugestellte Sendung kann nicht storniert oder per Attestation ersetzt werden");
 return g;
}
function resultError(code:string,error:string,g?:LabelGeneration,status=409):OperationResult{return {httpStatus:status,body:{success:false,code,error,...(g?{generationId:g.id,state:g.state,trackingNumber:g.trackingNumber}:{})}};}
const common=z.object({orderId:z.string().trim().min(1).max(32),idempotencyKey:z.string().trim().min(8).max(128),reason:z.string().trim().min(3).max(2000)});
const cancelInput=common.extend({trackingNumber:z.string().trim().min(1).max(100)}).strict();
const attestInput=cancelInput.extend({externallyCancelled:z.literal(true)}).strict();
const replaceInput=common.extend({oldTrackingNumber:z.string().trim().min(1).max(100),expectedGenerationId:z.string().uuid(),expectedAddressFingerprint:z.string().regex(/^[a-f0-9]{64}$/),recipient:recipientSchema,shippingProfile:z.string().min(1),weightGrams:z.number().finite().positive().optional()}).strict();
const createInput=z.object({orderId:z.string().trim().min(1).max(32),shippingProfile:z.string().optional(),weightGrams:z.number().finite().positive().optional(),idempotencyKey:z.string().trim().min(8).max(128).optional()}).strict();

export class DhlRelabelService {
 constructor(private store:LabelStore,private api:Dependencies){}
 async execute(kind:OperationKind,raw:unknown,actor:string):Promise<OperationResult> {
  const parsed=(kind==="create"?createInput:kind==="cancel"?cancelInput:kind==="attest"?attestInput:replaceInput).safeParse(raw);
  if(!parsed.success)throw new DhlLabelError(400,"INVALID_INPUT",parsed.error.issues.map(v=>`${v.path.join(".")}: ${v.message}`).join("; "));
  const input:any=parsed.data;
  const requestHash=createHash("sha256").update(canonical({kind,...input})).digest("hex");
  const key=input.idempotencyKey??`normal-create-${randomUUID()}`;
  const reservation=await this.store.withOrder(input.orderId,async s=>{
   const previous=s.operations.find(o=>o.idempotencyKey===key);
   if(previous){
    if(previous.requestHash!==requestHash||previous.kind!==kind)throw new DhlLabelError(409,"IDEMPOTENCY_CONFLICT","Idempotency-Key gehört zu einem anderen Request");
    return {result:previous.result??resultError(previous.state==="unknown"?"OUTCOME_UNKNOWN":"OPERATION_PENDING","Vorgang hat noch kein sicher bestätigtes Ergebnis; nicht wiederholen",current(s))};
   }
   let g=current(s);
   const pending=unresolved(s);
   if(pending && !(kind==="attest"&&pending.kind==="cancel"&&pending.state==="unknown"))throw new DhlLabelError(409,pending.state==="unknown"?"OUTCOME_UNKNOWN":"OPERATION_PENDING","Ungeklärter DHL-Vorgang sperrt weitere Buchungen dauerhaft");
   if(kind==="create") {
    if(g||s.order.trackingNumber||s.order.shippingLabelUrl||s.order.trackingCarrier)throw new DhlLabelError(409,"LABEL_CONFLICT","Bestellung hat bereits ein Label, Tracking oder einen Pending-Marker – kein neues Label erstellt");
   }else {g=assertCurrent(s,g,kind==="replace"?input.oldTrackingNumber:input.trackingNumber);}
   if(kind==="replace") {
    if(g!.id!==input.expectedGenerationId||addressFingerprint(s.order)!==input.expectedAddressFingerprint)throw new DhlLabelError(409,"STALE_SNAPSHOT","Labelgeneration oder Bestelladresse wurde geändert. Historie neu laden und Adresse erneut bestätigen.");
    if(g!.state!=="cancelled")throw new DhlLabelError(409,"CANCELLATION_REQUIRED","Ersatzlabel benötigt ausdrücklich bestätigte Stornierung");
   }
   if((kind==="cancel"||kind==="attest")&&g!.state==="cancelled"){
    const result=this.cancelSuccess(input.orderId,g!);
    await s.saveOperation({id:randomUUID(),generationId:g!.id,idempotencyKey:key,requestHash,kind,state:"succeeded",actor,reason:input.reason,result,createdAt:new Date(),finishedAt:new Date()});
    return {result};
   }
   if(kind==="attest"&&!["active","cancel_rejected","cancel_unknown","cancelled"].includes(g!.state))throw new DhlLabelError(409,"LABEL_CONFLICT","Dieser Zustand erlaubt keine externe Stornobestätigung");
   let prepared:PreparedDhlLabel|undefined;
   if(kind==="create"||kind==="replace") {
    const recipient=kind==="replace"?input.recipient:recipientFromOrder(s.order);
    // All recipient fields overwritten together, including deliberately blank company/contact.
    const shipmentOrder=kind==="replace"?{...s.order,...recipient}:s.order;
    prepared=await this.api.prepare(shipmentOrder,input);
    g={id:randomUUID(),generation:Math.max(0,...s.generations.map(v=>v.generation))+1,state:"create_pending",trackingNumber:null,shippingProfile:prepared.profileKey,recipient,request:{...input,consignee:prepared.shipmentInput.consignee,weightGrams:prepared.shipmentInput.weightGrams,swissCustoms:prepared.swissCustoms},orderSnapshot:structuredClone(s.order),reason:input.reason??"Normale DHL-Labelerstellung",actor,labelContent:null,originalLabelContent:null,customsDocContent:null,commercialInvoiceContent:null,customsPrintContent:null,priorLabelUrl:null,cancellationSource:null,createdAt:new Date(),updatedAt:new Date()};
    if(kind==="create")await s.markNormalCreatePending();
    await s.saveGeneration(g);
   }
   const op:LabelOperation={id:randomUUID(),generationId:g!.id,idempotencyKey:key,requestHash,kind,state:"pending",actor,reason:input.reason??"Normale DHL-Labelerstellung",result:null,createdAt:new Date(),finishedAt:null};
   if(kind==="attest") {
    if(pending){pending.state="rejected";pending.finishedAt=new Date();pending.result={...pending.result!,body:{...pending.result?.body,reconciledByAttestation:op.id}};await s.saveOperation(pending);}
    g!.state="cancelled";g!.cancellationSource="admin_attestation";g!.updatedAt=new Date();
    await s.saveGeneration(g!);op.state="succeeded";op.result=this.cancelSuccess(input.orderId,g!);op.finishedAt=new Date();await s.saveOperation(op);
    return {result:op.result};
   }
   if(kind==="cancel"){g!.state="cancel_pending";g!.updatedAt=new Date();await s.saveGeneration(g!);}
   await s.saveOperation(op);
   return {g:g!,op,prepared};
  });
  if("result" in reservation)return reservation.result!;
  // Pending operation is committed BEFORE sending POST/DELETE. A crash leaves it blocked.
  const {g,op,prepared}=reservation;
  if(kind==="cancel") {
   let outcome:DhlCancellationResult;
   try{outcome=await this.api.cancel(g.trackingNumber!);}catch{outcome={outcome:"unknown"};}
   return this.store.withOrder(input.orderId,async s=>{
    const saved=s.generations.find(v=>v.id===g.id)!;const operation=s.operations.find(v=>v.id===op.id)!;
    saved.state=outcome.outcome==="cancelled"?"cancelled":outcome.outcome==="unknown"?"cancel_unknown":outcome.outcome==="manifested"?"manifested":outcome.outcome==="delivered"?"delivered":"cancel_rejected";
    saved.cancellationSource=outcome.outcome==="cancelled"?"dhl":null;saved.updatedAt=new Date();
    operation.state=outcome.outcome==="cancelled"?"succeeded":outcome.outcome==="unknown"?"unknown":"rejected";
    operation.finishedAt=new Date();operation.result=outcome.outcome==="cancelled"?this.cancelSuccess(input.orderId,saved):resultError(outcome.outcome==="unknown"?"OUTCOME_UNKNOWN":outcome.outcome==="manifested"?"MANIFESTED":outcome.outcome==="delivered"?"DELIVERED":"DHL_REJECTED",outcome.error??"DHL-Stornierung nicht bestätigt",saved,outcome.outcome==="rejected"?502:409);
    await s.saveGeneration(saved);await s.saveOperation(operation);return operation.result;
   });
  }
  let shipment:DhlShipmentResult;
  try{shipment=await this.api.create(prepared!);}catch{shipment={success:false,outcome:"unknown",error:"DHL-Erstellungsergebnis unbekannt"};}
  const rejected=!shipment.success&&shipment.outcome!=="unknown"&&!shipment.trackingNumber&&(shipment.outcome==="rejected"||shipment.statusCode===undefined);
  if(!shipment.success||!shipment.trackingNumber){return this.finishFailed(input.orderId,g,op,shipment,rejected?"create_rejected":"create_unknown",rejected?"DHL_REJECTED":"OUTCOME_UNKNOWN",rejected);}
  // Persist known tracking and ALL raw PDFs before the CH document builders.
  await this.store.withOrder(input.orderId,async s=>{const saved=s.generations.find(v=>v.id===g.id)!;saved.trackingNumber=shipment.trackingNumber!;saved.originalLabelContent=shipment.labelBase64??null;saved.customsDocContent=shipment.customsDocBase64??null;saved.updatedAt=new Date();await s.saveGeneration(saved);});
  let docs:Awaited<ReturnType<Dependencies["documents"]>>;
  try{docs=await this.api.documents(prepared!,shipment);if(kind==="replace"&&!docs.labelContent)throw Error("Kein druckbares Ersatzlabel gespeichert");}catch{return this.finishFailed(input.orderId,g,op,shipment,"documents_failed","DOCUMENTS_FAILED",false);}
  return this.store.withOrder(input.orderId,async s=>{
   const saved=s.generations.find(v=>v.id===g.id)!;const operation=s.operations.find(v=>v.id===op.id)!;
   // A non-DHL concurrent external-label update must never be blindly overwritten.
   const source=kind==="replace"?input.oldTrackingNumber:null;
   if(s.order.trackingNumber!==source || (kind==="create"&&s.order.shippingLabelUrl))throw new DhlLabelError(409,"LABEL_CONFLICT","Bestelltracking wurde während der Erstellung geändert; Ergebnis gesperrt, extern prüfen");
   Object.assign(saved,docs,{state:"active",updatedAt:new Date()});
   await s.publishLabel(saved);await s.saveGeneration(saved);
   operation.state="succeeded";operation.finishedAt=new Date();operation.result={httpStatus:200,body:{success:true,orderId:input.orderId,generationId:saved.id,state:saved.state,trackingNumber:saved.trackingNumber,labelUrl:`/api/shipping/dhl/label/${input.orderId}`,hasContent:Boolean(saved.labelContent),customsInvoiceStored:prepared!.profileKey==="DHL_CH"&&Boolean(saved.commercialInvoiceContent&&saved.customsDocContent),sandbox:ENV.dhlSandbox}};
   await s.saveOperation(operation);return operation.result;
  });
 }
 private cancelSuccess(orderId:string,g:LabelGeneration):OperationResult{return {httpStatus:200,body:{success:true,orderId,generationId:g.id,state:"cancelled",trackingNumber:g.trackingNumber,cancellationSource:g.cancellationSource}};}
 private async finishFailed(orderId:string,g:LabelGeneration,op:LabelOperation,shipment:DhlShipmentResult,state:GenerationState,code:string,rejected:boolean){return this.store.withOrder(orderId,async s=>{
  const saved=s.generations.find(v=>v.id===g.id)!;const operation=s.operations.find(v=>v.id===op.id)!;
  saved.state=state;saved.trackingNumber=shipment.trackingNumber??saved.trackingNumber;saved.originalLabelContent=shipment.labelBase64??saved.originalLabelContent;saved.customsDocContent=shipment.customsDocBase64??saved.customsDocContent;saved.updatedAt=new Date();
  operation.state=rejected?"rejected":"unknown";operation.finishedAt=new Date();operation.result=resultError(code,shipment.error??"DHL-Label bereits gebucht, Dokumente unvollständig; kein zweites Label auslösen",saved,rejected?502:409);
  if(rejected&&op.kind==="create")await s.releaseRejectedNormalCreate();
  await s.saveGeneration(saved);await s.saveOperation(operation);return operation.result;
 });}
 async history(orderId:string){return this.store.withOrder(orderId,async s=>{
  const g=current(s);const blocked=Boolean(unresolved(s)||s.order.trackingCarrier==="DHL_PENDING");
  const safe=g&&!knownDelivered(s,g)&&matchesOrder(s,g)&&g.state!=="manifested";
  return {success:true,orderId,currentGenerationId:g?.id??null,addressFingerprint:addressFingerprint(s.order),currentRecipient:recipientFromOrder(s.order),orderStatus:s.order.status,blocked,canCancel:Boolean(safe&&!blocked&&["active","cancel_rejected"].includes(g!.state)),canReplace:Boolean(safe&&!blocked&&g!.state==="cancelled"),canAttestCancellation:Boolean(safe&&["active","cancel_rejected","cancel_unknown"].includes(g!.state)&&(!blocked||(unresolved(s)?.kind==="cancel"&&unresolved(s)?.state==="unknown"))),generations:[...s.generations].reverse().map(v=>({generationId:v.id,generation:v.generation,state:v.state,trackingNumber:v.trackingNumber,shippingProfile:v.shippingProfile,recipient:v.recipient,recipientVerified:v.request.originalRecipientUnverified!==true,reason:v.reason,cancellationSource:v.cancellationSource,createdAt:v.createdAt,updatedAt:v.updatedAt,hasLabel:Boolean(v.labelContent||v.originalLabelContent),hasCustomsDocuments:Boolean(v.commercialInvoiceContent),labelUrl:v.labelContent||v.originalLabelContent?`/api/shipping/dhl/label-generation/${orderId}/${v.id}`:null,documentsUrl:v.commercialInvoiceContent?`/api/shipping/dhl/label-generation-documents/${orderId}/${v.id}`:null})),operations:s.operations.map(o=>({idempotencyKey:o.idempotencyKey,kind:o.kind,state:o.state,createdAt:o.createdAt,finishedAt:o.finishedAt}))};
 });}
 async document(orderId:string,generationId:string,kind:"label"|"invoice"){return this.store.withOrder(orderId,async s=>{
  const g=s.generations.find(v=>v.id===generationId);const content=kind==="label"?g?.labelContent??g?.originalLabelContent:g?.commercialInvoiceContent;
  if(!content)throw new DhlLabelError(404,"DOCUMENT_NOT_FOUND","Kein gespeichertes Dokument für diese Generation");return content;
 });}
}
