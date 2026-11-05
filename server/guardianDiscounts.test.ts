import {test} from 'node:test';import assert from 'node:assert/strict';
import {projectDiscountRules,guardianPromoSql,guardianPartnerSql} from './guardianDiscounts.js';
const promo={code:'TEST',discount_type:'percent',percentage:'20',fixed_amount:'0',min_order:'50',max_uses:2,current_uses:0,valid_from:null,valid_until:null,valid_until_exact:0,is_active:1,description:'private note | {"restrict":["ghk-cu"],"freeShipping":["de"],"maxPerCustomer":1}'};
test('fixed projection exports rules only; inactive/expired/exhausted codes remain negative cases',()=>{
 const now=new Date('2026-10-13T12:00:00Z');
 const d=projectDiscountRules([promo,{...promo,code:'EXPIRED',valid_until:'2026-10-12'},{...promo,code:'FUTURE',valid_from:'2026-10-14'},{...promo,code:'USED',current_uses:2}],[{code:'CREATOR',percentage:'15',active:true,kind:'creator',policy:'each_valid_code_use',email:'private@example.com'}],now);
 assert.deepEqual(d.codes.map(c=>c.active),[true,false,false,false,true]);
 assert.deepEqual(d.codes[0].restrict,['ghk-cu']);assert.equal(d.codes[0].customer_limit,1);
 assert(!JSON.stringify(d).includes('private'));assert(!JSON.stringify(d).includes('email'));
 assert.doesNotMatch(guardianPromoSql+guardianPartnerSql,/SELECT \*|password|balance|email|address|orders/i);
});
test('discount rule projection fails closed for duplicates, oversized rate and incomplete source',()=>{
 assert.throws(()=>projectDiscountRules([promo,promo],[]));
 assert.throws(()=>projectDiscountRules([{...promo,percentage:'101'}],[]));
 assert.throws(()=>projectDiscountRules([{...promo,description:'text | {invalid'}],[]));
 assert.throws(()=>projectDiscountRules(Array(501).fill(promo),[]));
});
