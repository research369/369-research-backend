import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {createServer} from 'node:http';
import {projectOffers,type OfferArticle} from './pepgptOffers.js';import {pepgptOffersRouter} from './pepgptOffersRouter.js';
const parent:OfferArticle={id:1,name:'Produkt Alpha',sku:'A',shop_product_id:'a',selling_price:'100',sale_price:null,stock:999,is_active:1,shop_visible:1,variants:[{dosage:'10 mg',price:70,inventoryArticleId:2,stock:999},{dosage:'20 mg',price:120,inventoryArticleId:3}]};
const stock=(id:number,qty:number):OfferArticle=>({...parent,id,name:'Produkt Alpha '+(id===2?'10 mg':'20 mg'),sku:'A-'+id,stock:qty,shop_visible:0,variants:[]});
const code=(extra={})=>({code:'TEST10',discount_type:'percent',percentage:'10',fixed_amount:'0',min_order:'0',max_uses:0,current_uses:0,valid_from:null,valid_until:null,valid_until_exact:0,is_active:1,description:'',...extra});
const now=new Date('2026-10-20T06:00:00Z'),input={search:'Produkt Alpha',quantity:1,country:'DE',promotion:{mode:'explicit_code' as const,code:'TEST10'}};
test('Echter Variantenbestand und gültiger Rabatt statt JSON-Bestand',()=>{const r=projectOffers([parent,stock(2,3),stock(3,0)],[code()],null,input,now);assert.equal(r.offers[0].stock,3);assert.equal(r.offers[1].available,false);assert.equal(r.offers[0].unit_price,70);assert.equal(r.offers[0].promotions[0].total,71);});
test('Abgelaufen, Zukunft, Limit, Mindestwert und falsches Produkt ausgeschlossen',()=>{for(const c of [code({valid_until:'2026-10-18'}),code({valid_from:'2026-11-01'}),code({max_uses:2,current_uses:2}),code({min_order:100}),code({description:' | {"restrict":["b"]}'})])assert.throws(()=>projectOffers([parent,stock(2,3)],[c],null,input,now),/promotion_not_eligible/);});
test('Unbekannte Lagerzuordnung bleibt unbekannt',()=>{assert.equal(projectOffers([parent],[],null,{...input,promotion:{mode:'none'}},now).offers[0].available,null);});
test('Globalrabatt und Code korrekt nacheinander',()=>{const global=JSON.stringify({enabled:true,percentage:20,startsAt:null,expiresAt:'2026-10-21T00:00:00.000Z',stackWithPromotionCodes:true,labelDe:'Aktion',labelEn:'Sale'});const o=projectOffers([parent,stock(2,3)],[code()],global,input,now).offers[0];assert.equal(o.product_total,56);assert.equal(o.promotions[0].product_total,50.4);});
test('Nicht kombinierbarer Code bleibt in der Angebotsvorschau gültig und ersetzt den globalen Freiversand',()=>{const global=JSON.stringify({enabled:true,percentage:20,startsAt:null,expiresAt:'2026-10-21T00:00:00.000Z',freeShippingEnabled:true,freeShippingMinOrder:50,freeShippingRegions:['de'],stackWithPromotionCodes:false,stackWithPartnerCreatorCodes:true,stackWithKwk:true,labelDe:'Aktion',labelEn:'Sale'});const o=projectOffers([parent,stock(2,3)],[code()],global,input,now).offers[0];assert.equal(o.product_total,56);assert.equal(o.shipping,0);assert.equal(o.promotions[0].product_total,63);assert.equal(o.promotions[0].shipping,8);assert.equal(o.promotions[0].total,71);});
test('Keine Schreibroute oder Kundenzugriff',async()=>{process.env.PEPGPT_OFFERS_READ_KEY='t'.repeat(64);const app=express();app.use(express.json());app.use('/api/pepgpt-read',pepgptOffersRouter);const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(server.address() as any).port+'/api/pepgpt-read';try{assert.equal((await fetch(base+'/offers',{method:'POST'})).status,401);const headers={authorization:'Bearer '+'t'.repeat(64),'Content-Type':'application/json'};for(const endpoint of ['/orders','/customers'])assert.equal((await fetch(base+endpoint,{method:'POST',headers})).status,405);assert.equal((await fetch(base+'/offers',{method:'POST',headers,body:JSON.stringify({...input,sql:'x'})})).status,400);}finally{server.close();}});

test('Phase 1 bietet ohne expliziten Code keinen automatischen Code an',()=>{assert.equal(projectOffers([parent,stock(2,3)],[code()],null,{...input,promotion:{mode:'none'}},now).offers[0].promotions.length,0);});
test('Freigegebene WaWi-Substitution erfüllt 20 mg mit 2x10 mg ohne Preisänderung oder Bestandsbuchung',()=>{
 const articles=[parent,stock(2,2),stock(3,0)],before=JSON.stringify(articles);
 const o=projectOffers(articles,[code()],null,{...input,dosage:'20 mg'},now,true).offers[0];
 assert.equal(o.available,true);assert.equal(o.stock,0);assert.equal(o.unit_price,120);assert.equal(o.promotions[0].product_total,108);
 assert.deepEqual(o.fulfillment.components.map((c:any)=>[c.inventory_article_id,c.quantity,c.content_mg]),[[2,2,10]]);assert.equal(o.fulfillment.total_content_mg,20);assert.equal(JSON.stringify(articles),before);
});
test('Substitution bleibt bei ausgeschaltetem Schalter, falscher Form/Familie und fehlendem Bestand gesperrt',()=>{
 const q={...input,dosage:'20 mg',promotion:{mode:'none' as const}};
 for(const articles of [[parent,stock(2,1),stock(3,0)],[parent,{...stock(2,4),shop_product_id:'anderes-produkt'},stock(3,0)],[parent,{...stock(2,4),category:'Kapseln'},stock(3,0)]])assert.equal(projectOffers(articles,[],null,q,now,true).offers[0].available,false);
 assert.equal(projectOffers([parent,stock(2,4),stock(3,0)],[],null,q,now,false).offers[0].available,false);
});
test('Teilbestand wird gemeinsam mit kleineren freigegebenen Varianten exakt geplant',()=>{
 const o=projectOffers([parent,stock(2,2),stock(3,1)],[],null,{...input,dosage:'20 mg',quantity:2,promotion:{mode:'none'}},now,true).offers[0];
 assert.equal(o.available,true);assert.equal(o.fulfillment.total_content_mg,40);assert.deepEqual(o.fulfillment.components.map((c:any)=>[c.quantity,c.content_mg]),[[1,20],[2,10]]);
});
