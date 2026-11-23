import assert from 'node:assert/strict';
import test,{before,after,beforeEach,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {Socket} from 'node:net';
import pg from 'pg';
const socket=process.env.SCREENSHOT_TEST_PG_SOCKET;
if(!socket||!/^\/tmp\/369-screenshot-order\.[A-Za-z0-9]+\/socket$/.test(socket)||realpathSync(socket)!==socket||process.env.DATABASE_URL||process.env.RAILWAY_DB_URL||process.env.DOTENV_CONFIG_PATH!=='/dev/null'||process.env.SCREENSHOT_TEST_SANITIZED!=='1')throw Error('DEDICATED_UNIX_ONLY_FIXTURE_REQUIRED');
const pool=new pg.Pool({host:socket,port:55464,user:'screenshot_local',database:'screenshot_local',max:12});
let app:any,service:any,contract:any,network=0,blockedSockets=0;
const actor={id:1,username:'local-screenshot-admin',name:'Local',email:null,role:'admin'};
const ctx=(user:any=actor)=>({req:{headers:{}},res:{setHeader:()=>{}},user});
const caller=(user:any=actor)=>app.createCaller(ctx(user)).screenshotOrder;
const request=(extra:any={})=>({draftId:randomUUID(),customer:{firstName:'Test',lastName:'Person',email:'new@example.test',phone:'+4915112345678',street:'Testweg',houseNumber:'1',zip:'1010',city:'Wien',country:'AT',deliveryType:'home'},items:[{sku:'TRIPLE-10MG',quantity:2}],discount:{mode:'none'},customerConfirmed:true,...extra});
const count=async(table:string)=>Number((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n);
const counts=async()=>({orders:await count('orders'),customers:await count('customers'),stockHistory:await count('stock_history'),receipts:await count('priority_checkout_receipts'),audit:await count('admin_change_events'),tasks:await count('priority_order_tasks'),sequence:(await pool.query('SELECT last_value,is_called FROM local_screenshot_order_seq')).rows[0],stock:(await pool.query('SELECT stock FROM articles WHERE id=1')).rows[0].stock});
const conflict=(e:any)=>e.code==='PRECONDITION_FAILED'&&/^[A-Z_]+: /.test(e.message);
const rejected=(reason:string)=>(e:any)=>conflict(e)&&e.message.startsWith(`${reason}: `);
const unknown=(e:any)=>e.code==='INTERNAL_SERVER_ERROR'&&e.message==='BOOKING_OUTCOME_UNKNOWN: Das Buchungsergebnis ist nicht eindeutig bestätigt. Bitte ausschließlich den Status der ursprünglichen Bestellung prüfen.';
before(async()=>{
 mock.method(globalThis,'fetch',async()=>{network++;throw Error('NETWORK_FORBIDDEN');});
 const connect=Socket.prototype.connect;mock.method(Socket.prototype,'connect',function(this:Socket,...args:any[]){const a=Array.isArray(args[0])?args[0][0]:args[0];const p=typeof a==='string'?a:a?.path;if(p!==`${socket}/.s.PGSQL.55464`){blockedSockets++;throw Error('NON_FIXTURE_SOCKET_FORBIDDEN');}return Reflect.apply(connect,this,args);} as any);
 const {ENV}=await import('./env.js');for(const k of Object.keys(ENV))if(/key|password|secret/i.test(k))(ENV as any)[k]='';
 const {closeDb}=await import('./db.js');await closeDb();ENV.databaseUrl=`postgresql://screenshot_local@localhost:55464/screenshot_local?host=${encodeURIComponent(socket!)}`;
 await (await import('./priorityOrderIntegrity.js')).ensurePriorityOrderIntegritySchema();
 await (await import('./customerOrderBlockService.js')).ensureCustomerOrderBlockSchema();
 await (await import('./adminChangeLogService.js')).ensureAdminChangeLogSchema();
 await (await import('./orderCommunicationPhoneService.js')).ensureOrderCommunicationPhoneSchema();
 await pool.query(`CREATE SEQUENCE local_screenshot_order_seq;
 CREATE FUNCTION next_order_id() RETURNS text LANGUAGE sql AS $$ SELECT 'LOCAL-'||nextval('local_screenshot_order_seq')::text $$;
 CREATE SEQUENCE local_screenshot_customer_seq START 1210;
 CREATE FUNCTION next_customer_number() RETURNS text LANGUAGE sql AS $$ SELECT nextval('local_screenshot_customer_seq')::text $$;
 CREATE TABLE substitution_config(id integer primary key,enabled boolean);INSERT INTO substitution_config VALUES(1,true);
 CREATE TABLE goodie_assignments(id serial primary key,order_id text);`);
 service=await import('./screenshotOrderService.js');contract=await import('./screenshotOrderContract.js');
 app=(await import('./trpc.js')).router({screenshotOrder:(await import('./screenshotOrderRouter.js')).screenshotOrderRouter});
 assert.deepEqual((await pool.query("SELECT inet_server_addr() address,current_setting('listen_addresses') listening")).rows[0],{address:null,listening:''});
});
beforeEach(async()=>{
 // Let optional audit journal promises settle before resetting the isolated fixture.
 await new Promise(r=>setTimeout(r,30));
 await pool.query('TRUNCATE priority_checkout_receipts,priority_order_tasks,admin_change_events,orders,order_items,customers,articles,stock_history,promo_codes,shop_settings,communication_templates,customer_order_blocks,order_communication_phone_override_events RESTART IDENTITY CASCADE');
 await pool.query("ALTER SEQUENCE local_screenshot_order_seq RESTART WITH 1; ALTER SEQUENCE local_screenshot_customer_seq RESTART WITH 1210");
 await pool.query("INSERT INTO users(id,username,password_hash,role) VALUES(1,'local-screenshot-admin','unused','admin'),(2,'other-admin','unused','admin') ON CONFLICT(id) DO UPDATE SET role='admin'");
 await pool.query(`INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,is_active,shop_visible,published_at,category,variants)
 VALUES('TRIPLE-10MG','3G - TRIPLE G (10 mg)','3g',25.55,20,1,1,'2026-01-01','Vials','[{"label":"10 mg","sku":"TRIPLE-10MG","inventoryArticleId":1,"price":25.55}]'),
 ('TRIPLE-20MG','3G - TRIPLE G (20 mg)','3g',50.00,10,1,0,NULL,'Vials','[]'),
 ('TIRZE-10MG','Tirzepatide (10 mg)','tirzepatide',19.99,8,1,1,'2026-01-01','Vials','[]'),
 ('NASAL-10MG','Tirzepatide Nasenspray (10 mg)','nasal',30,8,1,1,'2026-01-01','Nasensprays','[]'),
 ('DRAFT-10MG','Draft Test (10 mg)','draft',0,8,1,0,NULL,'Vials','[]');
 INSERT INTO shop_settings(key,value) VALUES('address_validation_enabled','false');
 INSERT INTO shop_settings(key,value) VALUES('bank_transfer_payment_instructions','{"enabled":true,"checkoutLabelDe":"Wise","checkoutLabelEn":"Wise","checkoutHintDe":"Wise","checkoutHintEn":"Wise","accounts":[{"id":"wise","labelDe":"Wise","labelEn":"Wise","accountHolder":"Synthetic Holder","iban":"DE00000000000000000000","bic":"SYNTHETIC"}]}');
 INSERT INTO communication_templates(template_key,channel,language,title,body_template) VALUES('order_confirmation','whatsapp','de','Local Order','Hallo {{firstName}}, Bestellung {{orderId}}\n{{items}}\nGesamt {{total}}\n{{paymentDetails}}');`);
});
after(async()=>{try{assert.equal(network,0);assert.equal(blockedSockets,0);console.log(`Screenshot isolation: HTTP=${network}; non-fixture sockets=${blockedSockets}; unix-only port 55464.`);}finally{await (await import('./db.js')).closeDb();(await import('./env.js')).ENV.databaseUrl='';await pool.end();mock.restoreAll();}});
test('anonymous and wrong roles denied; secret unavailable only disables quote, not manual lookup',async()=>{
 await assert.rejects(caller(null).customers({name:'Test'}),(e:any)=>e.code==='UNAUTHORIZED');
 for(const role of ['packing','product_manager','user'])await assert.rejects(caller({...actor,role}).quote(request()),(e:any)=>e.code==='FORBIDDEN');
 const caps=await caller().capabilities();assert.equal(caps.available,false);
 const secret=process.env.JWT_SECRET;try{process.env.JWT_SECRET='';await assert.rejects(caller().quote(request()),conflict);assert((await caller().catalog({query:'Reta'})).candidates.length>0);}finally{process.env.JWT_SECRET=secret;}
});
test('alias catalog is exact by mg/form; drafts and ambiguous duplicate inventory are rejected',async()=>{
 for(const alias of ['Reta','R3ta','Retatrutide']){const c=await caller().catalog({query:alias,strength:'10mg',form:'vial'});assert.deepEqual(c.candidates.map((x:any)=>x.sku),['TRIPLE-10MG']);}
 assert.equal((await caller().catalog({query:'Tierze',strength:'10 mg',form:'vial'})).candidates[0].sku,'TIRZE-10MG');
 assert.equal((await caller().catalog({query:'Tirze',form:'nasal'})).candidates.length,0); // No BAC inventory fixture yet.
 assert.equal((await caller().catalog({query:'Reta',strength:'20 mg'})).candidates.length,0);
 await assert.rejects(caller().quote(request({items:[{sku:'DRAFT-10MG',quantity:1}]})),conflict);
 await assert.rejects(caller().quote(request({items:[{sku:'NASAL-10MG',quantity:1}]})),rejected('EXACT_PUBLISHED_SKU_REQUIRED')); // Missing tracked BAC component, not a form ban.
 const rows=[{id:1,sku:'DUP',name:'Dup (10 mg)',isActive:1,shopVisible:1,publishedAt:new Date(),sellingPrice:'10',salePrice:null,stock:10,category:'Vials',variants:[],shopProductId:'dup'},{id:2,sku:'dup',name:'Dup (10 mg)',isActive:1,shopVisible:1,publishedAt:new Date(),sellingPrice:'10',salePrice:null,stock:10,category:'Vials',variants:[],shopProductId:'dup'}];assert.equal(service.screenshotCatalogProjection(rows).length,0);
});
test('quote does not allocate sequences, customers, orders, stock, receipt, tasks or audit; supports canonical cents/manual caps',async()=>{
 const before=await counts();const q=await caller().quote(request({discount:{mode:'percent',value:12.5}}));assert.equal(q.preview.subtotal,51.1);assert.equal(q.preview.discount,6.39);assert.equal(q.preview.shipping,15);assert.equal(q.preview.total,59.71);assert.deepEqual(await counts(),before);
 const capped=await caller().quote(request({discount:{mode:'amount',value:999}}));assert.equal(capped.preview.discount,51.1);assert.equal(capped.preview.total,15);assert.deepEqual(await counts(),before);
});
test('automatic benefits, BAC freebies and code are canonical, exclusive mode rejects negotiated discounts',async()=>{
 await pool.query(`INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1)`,[JSON.stringify({enabled:true,percentage:10,expiresAt:'2099-01-01T00:00:00.000Z',labelDe:'Automatic',labelEn:'Automatic',freeBacWaterPerPaidVial:true})]);
 let q=await caller().quote(request());assert.equal(q.preview.discount,5.11);assert.equal(q.preview.items.at(-1).isFreeGift,true);assert.equal(q.preview.items.at(-1).quantity,2);
 await pool.query("INSERT INTO promo_codes(code,percentage,max_uses,current_uses) VALUES('TEST10',10,2,0)");
 q=await caller().quote(request({discount:{mode:'code',code:'test10'}}));assert.equal(q.preview.discount,9.71);assert(q.preview.discountBreakdown.some((d:any)=>d.source==='promotion_code'));
 const execute=await caller().execute({quoteToken:q.quoteToken,confirmed:true});assert(execute.orderId);assert.equal((await pool.query("SELECT current_uses FROM promo_codes WHERE code='TEST10'")).rows[0].current_uses,1);
 await pool.query("UPDATE shop_settings SET value=jsonb_set(value::jsonb,'{exclusiveCampaign}','true')::text WHERE key='global_automatic_discount'");
 for(const discount of [{mode:'code',code:'TEST10'},{mode:'percent',value:5},{mode:'amount',value:5}])await assert.rejects(caller().quote(request({discount})),conflict);
});
test('exact contact resolver normalizes all candidates; duplicates/split cannot be overridden; names only suggest',async()=>{
 await pool.query("INSERT INTO customers(name,first_name,last_name,email,phone) VALUES('Test One','Test','One','one@example.test','0151 12345678'),('Test Two','Test','Two','two@example.test','+4915222222222')");
 let found=await caller().customers({phone:'+49(0)15112345678',email:' ONE@EXAMPLE.TEST '});assert.equal(found.match,'exact');assert.equal(found.exactCustomerId,1);
 found=await caller().customers({name:'Test'});assert.equal(found.match,'none');assert.equal(found.candidates.length,2);
 found=await caller().customers({phone:'+4915112345678',email:'two@example.test'});assert.equal(found.match,'conflict');
 await assert.rejects(caller().quote(request({customer:{...request().customer,email:'two@example.test'},existingCustomerId:1,existingCustomerReviewed:true})),conflict);
 await pool.query("INSERT INTO customers(name,phone) VALUES('Duplicate','004915112345678')");assert.equal((await caller().customers({phone:'+4915112345678'})).match,'conflict');await assert.rejects(caller().quote(request()),conflict);
});
test('existing selection preserves profile, uses selected contacts and order-only address; new customer creates canonical record',async()=>{
 await pool.query("INSERT INTO customers(name,first_name,last_name,email,phone,street,house_number,zip,city,country,communication_language) VALUES('Existing Name','Existing','Name','existing@example.test','+41791112233','Old','99','8000','Old','CH','en')");
 await pool.query("INSERT INTO communication_templates(template_key,channel,language,title,body_template) VALUES('order_confirmation','whatsapp','en','Local English','Hello {{firstName}}, order {{orderId}} {{total}} {{paymentDetails}}')");
 const before=(await pool.query('SELECT first_name,last_name,email,phone,street,house_number,zip,city,country,communication_language FROM customers WHERE id=1')).rows[0];
 const r=request({existingCustomerId:1,existingCustomerReviewed:true});const q=await caller().quote(r);assert.equal(q.preview.customer.phone,before.phone);assert.equal(q.preview.customer.street,'Testweg');
 const out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});assert(out.orderId);assert.deepEqual((await pool.query('SELECT first_name,last_name,email,phone,street,house_number,zip,city,country,communication_language FROM customers WHERE id=1')).rows[0],before);
 await service.prepareScreenshotOrderMessage(r.draftId,ctx());
 const result=await caller().result({draftId:r.draftId});assert.equal(result.whatsapp.recipient,'+41791112233');assert.equal(result.whatsapp.state,'ready');assert.match(result.whatsapp.message,/Hello Existing/);assert.match(result.whatsapp.message,new RegExp(out.orderId));assert.equal(result.order.communicationLanguage,'en');assert.equal(await count('customers'),1);
 const n=request();const nq=await caller().quote(n);await caller().execute({quoteToken:nq.quoteToken,confirmed:true});assert.equal(await count('customers'),2);
});
test('tampered/crossactor/expired/replaced tokens cannot book; blocked customers rejected',async()=>{
 const r=request(),q=await caller().quote(r);await assert.rejects(caller().execute({quoteToken:q.quoteToken.slice(0,-5)+'abcde',confirmed:true}),conflict);
 await assert.rejects(caller({...actor,id:2}).execute({quoteToken:q.quoteToken,confirmed:true}),conflict);
 const envelope=contract.verifyScreenshotQuote(q.quoteToken,1);envelope.expiresAt=Date.now()-1;await assert.rejects(caller().execute({quoteToken:contract.signScreenshotQuote(envelope),confirmed:true}),rejected('QUOTE_EXPIRED'));
 await caller().quote({...r,items:[{sku:'TRIPLE-10MG',quantity:1}]});await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),rejected('QUOTE_REPLACED'));assert.equal(await count('orders'),0);
 assert.deepEqual(await caller().status({draftId:r.draftId}),{state:'not_found'});await assert.rejects(caller().result({draftId:r.draftId}),(e:any)=>e.code==='NOT_FOUND');
 await pool.query("INSERT INTO customers(name) VALUES('Blocked'); INSERT INTO customer_order_blocks(customer_id,reason,email_normalized,created_by) VALUES(1,'Synthetic','new@example.test','fixture')");await assert.rejects(caller().quote(request()),conflict);
});
test('price/stock/customer/config drift rejects before any transaction writes, including stock movement',async()=>{
 for(const change of ["UPDATE articles SET selling_price=26 WHERE id=1","UPDATE articles SET stock=19 WHERE id=1","UPDATE articles SET shop_visible=0 WHERE id=1"]){
  const q=await caller().quote(request());await pool.query(change);await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),conflict);assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);assert.equal(await count('priority_checkout_receipts'),0);await pool.query('UPDATE articles SET selling_price=25.55,stock=20,shop_visible=1 WHERE id=1');
 }
 await pool.query("INSERT INTO customers(name,first_name,last_name,email,phone,street) VALUES('Test Person','Test','Person','new@example.test','+4915112345678','Old')");
 const q=await caller().quote(request());await pool.query("UPDATE customers SET street='Concurrent edit',updated_at=NOW() WHERE id=1");await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),conflict);assert.equal(await count('orders'),0);
});
test('concurrent actor+draft executes once, receipt replay/status scoped; result saved exact order Wise and no mail',async()=>{
 const r=request(),q=await caller().quote(r);const [a,b]=await Promise.all([caller().execute({quoteToken:q.quoteToken,confirmed:true}),caller().execute({quoteToken:q.quoteToken,confirmed:true})]);assert.equal(a.orderId,b.orderId);assert.equal(await count('orders'),1);assert.equal(await count('stock_history'),1);assert.equal(await count('priority_checkout_receipts'),1);assert.equal((await counts()).stock,18);
 assert.equal((await caller().status({draftId:r.draftId})).orderId,a.orderId);assert.equal((await caller({...actor,id:2}).status({draftId:r.draftId})).state,'not_found');await assert.rejects(caller({...actor,id:2}).result({draftId:r.draftId}),(e:any)=>e.code==='NOT_FOUND');
 const replay=await caller().execute({quoteToken:q.quoteToken,confirmed:true});assert.equal(replay.orderId,a.orderId);
 await service.prepareScreenshotOrderMessage(r.draftId,ctx());
 const result=await caller().result({draftId:r.draftId});assert.equal(result.order.paymentMethod,'wise');assert.equal(result.whatsapp.state,'ready');assert.equal(result.whatsapp.recipient,'+4915112345678');assert.match(result.whatsapp.message,/Synthetic Holder/);assert.match(result.whatsapp.message,new RegExp(a.orderId));assert.equal(result.order.total,'66.10');assert.equal((await pool.query("SELECT count(*)::int n FROM priority_order_tasks WHERE task='order_confirmation'")).rows[0].n,0);
 await pool.query("DELETE FROM communication_templates");const cached=await caller().result({draftId:r.draftId});assert.equal(cached.orderId,a.orderId);assert.equal(cached.whatsapp.state,'ready');assert.equal(cached.whatsapp.message,result.whatsapp.message);
});

