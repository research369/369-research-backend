import test from 'node:test';
import assert from 'node:assert/strict';
import {jarvyOrderRequest,orderHash} from './jarvyOrderContract.js';
test('order input accepts exact existing identity and inventory references only',()=>{
 const x={customerId:1,items:[{sku:'BOTTLE',quantity:2}],paymentMethod:'SEPA'};
 assert.equal(jarvyOrderRequest.parse(x).sendOrderConfirmation,false);
 for(const bad of [{...x,total:0},{...x,stockOverride:{enabled:true}},{...x,customerId:0},{...x,items:[{sku:'X',quantity:0}]},{...x,items:[{sku:'X',quantity:1},{sku:'x',quantity:1}]}])assert.throws(()=>jarvyOrderRequest.parse(bad));
});
test('preview hash binds every financial, target and confirmation field',()=>{
 const x={customerId:1,total:18,confirmation:false,items:[{sku:'A',quantity:1}]};
 assert.equal(orderHash(x),orderHash({items:x.items,confirmation:false,total:18,customerId:1}));
 for(const next of [{...x,total:19},{...x,customerId:2},{...x,confirmation:true},{...x,items:[{sku:'A',quantity:2}]}])assert.notEqual(orderHash(x),orderHash(next));
});
