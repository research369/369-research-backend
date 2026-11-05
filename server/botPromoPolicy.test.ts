import test from 'node:test';import assert from 'node:assert/strict';
import{approvedBotPromos}from './botPromoPolicy.js';
import{projectOffers,type OfferArticle}from './pepgptOffers.js';
const policy=(codes:any[],enabled=true)=>JSON.stringify({version:1,enabled,codes});
test('positive approval only; disabled, missing, malformed, duplicate fail closed',()=>{
 const entry={code:'PUBLIC10',bot_auto_apply:true,bot_priority:5};
 for(const p of [null,'{}',policy([entry],false),policy([{...entry,bot_auto_apply:false}]),policy([entry,entry])])assert.equal(approvedBotPromos(p).size,0);
 assert.equal(approvedBotPromos(policy([entry])).get('PUBLIC10'),5);
});
const article:OfferArticle={id:1,name:'Alpha',sku:'ALPHA',shop_product_id:'alpha',selling_price:'100',sale_price:null,stock:10,is_active:1,shop_visible:1,variants:null};
const promo=(code:string,extra={})=>({code,discount_type:'percent',percentage:'10',fixed_amount:'0',min_order:'0',max_uses:0,current_uses:0,valid_from:null,valid_until:null,valid_until_exact:0,is_active:1,description:'',...extra});
const now=new Date('2026-10-20T06:00:00Z');const input={search:'Alpha',quantity:1,country:'DE',promotion:{mode:'bot_approved' as const}};
test('best eligible approved code only; private/unapproved never selected',()=>{
 const o=projectOffers([article],[promo('INTERNAL90',{percentage:'90'}),promo('PUBLIC10',{bot_auto_apply:true}),promo('PUBLIC20',{percentage:'20',bot_auto_apply:true})],null,input,now).offers[0];
 assert.equal(o.unit_price,100);assert.equal(o.promotions.length,1);assert.equal(o.promotions[0].code,'PUBLIC20');assert.equal(o.promotions[0].total,88);assert.equal(o.promotions[0].bot_approved,true);
});
test('expired, future, exhausted, minimum, product and personal restrictions stay enforced',()=>{
 for(const extra of [{valid_until:'2026-10-18'},{valid_from:'2026-11-01'},{max_uses:1,current_uses:1},{min_order:101},{description:' | {"restrict":["other"]}'}]) {
 const o=projectOffers([article],[promo('PUBLIC10',{bot_auto_apply:true,...extra})],null,input,now).offers[0];assert.equal(o.promotions.length,0,JSON.stringify(extra));
 }
});
test('none still no automatic promotion; explicit retains exact code',()=>{
 assert.equal(projectOffers([article],[promo('PUBLIC10',{bot_auto_apply:true})],null,{...input,promotion:{mode:'none'}},now).offers[0].promotions.length,0);
 assert.equal(projectOffers([article],[promo('MYCODE')],null,{...input,promotion:{mode:'explicit_code',code:'MYCODE'}},now).offers[0].promotions[0].code,'MYCODE');
});

 test('Public customer-limited codes are conditional, never silently confirmed',()=>{
 const o=projectOffers([article],[promo('NEWME',{bot_auto_apply:true,description:'Neukunden | {"maxPerCustomer":1}'})],null,input,now).offers[0];
 assert.equal(o.promotions[0].requires_customer_eligibility_check,true);assert.equal(o.promotions[0].customer_limit,1);assert.equal(o.promotions[0].new_customer_only,true);
 const unconditional=projectOffers([article],[promo('PUBLIC5',{percentage:'5',bot_auto_apply:true}),promo('NEWME',{bot_auto_apply:true,description:'Neukunden | {"maxPerCustomer":1}'})],null,input,now).offers[0];
 assert.equal(unconditional.promotions[0].code,'PUBLIC5');
 assert.throws(()=>projectOffers([article],[promo('NEWME',{description:'Neukunden | {"maxPerCustomer":1}'})],null,{...input,promotion:{mode:'explicit_code',code:'NEWME'}},now),/promotion_not_eligible/);
 });