test('locked canonical validation observes drift after preflight and before stock/order writes',async()=>{
 const r=request(),q=await caller().quote(r);const query=pg.Client.prototype.query;let changed=false;
 const patch=mock.method(pg.Client.prototype,'query',async function(this:pg.Client,...args:any[]){const statement=typeof args[0]==='string'?args[0]:args[0]?.text??'';if(!changed&&statement.includes("hashtext('global_automatic_discount')")){changed=true;await pool.query('UPDATE articles SET stock=19 WHERE id=1');}return Reflect.apply(query,this,args);} as any);
 try{await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),rejected('QUOTE_CHANGED'));assert.equal(changed,true);assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);assert.equal(await count('priority_checkout_receipts'),0);assert.deepEqual(await caller().status({draftId:r.draftId}),{state:'not_found'});}finally{patch.mock.restore();}
});
test('canonical stock writes rollback if order-item insertion fails; durable timeout status and actor revocation',async()=>{
 const r=request(),q=await caller().quote(r);
 await pool.query("CREATE FUNCTION local_fail_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LOCAL_SYNTHETIC_FAILURE'; END $$; CREATE TRIGGER local_fail_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION local_fail_item()");
 try{await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),unknown);assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);assert.equal(await count('priority_checkout_receipts'),0);assert.equal((await counts()).stock,20);assert.deepEqual(await caller().status({draftId:r.draftId}),{state:'not_found'});}finally{await pool.query('DROP TRIGGER local_fail_item ON order_items; DROP FUNCTION local_fail_item()');}
 const booked=await caller().execute({quoteToken:q.quoteToken,confirmed:true}); // simulate response lost after commit
 assert.equal((await caller().status({draftId:r.draftId})).orderId,booked.orderId);
 const envelope=contract.verifyScreenshotQuote(q.quoteToken,1);envelope.expiresAt=Date.now()-1;
 assert.equal((await caller().execute({quoteToken:contract.signScreenshotQuote(envelope),confirmed:true})).orderId,booked.orderId,'expired exact receipt can recover committed order');
 const r2=request(),q2=await caller().quote(r2);await pool.query("UPDATE users SET role='user' WHERE id=1");await assert.rejects(caller().execute({quoteToken:q2.quoteToken,confirmed:true}),rejected('ACTOR_REVOKED'));assert.equal(await count('orders'),1);
});
test('different draft same new contact does not race duplicate customer creation; only affected rows locked',async()=>{
 const a=request(),b=request(),qa=await caller().quote(a),qb=await caller().quote(b);
 const results=await Promise.allSettled([caller().execute({quoteToken:qa.quoteToken,confirmed:true}),caller().execute({quoteToken:qb.quoteToken,confirmed:true})]);assert(results.some(r=>r.status==='fulfilled'));assert.equal(await count('customers'),1);assert.equal(await count('orders'),1);assert.equal(await count('stock_history'),1);
 const source=await import('node:fs/promises');const serviceText=await source.readFile(new URL('./screenshotOrderService.ts',import.meta.url),'utf8');assert(!/LOCK TABLE/.test(serviceText));assert.match(serviceText,/ORDER BY id FOR UPDATE NOWAIT/);
});
test('strict Packstation profile suggestions, generic fixed codes, cosmetics and changed message snapshots',async()=>{
 await pool.query("INSERT INTO customers(name,first_name,last_name,email,phone,street,house_number,dhl_post_number,country) VALUES('Test Person','Test','Person','station@example.test','+4915999888777','Packstation','101','12345678','DE')");
 const candidates=await caller().customers({email:'station@example.test'});assert.equal(candidates.candidates[0].deliveryType,'packstation');
 await pool.query("INSERT INTO promo_codes(code,discount_type,fixed_amount) VALUES('FIXED','fixed',3.01)");
 const r=request({discount:{mode:'code',code:'FIXED'}}),q=await caller().quote(r);assert.equal(q.preview.discount,3.01);const out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});assert(out.orderId);
 await pool.query("UPDATE orders SET total='999.99' WHERE order_id=$1",[out.orderId]);const pending=await caller().result({draftId:r.draftId});assert.equal(pending.whatsapp.state,'pending');assert.equal(pending.order.total,'63.09');
 await pool.query("INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,is_active,shop_visible,published_at,category) VALUES('SERUM','Serum','serum',10,5,1,1,NOW(),'369 BeautyLine')");const cosmetic=await caller().quote(request({items:[{sku:'SERUM',quantity:1}]}));assert.equal(cosmetic.preview.items[0].type,'cosmetic');assert(!cosmetic.preview.items.some((i:any)=>i.isFreeGift));
 await assert.rejects(caller().quote(request({items:[{sku:'SERUM',quantity:1,form:'vial'}]})),rejected('PRODUCT_FORM_UNAVAILABLE')); // Still cannot relabel a cosmetic as a vial.
 const query=pg.Client.prototype.query;const patch=mock.method(pg.Client.prototype,'query',function(this:pg.Client,...args:any[]){const text=typeof args[0]==='string'?args[0]:args[0]?.text??'';if(text.includes('SELECT response FROM priority_checkout_receipts'))throw Error('LOCAL_DB_UNAVAILABLE');return Reflect.apply(query,this,args);} as any);try{assert.equal((await caller().status({draftId:r.draftId})).state,'unknown');}finally{patch.mock.restore();}
});
test('safe errors use explicit pre-write reasons; unknown prefixes and generic DB errors never imply rejection',()=>{
 for(const reason of ['QUOTE_INVALID','QUOTE_EXPIRED','QUOTE_REPLACED','QUOTE_EXPIRED_OR_REPLACED','QUOTE_CHANGED','QUOTE_UNAVAILABLE','QUOTE_CAPACITY','CUSTOMER_CONTACT_CONFLICT','CUSTOMER_PROFILE_REQUIRES_REVIEW','CUSTOMER_PHONE_INVALID','CUSTOMER_NOT_FOUND','CUSTOMER_ORDER_BLOCKED','ACTOR_REVOKED','STOCK_UNAVAILABLE','EXACT_PUBLISHED_SKU_REQUIRED','COMPONENT_FORM_REQUIRES_WAWI','PROMOTION_INVALID','PROMOTION_REQUIRES_NATIVE_ELIGIBILITY','EXCLUSIVE_CAMPAIGN_DISCOUNT_FORBIDDEN','SCREENSHOT_SECRET_REQUIRED'])assert.throws(()=>service.screenshotSafeError(Error(reason)),rejected(reason));
 for(const reason of ['ORDER_RESULT_UNKNOWN','LOCAL_SYNTHETIC_FAILURE','QUOTE_RESULT_UNKNOWN','QUOTE_POSTCOMMIT_FAILED','CUSTOMER_MESSAGE_NAME_CHANGED','CUSTOMER_METRICS_FAILED','PROMOTION_POSTCOMMIT_FAILED','DATABASE_UNAVAILABLE'])assert.throws(()=>service.screenshotSafeError(Error(reason)),unknown);
 for(const code of ['55P03','40P01','40001'])for(const error of [Object.assign(Error('LOCAL_DB_DETAILS'),{code}),Object.assign(Error('wrapped'),{cause:{code}}),Object.assign(Error('wrapped'),{cause:{cause:{code}}})])assert.throws(()=>service.screenshotSafeError(error),rejected('TRANSACTION_REJECTED'));
 for(const code of ['P0001','08006','23505','57P01'])assert.throws(()=>service.screenshotSafeError(Object.assign(Error('LOCAL_PRIVATE_DB_DETAILS'),{cause:{cause:{code}}})),unknown);
});
test('only exact local address-warning prefix is exposed, bounded to 1200 characters',()=>{
 const prefix='ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH: ',warning='Die Hausnummer fehlt. Bitte die Lieferadresse prüfen.';
 assert.throws(()=>service.screenshotSafeError(Error(prefix+warning)),(e:any)=>rejected('ADDRESS_WARNING_CONFIRMATION_REQUIRED')(e)&&e.message===`ADDRESS_WARNING_CONFIRMATION_REQUIRED: Adressprüfung: ${warning}`);
 assert.throws(()=>service.screenshotSafeError(Error(prefix+'x'.repeat(1300)+'LOCAL_PRIVATE_TAIL')),(e:any)=>e.message===`ADDRESS_WARNING_CONFIRMATION_REQUIRED: Adressprüfung: ${'x'.repeat(1200)}`);
 for(const text of ['ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH','ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH_EXTRA: LOCAL_PRIVATE_TEXT','unrelated: LOCAL_PRIVATE_TEXT'])assert.throws(()=>service.screenshotSafeError(Error(text)),unknown);
});
test('unknown canonical result or postcommit error keeps original receipt authoritative and never books twice',async()=>{
 const {orderRouter}=await import('./orderRouter.js');
 for(const failure of ['ORDER_RESULT_UNKNOWN','QUOTE_POSTCOMMIT_FAILED','CUSTOMER_METRICS_FAILED']){
  const r=request(),q=await caller().quote(r);const original=orderRouter.createCaller;
  const patch=mock.method(orderRouter,'createCaller',function(this:any,...args:any[]){const canonical=Reflect.apply(original,this,args);return {...canonical,create:async(input:any)=>{await canonical.create(input);if(failure==='ORDER_RESULT_UNKNOWN')return {};throw Error(failure);}};});
  try{await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),unknown);}finally{patch.mock.restore();}
  const status=await caller().status({draftId:r.draftId});assert.equal(status.state,'succeeded');assert(status.orderId);
  // Successful admin requests may be audited even when they only replay a receipt.
  const {audit:beforeAudit,...before}=await counts();
  assert.equal((await caller().execute({quoteToken:q.quoteToken,confirmed:true})).orderId,status.orderId);const {audit:afterAudit,...after}=await counts();assert.deepEqual(after,before);assert(afterAudit>=beforeAudit);
  assert.equal((await caller().result({draftId:r.draftId})).orderId,status.orderId);
 }
 assert.equal(await count('orders'),3);assert.equal(await count('priority_checkout_receipts'),3);assert.equal(await count('stock_history'),3);assert.equal((await counts()).stock,14);
});
test('status without receipt is not_found; unavailable receipt read is unknown, without order or raw error',async()=>{
 const r=request();assert.deepEqual(await caller().status({draftId:r.draftId}),{state:'not_found'});await assert.rejects(caller().result({draftId:r.draftId}),(e:any)=>e.code==='NOT_FOUND');
 const q=await caller().quote(r),query=pg.Client.prototype.query;
 const patch=mock.method(pg.Client.prototype,'query',function(this:pg.Client,...args:any[]){const text=typeof args[0]==='string'?args[0]:args[0]?.text??'';if(text.includes('SELECT response FROM priority_checkout_receipts'))throw Object.assign(Error('LOCAL_PRIVATE_CONNECTION_FAILURE'),{code:'08006'});return Reflect.apply(query,this,args);} as any);
 try{assert.deepEqual(await caller().status({draftId:r.draftId}),{state:'unknown'});await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),unknown);await assert.rejects(caller().result({draftId:r.draftId}),unknown);}finally{patch.mock.restore();}
 assert.deepEqual(await caller().status({draftId:r.draftId}),{state:'not_found'});assert.equal(await count('orders'),0);assert.equal(await count('priority_checkout_receipts'),0);assert.equal(await count('stock_history'),0);
});
test('prepareMessage persists first body once; result is read-only and ignores changed or deleted templates',async()=>{
 const r=request(),q=await caller().quote(r),out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});
 const readReceipt=async()=>(await pool.query('SELECT response FROM priority_checkout_receipts WHERE order_id=$1',[out.orderId])).rows[0].response;
 const unprepared=await readReceipt();const query=pg.Client.prototype.query;let reads=0;
 const guard=mock.method(pg.Client.prototype,'query',function(this:pg.Client,...args:any[]){const text=typeof args[0]==='string'?args[0]:args[0]?.text??'';if(/^\s*(UPDATE|INSERT|DELETE|ALTER|CREATE|TRUNCATE)\b/i.test(text))throw Error('RESULT_WRITE_FORBIDDEN');reads++;return Reflect.apply(query,this,args);} as any);
 try{const pending=await caller().result({draftId:r.draftId});assert.equal(pending.whatsapp.state,'pending');assert.equal(pending.whatsapp.message,null);assert(reads>0);}finally{guard.mock.restore();}
 assert.deepEqual(await readReceipt(),unprepared);
 await assert.rejects(caller({...actor,id:2}).prepareMessage({draftId:r.draftId}),(e:any)=>e.code==='NOT_FOUND');
 await assert.rejects(caller({...actor,role:'user'}).prepareMessage({draftId:r.draftId}),(e:any)=>e.code==='FORBIDDEN');
 await assert.rejects(service.prepareScreenshotOrderMessage(r.draftId,ctx(null)),(e:any)=>e.code==='UNAUTHORIZED');
 const prepared=await caller().prepareMessage({draftId:r.draftId});assert.equal(prepared.whatsapp.state,'ready');assert.match(prepared.whatsapp.message,/Synthetic Holder/);
 const stored=await readReceipt();assert.deepEqual(stored.screenshotConfirmation,{version:1,body:prepared.whatsapp.message,preparedAt:stored.screenshotConfirmation.preparedAt});assert(Number.isFinite(Date.parse(stored.screenshotConfirmation.preparedAt)));
 const {screenshotConfirmation,...originalFields}=stored;assert.deepEqual(originalFields,unprepared);
 await pool.query("UPDATE communication_templates SET body_template='CHANGED {{orderId}} {{paymentDetails}}'");
 const again=await caller().prepareMessage({draftId:r.draftId});assert.equal(again.whatsapp.message,prepared.whatsapp.message);assert.deepEqual(await readReceipt(),stored);
 await pool.query('DELETE FROM communication_templates');
 const guard2=mock.method(pg.Client.prototype,'query',function(this:pg.Client,...args:any[]){const text=typeof args[0]==='string'?args[0]:args[0]?.text??'';if(/^\s*(UPDATE|INSERT|DELETE|ALTER|CREATE|TRUNCATE)\b/i.test(text))throw Error('RESULT_WRITE_FORBIDDEN');return Reflect.apply(query,this,args);} as any);
 try{const result=await caller().result({draftId:r.draftId});assert.equal(result.whatsapp.state,'ready');assert.equal(result.whatsapp.message,prepared.whatsapp.message);}finally{guard2.mock.restore();}
 assert.deepEqual(await readReceipt(),stored);
 const {orderRouter}=await import('./orderRouter.js');await orderRouter.createCaller(ctx() as any).setCommunicationPhoneOverride({orderId:out.orderId,phone:'+4915777777777',reason:'Synthetic recipient correction',requestId:randomUUID(),expectedLatestEventId:null});
 const override=await caller().result({draftId:r.draftId});assert.equal(override.whatsapp.state,'ready');assert.equal(override.whatsapp.recipient,'+4915777777777');assert.equal(override.whatsapp.message,prepared.whatsapp.message);assert.deepEqual(await readReceipt(),stored);
 await pool.query("UPDATE orders SET total='999.99' WHERE order_id=$1",[out.orderId]);assert.equal((await caller().result({draftId:r.draftId})).whatsapp.state,'pending');assert.equal((await caller().prepareMessage({draftId:r.draftId})).whatsapp.state,'pending');
 await pool.query("UPDATE orders SET total='66.10' WHERE order_id=$1;",[out.orderId]);
 await pool.query("UPDATE shop_settings SET value=jsonb_set(value::jsonb,'{accounts,0,accountHolder}','\"Changed Holder\"')::text WHERE key='bank_transfer_payment_instructions'");assert.equal((await caller().result({draftId:r.draftId})).whatsapp.state,'pending');assert.equal((await caller().prepareMessage({draftId:r.draftId})).whatsapp.state,'pending');assert.deepEqual(await readReceipt(),stored);
});
test('concurrent message preparations return one durable CAS winner; invalid customer keeps cached message pending',async()=>{
 const r=request(),q=await caller().quote(r),out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});const {communicationTemplateRouter}=await import('./communicationTemplateRouter.js');const original=communicationTemplateRouter.createCaller;let rendered=0;
 const patch=mock.method(communicationTemplateRouter,'createCaller',function(this:any,...args:any[]){const native=Reflect.apply(original,this,args);return {list:native.list,render:async(input:any)=>{const value=await native.render(input);return {...value,whatsappBody:value.whatsappBody+`\nSynthetic render ${++rendered}`};}};});
 let a:any,b:any;try{[a,b]=await Promise.all([service.prepareScreenshotOrderMessage(r.draftId,ctx()),service.prepareScreenshotOrderMessage(r.draftId,ctx())]);}finally{patch.mock.restore();}
 assert.equal(a.whatsapp.state,'ready');assert.equal(b.whatsapp.state,'ready');assert.equal(a.whatsapp.message,b.whatsapp.message);const stored=(await pool.query('SELECT response FROM priority_checkout_receipts WHERE order_id=$1',[out.orderId])).rows[0].response;assert.equal(stored.screenshotConfirmation.body,a.whatsapp.message);assert.equal(await count('orders'),1);assert.equal(await count('stock_history'),1);
 await pool.query("UPDATE customers SET first_name='Changed' WHERE id=$1",[stored.orderSnapshot.customerId]);const pending=await caller().result({draftId:r.draftId});assert.equal(pending.whatsapp.state,'pending');assert.equal(pending.whatsapp.message,null);assert.equal((await caller().prepareMessage({draftId:r.draftId})).whatsapp.state,'pending');assert.deepEqual((await pool.query('SELECT response FROM priority_checkout_receipts WHERE order_id=$1',[out.orderId])).rows[0].response,stored);
});

