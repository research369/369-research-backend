import {Router} from 'express';
import {readFile} from 'node:fs/promises';
import rateLimit from 'express-rate-limit';
import {z} from 'zod';
import {getPool} from './db.js';
import {validJarvyReadKey} from './jarvyReadRouter.js';
import {jarvyOrderRequest,orderHash} from './jarvyOrderContract.js';
import {orderRouter} from './orderRouter.js';
import {calculateAuthoritativeShipping,resolveShippingRegion,roundMoney} from './kwkCheckoutPricing.js';
import type {Context} from './trpc.js';

let receiptsReady:Promise<unknown>|undefined;
async function ensureReceipts(pool:NonNullable<Awaited<ReturnType<typeof getPool>>>) {
 receiptsReady??=readFile(new URL('../drizzle/migrations/0024_jarvy_order_receipts.sql',import.meta.url),'utf8').then(sql=>pool.query(sql)).catch(e=>{receiptsReady=undefined;throw e;});await receiptsReady;
}
export const jarvyOrderRouter=Router();
jarvyOrderRouter.use((req,res,next)=>{
 res.set('Cache-Control','no-store');
 if(!validJarvyReadKey(process.env.JARVY_WRITE_KEY,req.get('authorization'))||process.env.JARVY_WRITE_KEY===process.env.JARVY_READ_KEY){res.status(401).json({error:'unauthorized'});return;}
 if(req.method!=='POST'||!['/preview','/execute','/status'].includes(req.path)){res.status(405).json({error:'unsupported'});return;}
 next();
});
jarvyOrderRouter.use(rateLimit({windowMs:60000,limit:20,keyGenerator:()=> 'jarvy-orders',standardHeaders:true,legacyHeaders:false}));
const executeSchema=z.object({id:z.string().uuid(),request:jarvyOrderRequest,expected_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
jarvyOrderRouter.post('/:operation',async(req,res)=>{
 const pool=await getPool();if(!pool){res.status(503).json({error:'unavailable'});return;}
 let receiptId:string|undefined;
 try{
  const actorIdSetting=Number(process.env.JARVY_WAWI_ACTOR_ID);
  const actor=Number.isSafeInteger(actorIdSetting)&&actorIdSetting>0?(await pool.query('SELECT id,username,name,email,role FROM users WHERE id=$1 AND role=$2',[actorIdSetting,'admin'])).rows[0]:(await pool.query('SELECT id,username,name,email,role FROM users WHERE username=$1 AND role=$2',[process.env.ADMIN_USERNAME||'', 'admin'])).rows[0];
  if(!actor)throw Error('actor_unavailable');const actorId=actor.id;
  await ensureReceipts(pool);
  if(req.params.operation==='status'){
   const id=z.object({id:z.string().uuid()}).strict().parse(req.body).id;
   const receipt=(await pool.query('SELECT id,state,order_id FROM jarvy_order_receipts WHERE id=$1 AND actor_id=$2',[id,actorId])).rows[0];
   res.json(receipt??{state:'not_found'});return;
  }
  const execution=req.params.operation==='execute'?executeSchema.parse(req.body):undefined;
  const request=execution?.request??jarvyOrderRequest.parse(req.body);
  const requestHash=orderHash(request);
  if(execution){
   const old=(await pool.query('SELECT state,order_id,request_hash,payload_hash,actor_id FROM jarvy_order_receipts WHERE id=$1',[execution.id])).rows[0];
   if(old){if(old.request_hash!==requestHash||old.payload_hash!==execution.expected_hash||old.actor_id!==actorId)throw Error('receipt_mismatch');res.json({state:old.state,order_id:old.order_id});return;}
  }
  const customer=(await pool.query('SELECT first_name,last_name,email,phone,street,house_number,zip,city,country,company,dhl_post_number FROM customers WHERE id=$1',[request.customerId])).rows[0];
  if(!customer)throw Error('customer_not_found');
  // Existing exact customer only. No guessed merge, profile update or address override.
  const c={firstName:customer.first_name,lastName:customer.last_name,email:customer.email||'',phone:customer.phone||'',street:customer.street,houseNumber:customer.house_number,zip:customer.zip,city:customer.city,country:customer.country,company:customer.company||'',deliveryType:'home' as const};
  if([c.firstName,c.lastName,c.street,c.houseNumber,c.zip,c.city,c.country].some(x=>!x)||customer.dhl_post_number)throw Error('customer_address_requires_wawi');
  if(request.sendOrderConfirmation&&!c.email)throw Error('customer_email_missing');
  const items=[];
  for(const line of request.items){
   const a=(await pool.query('SELECT sku,name,shop_product_id,selling_price,sale_price,stock,variants FROM articles WHERE sku=$1 AND is_active=1',[line.sku])).rows[0];if(!a)throw Error('article_not_found');
   if(a.stock<line.quantity)throw Error('stock_unavailable');
   // These products trigger implicit components or special fulfilment in the native pipeline.
   // Until those components are part of Jarvy's approval, keep their native WaWi flow.
   if(/nasenspray|nasal|plug[\s&-]*play|patrone/i.test([a.name,a.sku,JSON.stringify(a.variants??[])].join(' ')))throw Error('article_requires_wawi');
   // SKU selects one inventory article. Multi-variant parents require the exact inventory SKU.
   if(Array.isArray(a.variants)&&a.variants.length>1)throw Error('exact_inventory_sku_required');
   const price=Number(a.sale_price)>0?Number(a.sale_price):Number(a.selling_price);if(!Number.isFinite(price)||price<=0)throw Error('article_price_unavailable');
   items.push({name:a.name,shopProductId:a.sku,price,quantity:line.quantity,type:'peptide'});
  }
  const subtotal=roundMoney(items.reduce((s,i)=>s+i.price*i.quantity,0));const shipping=calculateAuthoritativeShipping({country:c.country,items});
  const input={orderSource:'wawi_manual' as const,storeKey:'369research' as const,communicationLanguage:'de' as const,sendOrderConfirmation:request.sendOrderConfirmation,customer:c,items,subtotal,shipping,shippingCountry:resolveShippingRegion(c.country),discount:0,discountCode:null,total:roundMoney(subtotal+shipping),paymentMethod:request.paymentMethod,date:new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Berlin'}),existingCustomerId:request.customerId,internalNote:request.internalNote};
  const ctx:Context={req,res,user:actor,jarvyOrder:{mode:'preview'}};
  const preview=await orderRouter.createCaller(ctx).create(input);
  if(!('jarvyPreview' in preview))throw Error('preview_failed');
  if(!execution){res.json({request,preview:preview.jarvyPreview,hash:preview.hash,source:'369 Research WaWi'});return;}
  if(preview.hash!==execution.expected_hash)throw Error('draft_changed');
  // Claim once before entering the normal order pipeline. An uncertain attempt is never retried automatically.
  const claim=await pool.query("INSERT INTO jarvy_order_receipts(id,actor_id,request_hash,payload_hash,state) VALUES($1,$2,$3,$4,'executing') ON CONFLICT DO NOTHING RETURNING id",[execution.id,actorId,requestHash,execution.expected_hash]);
  if(!claim.rows.length)throw Error('already_claimed');receiptId=execution.id;
  await orderRouter.createCaller({...ctx,jarvyOrder:{mode:'execute',expectedHash:execution.expected_hash,receiptId}}).create(input);
  const result=(await pool.query('SELECT state,order_id FROM jarvy_order_receipts WHERE id=$1',[receiptId])).rows[0];res.json(result);
 }catch(error){
  if(receiptId){
   await pool.query("UPDATE jarvy_order_receipts SET state='unknown' WHERE id=$1 AND state='executing' AND order_id IS NULL",[receiptId]).catch(()=>{});
   const result=await pool.query('SELECT state,order_id FROM jarvy_order_receipts WHERE id=$1',[receiptId]).then(r=>r.rows[0]).catch(()=>undefined);res.json(result??{state:'unknown'});return;
  }
  const code=error instanceof z.ZodError?'invalid_order':error instanceof Error?error.message:'unavailable';
  const safe=/^(article_requires_wawi|actor_unavailable|customer_email_missing|customer_not_found|customer_address_requires_wawi|article_not_found|stock_unavailable|exact_inventory_sku_required|article_price_unavailable|draft_changed|receipt_mismatch|already_claimed|invalid_order)$/.test(code)?code:'order_validation_failed';
  res.status(409).json({error:safe});
 }
});
