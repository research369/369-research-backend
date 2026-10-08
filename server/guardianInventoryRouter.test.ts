import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import pg from 'pg';
import {guardianInventoryRouter,guardianInventorySql,guardianKeyValid} from './guardianInventoryRouter.js';
test('Guardian key is separate and fails closed',()=>{
 delete process.env.GUARDIAN_INVENTORY_READ_KEY;process.env.JARVY_READ_KEY='j'.repeat(64);
 assert.equal(guardianKeyValid('Bearer '+process.env.JARVY_READ_KEY),false);
 process.env.GUARDIAN_INVENTORY_READ_KEY='g'.repeat(64);
 assert.equal(guardianKeyValid('Bearer '+'g'.repeat(64)),true);
 assert.equal(guardianKeyValid('Bearer '+'j'.repeat(64)),false);
});
test('fixed inventory projection contains no customer or credential columns',()=>{
 assert.match(guardianInventorySql,/FROM articles ORDER BY id LIMIT 5001/);
 assert.doesNotMatch(guardianInventorySql,/SELECT \*|email|customer|password|purchase_price|notes/i);
});
test('inventory SQL reads real PostgreSQL JSON and null variants', {skip:!process.env.GUARDIAN_TEST_DB}, async()=>{
 const client=new pg.Client({connectionString:process.env.GUARDIAN_TEST_DB});await client.connect();
 try{
  await client.query('CREATE TEMP TABLE articles(id int,sku text,shop_product_id text,stock int,is_active int,shop_visible int,variants json)');
  await client.query(`INSERT INTO articles VALUES (1,'RET-10','3g',3,1,1,'[{"dosage":"10 mg","inventoryArticleId":1,"stock":999,"private":"omit"}]'),(2,'RET-20','3g',0,1,0,null)`);
  await client.query('BEGIN READ ONLY');
  const result=await client.query(guardianInventorySql);
  assert.equal(result.rows.length,2);assert.equal(result.rows[0].stock,3);
  assert.equal(result.rows[0].variants[0].inventoryArticleId,1);
  assert(!JSON.stringify(result.rows).includes('private'));assert.deepEqual(result.rows[1].variants,[]);
  await assert.rejects(()=>client.query('CREATE TABLE guardian_forbidden(id int)'));
  await client.query('ROLLBACK');
 }finally{await client.end();}
});
test('unauthenticated access, query parameters and writes denied before DB',async()=>{
 process.env.GUARDIAN_INVENTORY_READ_KEY='g'.repeat(64);
 const app=express();app.use('/api/guardian',guardianInventoryRouter);
 const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api/guardian/inventory';
 try{
  assert.equal((await fetch(url)).status,401);
  const headers={authorization:'Bearer '+'g'.repeat(64)};
  for(const method of ['POST','PUT','DELETE','HEAD'])assert.equal((await fetch(url,{method,headers})).status,405);
  assert.equal((await fetch(url+'?sql=SELECT',{headers})).status,405);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