test('legacy maxPerCustomer metadata cannot bypass native eligibility in screenshot quote or execute',async()=>{
 const r=request({discount:{mode:'code',code:'LIMIT10'}});
 await pool.query("INSERT INTO promo_codes(code,percentage,max_uses,current_uses,description) VALUES('LIMIT10',10,100,0,'Public promotion | {\"maxPerCustomer\":1}')");
 const before=await counts();
 await assert.rejects(caller().quote(r),(error:any)=>error.code==='PRECONDITION_FAILED'&&error.message.startsWith('PROMOTION_REQUIRES_NATIVE_ELIGIBILITY:'));
 assert.deepEqual(await counts(),before);
 await pool.query("UPDATE promo_codes SET description='Public promotion' WHERE code='LIMIT10'");
 const q=await caller().quote(r);
 await pool.query("UPDATE promo_codes SET description='Public promotion | {\"maxPerCustomer\":1}' WHERE code='LIMIT10'");
 await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),(error:any)=>error.code==='PRECONDITION_FAILED'&&error.message.startsWith('PROMOTION_REQUIRES_NATIVE_ELIGIBILITY:'));
 // PostgreSQL sequences are not transactional; a rejected execution may leave
 // a number gap, but must never create an order or move stock.
 const after=await counts();assert.deepEqual({...after,sequence:before.sequence},before);
 assert.deepEqual(await caller().status({draftId:r.draftId}),{state:'not_found'});
});

