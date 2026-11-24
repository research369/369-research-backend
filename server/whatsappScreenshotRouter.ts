/** Dedicated operator bridge. Never reuses PepGPT's read-only credential. */
import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {getPool} from './db.js';
import type {Context} from './trpc.js';
import {screenshotExtractionInputSchema,extractScreenshotOrder} from './screenshotOrderExtraction.js';
import {screenshotCustomersInputSchema,screenshotCatalogInputSchema,screenshotQuoteInputSchema,screenshotExecuteInputSchema,screenshotDraftInputSchema} from './screenshotOrderContract.js';
import {lookupScreenshotCustomers,lookupScreenshotCatalog,quoteScreenshotOrder,executeScreenshotOrder,statusScreenshotOrder,resultScreenshotOrder,screenshotSafeError} from './screenshotOrderService.js';
export const SELF_ORDER_PHONE='4915510063537';
export function validSelfOrderKey(authorization:string|undefined,env:NodeJS.ProcessEnv=process.env){
 const key=env.WHATSAPP_SCREENSHOT_KEY;
 if(env.WHATSAPP_SCREENSHOT_ENABLED!=='on'||!key||key.length<40||[env.PEPGPT_OFFERS_READ_KEY,env.JARVY_READ_KEY,env.JARVY_WRITE_KEY].includes(key)||!authorization?.startsWith('Bearer '))return false;
 const a=Buffer.from(authorization.slice(7)),b=Buffer.from(key);return a.length===b.length&&timingSafeEqual(a,b);
}
const deps={extract:extractScreenshotOrder,customers:lookupScreenshotCustomers,catalog:lookupScreenshotCatalog,quote:quoteScreenshotOrder,execute:executeScreenshotOrder,status:statusScreenshotOrder,result:resultScreenshotOrder,
 actor:async()=>{const id=Number(process.env.WHATSAPP_SCREENSHOT_ACTOR_ID);if(!Number.isSafeInteger(id)||id<1)throw Error('actor_missing');const pool=await getPool();if(!pool)throw Error('unavailable');return (await pool.query('SELECT id,username,name,email,role FROM users WHERE id=$1 AND role=$2',[id,'admin'])).rows[0];}};
export function createWhatsappScreenshotRouter(overrides:Partial<typeof deps>={}){
 const service={...deps,...overrides},r=Router();
 const schemas={extract:screenshotExtractionInputSchema,customers:screenshotCustomersInputSchema,catalog:screenshotCatalogInputSchema,quote:screenshotQuoteInputSchema,execute:screenshotExecuteInputSchema,status:screenshotDraftInputSchema,result:screenshotDraftInputSchema};
 r.use((req,res,next)=>{res.set('Cache-Control','no-store, private');if(!validSelfOrderKey(req.get('authorization'))){res.status(401).json({error:'unauthorized'});return;}if(req.method!=='POST'||Object.keys(req.query).length){res.status(405).json({error:'unsupported'});return;}next();});
 r.use(rateLimit({windowMs:60000,limit:20,keyGenerator:()=> 'whatsapp-screenshot',standardHeaders:true,legacyHeaders:false}));
 r.post('/:operation',async(req,res)=>{
  const op=req.params.operation as keyof typeof schemas;
  if(!Object.hasOwn(schemas,op)){res.status(404).json({error:'unsupported'});return;}
  const envelope=z.object({operator:z.literal(SELF_ORDER_PHONE),payload:schemas[op]}).strict().safeParse(req.body);
  if(!envelope.success){res.status(400).json({error:'invalid_input'});return;}
  if(op==='execute'&&process.env.WHATSAPP_SCREENSHOT_EXECUTE!=='on'){res.status(403).json({error:'execution_disabled'});return;}
  try{
   const actor=await service.actor();if(!actor||actor.role!=='admin'){res.status(403).json({error:'actor_unavailable'});return;}
   const ctx={req,res,user:actor} as Context,input:any=envelope.data.payload;
   let result:unknown;
   switch(op){
    case 'extract':result=await service.extract(input,actor.id);break;
    case 'customers':result=await service.customers(input);break;
    case 'catalog':result=await service.catalog(input);break;
    case 'quote':result=await service.quote(input,ctx);break;
    case 'execute':result=await service.execute(input.quoteToken,ctx);break;
    case 'status':result=await service.status(input.draftId,actor.id);break;
    case 'result':result=await service.result(input.draftId,ctx);break;
   }
   res.json(result);
  }catch(e){try{screenshotSafeError(e);}catch(safe){res.status(409).json({error:(safe as Error).message});}}
 });return r;
}
export const whatsappScreenshotRouter=createWhatsappScreenshotRouter();
