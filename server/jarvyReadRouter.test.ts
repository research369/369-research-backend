import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import express from 'express';
import {buildJarvyReadQuery,parseJarvyReadInput,validJarvyReadKey,jarvyReadRouter} from './jarvyReadRouter.js';

test('dedicated key fails closed; no admin/internal key fallback',()=>{
  const key='x'.repeat(64);
  assert.equal(validJarvyReadKey(undefined,'Bearer '+key),false);
  assert.equal(validJarvyReadKey('short','Bearer short'),false);
  assert.equal(validJarvyReadKey(key,'Bearer '+key),true);
  assert.equal(validJarvyReadKey(key,'Bearer '+'y'.repeat(64)),false);
  assert.equal(validJarvyReadKey(key,key),false);
});
test('reject writes, arbitrary arguments, invalid dates and unbounded queries',()=>{
  for(const body of [{operation:'delete'},{operation:'orders',sql:'SELECT 1'},{operation:'orders',limit:999},{operation:'sales_summary'},{operation:'orders',from:'2026-02-30'},{operation:'orders',from:'2026-10-05',until:'2026-10-04'},{operation:'customers'},{operation:'customer',id:'1 OR TRUE'}])assert.throws(()=>parseJarvyReadInput(body));
});
test('search is a literal parameter, never interpolated or LIKE wildcard',()=>{
  const attack="%' OR 1=1 --";
  const query=buildJarvyReadQuery(parseJarvyReadInput({operation:'orders',search:attack,customerId:7,from:'2026-10-01',until:'2026-11-01'}));
  assert.equal(query.text.includes(attack),false);
  assert.ok(query.values.includes(attack));
  assert.match(query.text,/customer_id=\$/);assert.match(query.text,/order_date < \$2::date/);
  assert.match(query.text,/LIMIT \$5 OFFSET \$6/);
});
test('sales figures use complete SQL aggregates and expose cancelled/open separately',()=>{
  const query=buildJarvyReadQuery(parseJarvyReadInput({operation:'sales_summary',from:'2026-10-01',until:'2026-11-01'}));
  assert.doesNotMatch(query.text,/LIMIT|OFFSET/);
  assert.match(query.text,/cancelled_orders/);assert.match(query.text,/open_order_value_eur/);
  assert.match(query.text,/'abgeholt'/);assert.match(query.text,/total>0/);
});
test('customer detail uses only exact customer id; no identity merging',()=>{
  const query=buildJarvyReadQuery(parseJarvyReadInput({operation:'customer',id:'42'}));
  assert.match(query.text,/WHERE id=\$1 LIMIT 1$/);assert.deepEqual(query.values,[42]);
  assert.doesNotMatch(query.text,/total_spent|password|totp|screenshot/);
});
test('HTTP route denies missing credentials and every write-shaped operation before DB use',async()=>{
  process.env.JARVY_READ_KEY='t'.repeat(64);
  const app=express();app.use(express.json());app.use('/api/jarvy-read',jarvyReadRouter);
  const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const addr=server.address() as {port:number};const url=`http://127.0.0.1:${addr.port}/api/jarvy-read/query`;
  try{
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"operation":"orders"}'})).status,401);
    const headers={'authorization':'Bearer '+'t'.repeat(64),'content-type':'application/json'};
    assert.equal((await fetch(url,{method:'DELETE',headers})).status,405);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{"operation":"delete"}'})).status,400);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));delete process.env.JARVY_READ_KEY;}
});

 test('article search returns bounded active catalog rows for exact order selection',()=>{
 const q=buildJarvyReadQuery(parseJarvyReadInput({operation:'articles',search:'Bottle',limit:5}));
 assert.match(q.text,/is_active=1/);assert.match(q.text,/selling_price/);assert.deepEqual(q.values,['Bottle',6,0]);
 });
