import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createWhatsappScreenshotRouter,validSelfOrderKey,SELF_ORDER_PHONE} from './whatsappScreenshotRouter.js';
const key='synthetic-self-order-key-not-live-'.repeat(2);
test('operator bridge is disabled by default and never accepts shared read credentials',()=>{
 const env={WHATSAPP_SCREENSHOT_ENABLED:'on',WHATSAPP_SCREENSHOT_KEY:key};
 assert.equal(validSelfOrderKey('Bearer '+key,env),true);
 assert.equal(validSelfOrderKey('Bearer '+key,{}),false);
 assert.equal(validSelfOrderKey('Bearer '+key,{...env,PEPGPT_OFFERS_READ_KEY:key}),false);
 assert.equal(validSelfOrderKey('Bearer '+key,{...env,JARVY_READ_KEY:key}),false);
 assert.equal(validSelfOrderKey('Bearer wrong',env),false);
});
test('HTTP bridge binds the existing actor, self phone and operation; no execute without separate enable',async()=>{
 const saved={...process.env};let execute=0,extract=0,actorLookups=0;
 process.env.WHATSAPP_SCREENSHOT_ENABLED='on';process.env.WHATSAPP_SCREENSHOT_KEY=key;delete process.env.WHATSAPP_SCREENSHOT_EXECUTE;
 const app=express();app.use(express.json());app.use('/bridge',createWhatsappScreenshotRouter({actor:async()=>{actorLookups++;return {id:7,username:'synthetic',name:null,email:null,role:'admin'};},extract:async(_input,id)=>{extract++;assert.equal(id,7);return {synthetic:true} as any;},execute:async()=>{execute++;return {state:'succeeded',orderId:'SYNTHETIC',idempotencyKey:'synthetic'};}}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const port=(server.address() as any).port;
 const post=(path:string,body:any,auth='Bearer '+key)=>fetch(`http://127.0.0.1:${port}/bridge/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:auth},body:JSON.stringify(body)});
 try{
  assert.equal((await post('extract',{operator:SELF_ORDER_PHONE,payload:{text:'synthetic order'}},'Bearer bad')).status,401);assert.equal(actorLookups,0);
  assert.equal((await post('extract',{operator:'491714780720',payload:{text:'synthetic order'}})).status,400);
  assert.equal((await post('extract',{operator:SELF_ORDER_PHONE,payload:{text:'synthetic order'},actorId:99})).status,400);
  assert.equal((await post('extract',{operator:SELF_ORDER_PHONE,payload:{text:'synthetic order'}})).status,200);assert.equal(extract,1);
  assert.equal((await post('execute',{operator:SELF_ORDER_PHONE,payload:{quoteToken:'x'.repeat(80),confirmed:true}})).status,403);assert.equal(execute,0);
  assert.equal((await post('arbitrary-admin-call',{operator:SELF_ORDER_PHONE,payload:{}})).status,404);
  assert.equal((await post('extract?phone=secret',{operator:SELF_ORDER_PHONE,payload:{text:'synthetic order'}})).status,405);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
});