async function fullCatalogFixture(){
 await pool.query(`INSERT INTO articles(sku,name,shop_product_id,selling_price,stock,is_active,shop_visible,published_at,category,variants) VALUES
 ('READY-10','3G Plug&Play Patrone (10 mg)','ready-cartridge',60,6,1,1,'2026-01-01','Fertigpens','[]'),
 ('SERUM','Serum (30 ml)','serum',65,5,1,1,'2026-01-01','369 BeautyLine','[]'),
 ('NEEDLES','Pen Nadeln (10 Stück)','pen-nadeln-10er',12,10,1,1,'2026-01-01','Zubehör','[]'),
 ('BAC-10ML','BAC Wasser (10 ml)','bac-wasser',9,8,1,1,'2026-01-01','Zubehör','[]'),
 ('SEMAX-10MG','Semax (10 mg)','semax',22,7,1,1,'2026-01-01','Vials','[]'),
 ('KIT-EXACT','Zubehör Set komplett','exact-kit',40,4,1,1,'2026-01-01','Zubehör','[]'),
 ('DIY-FIXED','DIY Nasenspray Set komplett','fixed-diy',35,4,1,1,'2026-01-01','Nasensprays','[]')`);
}
const stocks=async()=>Object.fromEntries((await pool.query('SELECT sku,stock FROM articles ORDER BY id')).rows.map(a=>[a.sku,a.stock]));
const stockMoves=async()=>Object.fromEntries((await pool.query("SELECT a.sku,sum(h.quantity_change)::int demand,count(*)::int movements FROM stock_history h JOIN articles a ON a.id=h.article_id WHERE h.change_type='verkauf' GROUP BY a.sku")).rows.map(a=>[a.sku,{change:a.demand,movements:a.movements}]));
test('P&P option is +15 once; ready actual cartridge no double addon, mandatory cold and exact identity',async()=>{
 await fullCatalogFixture();
 const c=(await caller().catalog({query:'TRIPLE-10MG'})).candidates;assert.equal(c.length,2);
 const option=c.find((i:any)=>i.form==='plug_play');assert.equal(option.price,40.55);assert.equal(option.defaultForm,'vial');assert.equal(option.preparation,'plug_play_option');assert.equal(option.candidateKey,JSON.stringify(['TRIPLE-10MG','plug_play']));assert.equal(option.mandatoryCold,true);assert.deepEqual(option.stockDemands,[{sku:'TRIPLE-10MG',quantity:1,stock:20}]);
 const ready=(await caller().catalog({query:'READY-10'})).candidates;assert.equal(ready.length,1);assert.equal(ready[0].form,'plug_play');assert.equal(ready[0].price,60);assert.equal(ready[0].preparation,'inventory');
 const before=await counts(),r=request({items:[{sku:'TRIPLE-10MG',quantity:1,form:'plug_play'},{sku:'READY-10',quantity:1}],coldShippingRequested:false});
 const q=await caller().quote(r);assert.equal(q.preview.subtotal,100.55);assert.equal(q.preview.shipping,22);assert.equal(q.preview.coldShippingMandatory,true);assert.equal(q.preview.coldShippingActive,true);assert.deepEqual(q.preview.items.map((i:any)=>[i.sku,i.form,i.preparation,i.isPlugPlay]),[['TRIPLE-10MG','plug_play','plug_play_option',true],['READY-10','plug_play','inventory',true]]);assert(!q.preview.items.some((i:any)=>i.isFreeGift));assert.deepEqual(await counts(),before);
 const out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});assert.equal((await stocks())['TRIPLE-10MG'],19);assert.equal((await stocks())['READY-10'],5);
 const stored=(await pool.query('SELECT subtotal,shipping,total FROM orders WHERE order_id=$1',[out.orderId])).rows[0];assert.deepEqual(stored,{subtotal:'100.55',shipping:'22.00',total:'122.55'});
 await assert.rejects(caller().quote(request({items:[{sku:'READY-10',quantity:1,form:'vial'}]})),rejected('PRODUCT_FORM_UNAVAILABLE'));
});
test('all forms have actual stock and one summed deduction, transparent components, no cosmetic/P&P BAC, receipt replay/restock',async()=>{
 await fullCatalogFixture();
 const r=request({items:[{sku:'TRIPLE-10MG',quantity:1,form:'vial'},{sku:'TRIPLE-10MG',quantity:2,form:'plug_play'},{sku:'NASAL-10MG',quantity:1},{sku:'SEMAX-10MG',quantity:2,form:'nasal'},{sku:'SERUM',quantity:1},{sku:'NEEDLES',quantity:2},{sku:'BAC-10ML',quantity:1},{sku:'KIT-EXACT',quantity:1},{sku:'DIY-FIXED',quantity:1}]});
 const before=await stocks(),q=await caller().quote(r);assert.equal(q.preview.items.length,9);assert(!q.preview.items.some((i:any)=>i.isFreeGift));assert.equal(q.preview.items.find((i:any)=>i.sku==='SEMAX-10MG').price,29);assert.equal(q.preview.items.find((i:any)=>i.sku==='SEMAX-10MG').isNasalDiySet,true);assert.equal(q.preview.items.find((i:any)=>i.sku==='SERUM').type,'cosmetic');
 const out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});
 assert.deepEqual(await stockMoves(),{'TRIPLE-10MG':{change:-3,movements:1},'NASAL-10MG':{change:-1,movements:1},'SEMAX-10MG':{change:-2,movements:1},'SERUM':{change:-1,movements:1},'NEEDLES':{change:-2,movements:1},'BAC-10ML':{change:-4,movements:1},'KIT-EXACT':{change:-1,movements:1},'DIY-FIXED':{change:-1,movements:1}});
 const lines=(await pool.query('SELECT name,article_id,type,is_plug_play,is_nasal_diy_set FROM order_items WHERE order_id=$1',[out.orderId])).rows;assert.equal(lines.length,13);assert.equal(lines.filter(i=>i.name.includes('BAC Wasser')).length,3);assert(lines.filter(i=>i.name.includes('komplett')).every(i=>i.article_id));
 assert(q.preview.includedComponents.length>0);assert.deepEqual(q.preview.includedComponents.map((i:any)=>i.name).sort(),lines.filter(i=>!q.preview.items.some((main:any)=>main.name===i.name)).map(i=>i.name).sort());assert(q.preview.includedComponents.every((i:any)=>i.price===0&&i.quantity>0));
 const after=await stocks();assert.equal((await caller().execute({quoteToken:q.quoteToken,confirmed:true})).orderId,out.orderId);assert.deepEqual(await stocks(),after);assert.equal(await count('stock_history'),8);
 const {getDb}=await import('./db.js');const db=await getDb();const {returnOrderStock}=await import('./orderStockReturnService.js');
 await db!.transaction(async(tx:any)=>{const o=(await tx.execute((await import('drizzle-orm')).sql`SELECT * FROM orders WHERE order_id=${out.orderId} FOR UPDATE`)).rows[0];await returnOrderStock(tx,{...o,orderId:o.order_id,shippedAt:o.shipped_at,deliveredAt:o.delivered_at},'Synthetic regression','fixture');});assert.deepEqual(await stocks(),before);assert.equal(await count('stock_history'),16);
});
test('catalog availability omits stockouts and invalid component references; mixed same-SKU and shared-component demand rejects before writes',async()=>{
 await fullCatalogFixture();await pool.query("UPDATE articles SET stock=0 WHERE sku='NEEDLES'");assert.equal((await caller().catalog({query:'NEEDLES'})).candidates.length,0);
 await assert.rejects(caller().quote(request({items:[{sku:'NEEDLES',quantity:1}]})),rejected('STOCK_UNAVAILABLE'));
 await assert.rejects(caller().quote(request({items:[{sku:'TRIPLE-10MG',quantity:12,form:'vial'},{sku:'TRIPLE-10MG',quantity:9,form:'plug_play'}]})),rejected('STOCK_UNAVAILABLE'));
 await assert.rejects(caller().quote(request({items:[{sku:'NASAL-10MG',quantity:4},{sku:'SEMAX-10MG',quantity:5,form:'nasal'}]})),rejected('STOCK_UNAVAILABLE'));
 await assert.rejects(caller().quote(request({items:[{sku:'TRIPLE-10MG',quantity:1},{sku:'TRIPLE-10MG',quantity:1,form:'vial'}]})),rejected('DUPLICATE_SELECTION'));
 await pool.query("UPDATE articles SET stock=0 WHERE sku='BAC-10ML'");assert.equal((await caller().catalog({query:'Semax',form:'nasal'})).candidates.length,0);assert.equal((await caller().catalog({query:'NASAL-10MG'})).candidates.length,0);assert.equal((await caller().catalog({query:'Semax',form:'vial'})).candidates.length,1);
 await pool.query("INSERT INTO articles(sku,name,shop_product_id,stock,is_active) VALUES('BAC-DUP','Ambiguous BAC','bac-wasser',99,0)");assert.equal((await caller().catalog({query:'Semax',form:'nasal'})).candidates.length,0);assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);assert.equal(await count('priority_checkout_receipts'),0);
});
test('tracked component price/identity/eligibility/config drift and row lock reject full plan pre-write; unrelated row not locked',async()=>{
 await fullCatalogFixture();const r=request({items:[{sku:'SEMAX-10MG',quantity:1,form:'nasal'}]});
 for(const change of ["UPDATE articles SET selling_price=10 WHERE sku='BAC-10ML'","UPDATE articles SET stock=7 WHERE sku='BAC-10ML'","UPDATE articles SET is_active=0 WHERE sku='BAC-10ML'","UPDATE articles SET shop_product_id='bac-changed' WHERE sku='BAC-10ML'"]){
  const q=await caller().quote(r);await pool.query(change);await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),conflict);assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);assert.equal(await count('priority_checkout_receipts'),0);await pool.query("UPDATE articles SET selling_price=9,stock=8,is_active=1,shop_product_id='bac-wasser' WHERE sku='BAC-10ML'");
 }
 const q=await caller().quote(r),lock=await pool.connect();try{await lock.query('BEGIN');await lock.query("SELECT id FROM articles WHERE sku='BAC-10ML' FOR UPDATE");await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),rejected('TRANSACTION_REJECTED'));assert.equal(await count('orders'),0);}finally{await lock.query('ROLLBACK');lock.release();}
 const unrelated=await pool.connect();try{await unrelated.query('BEGIN');await unrelated.query("SELECT id FROM articles WHERE sku='NEEDLES' FOR UPDATE");const out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});assert(out.orderId);}finally{await unrelated.query('ROLLBACK');unrelated.release();}
});
test('component insertion failure rolls back every physical row/movement and receipt; stockout after quote cannot partially execute',async()=>{
 await fullCatalogFixture();const before=await stocks(),r=request({items:[{sku:'SEMAX-10MG',quantity:2,form:'nasal'},{sku:'SERUM',quantity:1}]}),q=await caller().quote(r);
 await pool.query("CREATE FUNCTION local_fail_component() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name LIKE 'DIY Nasenspray-Set%' THEN RAISE EXCEPTION 'LOCAL_COMPONENT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER local_fail_component BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION local_fail_component()");
 try{await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),unknown);assert.deepEqual(await stocks(),before);assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);assert.equal(await count('priority_checkout_receipts'),0);}finally{await pool.query('DROP TRIGGER local_fail_component ON order_items; DROP FUNCTION local_fail_component()');}
 await pool.query("UPDATE articles SET stock=1 WHERE sku='BAC-10ML'");await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),conflict);assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);
});
test('EU rates and explicit free base retain cold surcharge; canonical promo/campaign thresholds and expired campaign agree preview/execute',async()=>{
 await fullCatalogFixture();
 for(const [country,shipping] of [['DE',8],['AT',15],['FR',15],['NL',15],['CH',18]] as const){const q=await caller().quote(request({customer:{...request().customer,country},items:[{sku:'NEEDLES',quantity:1}]}));assert.equal(q.preview.shipping,shipping);assert.equal(q.preview.shippingBase,shipping);assert.equal(q.preview.coldShippingSurcharge,0);}
 for(const cold of [false,true]){const q=await caller().quote(request({items:[{sku:'SERUM',quantity:1}],freeBaseShippingRequested:true,coldShippingRequested:cold}));assert.equal(q.preview.shipping,cold?7:0);assert.equal(q.preview.freeBaseShippingApplied,true);assert.equal(q.preview.shippingBase,0);const out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});assert.equal(Number((await pool.query('SELECT shipping FROM orders WHERE order_id=$1',[out.orderId])).rows[0].shipping),q.preview.shipping);}
 await pool.query("INSERT INTO promo_codes(code,percentage,description) VALUES('FREESHIP',0,'Shipping promotion | {\"freeShipping\":[\"eu\"]}'),('NORMAL10',10,'Standard promotion')");
 for(const code of ['FREESHIP','NORMAL10']){const q=await caller().quote(request({items:[{sku:'TRIPLE-10MG',quantity:1,form:'plug_play'}],freeBaseShippingRequested:true,discount:{mode:'code',code}}));assert.equal(q.preview.shipping,7);const out=await caller().execute({quoteToken:q.quoteToken,confirmed:true});const saved=(await pool.query('SELECT shipping,total FROM orders WHERE order_id=$1',[out.orderId])).rows[0];assert.equal(Number(saved.shipping),q.preview.shipping);assert.equal(Number(saved.total),q.preview.total);}
 const config={enabled:true,percentage:10,expiresAt:'2099-01-01T00:00:00.000Z',labelDe:'Automatic',labelEn:'Automatic',freeShippingEnabled:true,freeShippingMinOrder:50,freeShippingRegions:['eu'],coldShippingSurcharge:9};
 await pool.query("INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1)",[JSON.stringify(config)]);
 const low=await caller().quote(request({items:[{sku:'TRIPLE-10MG',quantity:1,form:'plug_play'}]}));assert.equal(low.preview.shipping,24);assert.equal(low.preview.freeBaseShippingApplied,false);
 const threshold=await caller().quote(request({items:[{sku:'TRIPLE-10MG',quantity:2,form:'plug_play'}]}));assert.equal(threshold.preview.shipping,9);assert.equal(threshold.preview.freeBaseShippingApplied,true);assert.equal(threshold.preview.coldShippingSurcharge,9);const out=await caller().execute({quoteToken:threshold.quoteToken,confirmed:true});assert.equal(Number((await pool.query('SELECT total FROM orders WHERE order_id=$1',[out.orderId])).rows[0].total),threshold.preview.total);
 await pool.query("UPDATE shop_settings SET value=$1 WHERE key='global_automatic_discount'",[JSON.stringify({...config,expiresAt:'2020-01-01T00:00:00.000Z',exclusiveCampaign:true})]);
 const expired=await caller().quote(request({items:[{sku:'TRIPLE-10MG',quantity:1,form:'plug_play'}],discount:{mode:'percent',value:5}}));assert.equal(expired.preview.shipping,22);assert.equal(expired.preview.discount,2.03);assert.equal(expired.preview.freeBaseShippingApplied,false);assert(await caller().execute({quoteToken:expired.quoteToken,confirmed:true}));
});
test('island cooling rejection is prewrite for mandatory and optional cold, free base never bypasses exclusion',async()=>{
 await fullCatalogFixture();const before=await counts();
 for(const items of [[{sku:'READY-10',quantity:1}],[{sku:'TRIPLE-10MG',quantity:1,form:'plug_play'}],[{sku:'SERUM',quantity:1}]]){await assert.rejects(caller().quote(request({customer:{...request().customer,country:'IE',zip:'D01',city:'Dublin'},items,freeBaseShippingRequested:true,coldShippingRequested:true})),rejected('KUEHLVERSAND_INSEL_AUSGESCHLOSSEN'));}
 assert.deepEqual(await counts(),before);const ordinary=await caller().quote(request({customer:{...request().customer,country:'IE',zip:'D01',city:'Dublin'},items:[{sku:'SERUM',quantity:1}],coldShippingRequested:false}));assert.equal(ordinary.preview.shipping,15);
});
test('SOMATIDE approved exact single-vial composition remains vial-only; publishing drafts and false physical form mappings are never unlocked',async()=>{
 const composition={version:1,kind:'blend',basis:'single-vial',totalMassMg:15,components:[{id:'tesamorelin',name:'Tesamorelin',massMg:10},{id:'ipamorelin',name:'Ipamorelin',massMg:5}]};
 const rows=[{id:50,sku:'SOMATIDE-15MG',name:'SOMATIDE (15 mg)',shopProductId:'somatide',category:'Vials',stock:10,isActive:1,shopVisible:1,publishedAt:new Date(),sellingPrice:'50',salePrice:null,variants:[{label:'15 mg',dosage:'15 mg',sku:'SOMATIDE-15MG',inventoryArticleId:50,price:50}],description:{composition}}];assert.deepEqual(service.screenshotCatalogProjection(rows).map((c:any)=>c.form),['vial']);
 assert.equal(service.screenshotCatalogProjection([{...rows[0],description:{}}]).length,0);
 assert.equal(service.screenshotCatalogProjection([{...rows[0],description:{composition,draftMeta:{isDraft:true,priceStatus:'open'}}}]).length,0);
 const bad={...rows[0],sku:'BAD',shopProductId:'bad',variants:[{label:'15 mg',sku:'OTHER',inventoryArticleId:50,price:50}],description:{}};assert.equal(service.screenshotCatalogProjection([bad]).length,0);
});

