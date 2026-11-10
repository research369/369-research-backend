import assert from "node:assert/strict";
import test from "node:test";
import { ENV } from "./env.js";
import { prepareDhlLabel, buildDhlLabelDocuments } from "./dhlLabelPreparation.js";
import type { LabelOrder } from "./dhlRelabelService.js";
import { PDFDocument } from "pdf-lib";
function order(){return {orderId:"ISOLATED-PREPARE",firstName:"Explicit",lastName:"Recipient",company:"",street:"New Road",houseNumber:"9",zip:"8000",city:"Zürich",country:"CH",email:"",phone:"",deliveryType:"home",dhlPostNumber:"",subtotal:"50",shipping:"5",discount:"0",weightGrams:9999} as LabelOrder;}
function pool(){return async()=>({query:async(_sql:string,params:any[])=>{assert.equal(params[0],"ISOLATED-PREPARE");return {rows:[{package_weight_grams:800,invoice_number:"CH-ISOLATED-PREPARE",created_at:new Date("2020-01-01"),compliance_confirmed_at:new Date(),order_item_id:1,item_description:"Research material",hs_code:null,country_of_origin:null,unit_weight_grams:100,unit_customs_value_eur:50,quantity:1}]};}} as any);}
test("CH replacement uses whole explicit address for label AND invoice while stored actual package weight wins",async()=>{
 const before={...ENV};Object.assign(ENV,{dhlBillingNumberEu:"00000000000000"});try{
 const p=await prepareDhlLabel(order(),{shippingProfile:"DHL_CH",weightGrams:12345},pool());
 assert.equal(p.shipmentInput.weightGrams,800);assert.equal(p.shipmentInput.consignee.name1,"Explicit Recipient");assert.equal(p.shipmentInput.consignee.name2,undefined);assert.equal(p.shipmentInput.consignee.addressStreet,"New Road");assert.equal(p.swissCustoms?.invoice.consignee.street,"New Road");assert.equal(p.swissCustoms?.invoice.consignee.name,"Explicit Recipient");assert.equal(p.swissCustoms?.invoice.invoiceNumber,"CH-ISOLATED-PREPARE");
 }finally{Object.assign(ENV,before);}
});
test("CH document pipeline still emits portrait label + two landscape CN23 pages and separate A4 invoices",async()=>{
 const before={...ENV};Object.assign(ENV,{dhlBillingNumberEu:"00000000000000"});try{
 const p=await prepareDhlLabel(order(),{shippingProfile:"DHL_CH"},pool());const label=await PDFDocument.create();label.addPage([283.464566929,425.196850394]).drawText("MOCK LABEL");const cn23=await PDFDocument.create();cn23.addPage([595.275590551,841.88976378]).drawText("MOCK CN23");
 const docs=await buildDhlLabelDocuments(p,{success:true,trackingNumber:"MOCK-ONLY",labelBase64:Buffer.from(await label.save()).toString("base64"),customsDocBase64:Buffer.from(await cn23.save()).toString("base64")});
 const thermal=await PDFDocument.load(Buffer.from(docs.labelContent!,"base64"));assert.equal(thermal.getPageCount(),3);const dimensions=thermal.getPages().map(p=>p.getSize());assert.ok(dimensions[0].height>dimensions[0].width);assert.ok(dimensions[1].width>dimensions[1].height);assert.ok(dimensions[2].width>dimensions[2].height);
 const invoice=await PDFDocument.load(Buffer.from(docs.commercialInvoiceContent!,"base64"));assert.equal(invoice.getPageCount(),2);for(const page of invoice.getPages())assert.ok(page.getWidth()>590&&page.getHeight()>840);
 }finally{Object.assign(ENV,before);}
});
test("destination/profile and Kleinpaket pickup guard remain unchanged",async()=>{
 const before={...ENV};Object.assign(ENV,{dhlBillingNumber:"00000000000000",dhlBillingNumberKleinpaket:"00000000000000"});try{
 await assert.rejects(prepareDhlLabel(order(),{shippingProfile:"DHL_DE_STANDARD"}),/Zielland/);
 await assert.rejects(prepareDhlLabel({...order(),country:"DE",deliveryType:"packstation",dhlPostNumber:"1234567",street:"Packstation",houseNumber:"123"},{shippingProfile:"DHL_DE_ECONOMY",weightGrams:800}),/Packstation/);
 }finally{Object.assign(ENV,before);}
});