test('explicit form schema preserves backwards compatibility and rejects browser price/type/components; same SKU distinct form allowed',()=>{
 const r=request();assert(contract.screenshotQuoteInputSchema.safeParse(r).success);
 assert(contract.screenshotQuoteInputSchema.safeParse({...r,freeBaseShippingRequested:true,items:[{sku:'TRIPLE-10MG',quantity:1,form:'vial'},{sku:'TRIPLE-10MG',quantity:1,form:'plug_play'}]}).success);
 for(const item of [{sku:'TRIPLE-10MG',quantity:1,form:'accessory'},{sku:'TRIPLE-10MG',quantity:1,price:0},{sku:'TRIPLE-10MG',quantity:1,type:'peptide'},{sku:'TRIPLE-10MG',quantity:1,stockDemands:[]}])assert(!contract.screenshotQuoteInputSchema.safeParse({...r,items:[item]}).success);
 assert(!contract.screenshotQuoteInputSchema.safeParse({...r,items:[{sku:'TRIPLE-10MG',quantity:1,form:'plug_play'},{sku:'triple-10mg',quantity:1,form:'plug_play'}]}).success);
});
test('canonical nasal documentation config and option eligibility drift reject before stock/customer/order writes',async()=>{
 await fullCatalogFixture();await pool.query("INSERT INTO shop_settings(key,value) VALUES('nasal_diy_set_config_v1','{\"version\":1}')");
 const r=request({items:[{sku:'SEMAX-10MG',quantity:1,form:'nasal'}]}),q=await caller().quote(r);
 await pool.query("UPDATE shop_settings SET value='{\"version\":2}' WHERE key='nasal_diy_set_config_v1'");await assert.rejects(caller().execute({quoteToken:q.quoteToken,confirmed:true}),rejected('QUOTE_CHANGED'));assert.equal(await count('orders'),0);assert.equal(await count('customers'),0);assert.equal(await count('stock_history'),0);
 const q2=await caller().quote(r);await pool.query("UPDATE articles SET category='Zubehör' WHERE sku='SEMAX-10MG'");await assert.rejects(caller().execute({quoteToken:q2.quoteToken,confirmed:true}),conflict);assert.equal(await count('orders'),0);assert.equal(await count('stock_history'),0);
});
test('mixed option stock race across distinct customers never oversells and generated vial BAC keeps legacy no movement policy',async()=>{
 await fullCatalogFixture();await pool.query("UPDATE articles SET stock=3,selling_price=55,variants='[{\"label\":\"10 mg\",\"sku\":\"TRIPLE-10MG\",\"inventoryArticleId\":1,\"price\":55}]' WHERE sku='TRIPLE-10MG'");
 const items=[{sku:'TRIPLE-10MG',quantity:1,form:'vial'},{sku:'TRIPLE-10MG',quantity:1,form:'plug_play'}];
 const a=request({items}),b=request({items,customer:{...request().customer,email:'second@example.test',phone:'+4915222222222'}});const qa=await caller().quote(a),qb=await caller().quote(b);assert.equal(qa.preview.items.filter((i:any)=>i.isFreeGift).length,1);assert.equal(qa.preview.items.at(-1).quantity,1);
 const out=await Promise.allSettled([caller().execute({quoteToken:qa.quoteToken,confirmed:true}),caller().execute({quoteToken:qb.quoteToken,confirmed:true})]);assert.equal(out.filter(i=>i.status==='fulfilled').length,1);assert.equal(await count('orders'),1);assert.equal(await count('stock_history'),1);assert.equal((await stocks())['TRIPLE-10MG'],1);assert.equal((await stocks())['BAC-10ML'],8);assert.equal(await count('priority_checkout_receipts'),1);
});
test('unknown inventory is other, accessories cannot trigger false nasal/Plug&Play text cold or BAC, option exclusion preserves canonical publication',async()=>{
 const base={id:100,sku:'MISC',name:'Misc Kit',shopProductId:'misc',sellingPrice:'60',salePrice:null,stock:10,isActive:1,shopVisible:1,publishedAt:new Date(),variants:[],category:null};
 assert.deepEqual(service.screenshotCatalogProjection([base]).map((c:any)=>[c.form,c.type]),[['other','other']]);
 const accessory={...base,sku:'EMPTY',name:'Leere Plug&Play Patrone Nasensprayflasche',shopProductId:'empty',category:'Zubehör'};const c=service.screenshotCatalogProjection([accessory]);assert.equal(c.length,1);assert.equal(c[0].form,'other');assert.equal(c[0].mandatoryCold,false);assert.equal(c[0].isPlugPlay,false);assert.equal(c[0].isNasalSpray,false);
 const conflicting={...base,sku:'BEAUTY',name:'Retinal cosmetic',category:'Vials',categories:['369 BeautyLine']};assert.deepEqual(service.screenshotCatalogProjection([conflicting]).map((c:any)=>[c.form,c.type]),[['other','cosmetic']]);
});
