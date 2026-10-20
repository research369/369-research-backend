/** PepGPT liest Angebote; dieser Zugang besitzt keine Schreibroute. */
import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {getPool} from './db.js';
import {botPromotionSelectionSchema,approvedBotPromos} from './botPromoPolicy.js';
import {projectOffers} from './pepgptOffers.js';
export function validOffersKey(value:string|undefined){
 const expected=process.env.PEPGPT_OFFERS_READ_KEY;
 if(!expected||expected.length<40||!value?.startsWith('Bearer '))return false;
 const a=Buffer.from(value.slice(7)),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);
}
const input=z.object({search:z.string().trim().min(2).max(1000),dosage:z.string().trim().min(1).max(100).optional(),quantity:z.number().int().min(1).max(100).default(1),country:z.enum(['DE','AT','CH','FR','NL','BE','IT','ES']).default('DE'),promotion:botPromotionSelectionSchema.default({mode:'none'})}).strict();
export const pepgptOffersRouter=Router();
pepgptOffersRouter.use((req,res,next)=>{
 res.set('Cache-Control','no-store');
 if(!validOffersKey(req.get('authorization'))){res.status(401).json({error:'unauthorized'});return;}
 if(req.method!=='POST'||req.path!=='/offers'||Object.keys(req.query).length){res.status(405).json({error:'offers_read_only'});return;}
 next();
});
pepgptOffersRouter.use(rateLimit({windowMs:60000,limit:60,keyGenerator:()=> 'pepgpt-offers-read',standardHeaders:true,legacyHeaders:false}));
pepgptOffersRouter.post('/offers',async(req,res)=>{
 const parsed=input.safeParse(req.body);if(!parsed.success){res.status(400).json({error:'invalid_offer_query'});return;}
 let client;
 try{
  const pool=await getPool();if(!pool)throw Error('unavailable');client=await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '5000ms'");
  const articles=await client.query('SELECT id,name,sku,shop_product_id,selling_price,sale_price,stock,is_active,shop_visible,variants FROM articles ORDER BY id LIMIT 5001');
  const promos=await client.query(`SELECT code,discount_type,percentage,fixed_amount,min_order,max_uses,current_uses,valid_from,valid_until,valid_until_exact,is_active,description FROM promo_codes p WHERE NOT EXISTS(SELECT 1 FROM customer_promo_assignments a WHERE a.promo_code_id=p.id) AND NOT EXISTS(SELECT 1 FROM sales_followups f WHERE f.promo_code_id=p.id OR f.discount_code=p.code) AND NOT EXISTS(SELECT 1 FROM personal_promo_expiry_reminders r WHERE r.promo_code_id=p.id) AND NOT EXISTS(SELECT 1 FROM partner_codes pc WHERE upper(pc.code_normalized)=upper(p.code)) AND NOT EXISTS(SELECT 1 FROM partners pt WHERE upper(pt.code)=upper(p.code)) AND coalesce(p.description,'') !~* '(follow.?up|persönlich|individuell|bestellung|creator|partner|intern|test)' ORDER BY p.id LIMIT 501`);
  const settings=await client.query("SELECT key,value FROM shop_settings WHERE key IN ('global_automatic_discount','pepgpt_bot_promo_policy')");
  const {rows:[{as_of}]}=await client.query('SELECT transaction_timestamp() AS as_of');
  if(articles.rows.length>5000||promos.rows.length>500)throw Error('limit');
  const config=new Map(settings.rows.map(r=>[r.key,r.value]));
  const approved=approvedBotPromos(config.get('pepgpt_bot_promo_policy'));
  const safePromos=promos.rows.map(p=>({...p,bot_auto_apply:approved.has(String(p.code).toUpperCase()),bot_priority:approved.get(String(p.code).toUpperCase())??0}));
  const result=projectOffers(articles.rows,safePromos,config.get('global_automatic_discount')??null,parsed.data,new Date(as_of));
  await client.query('COMMIT');res.json(result);
 }catch(error){await client?.query('ROLLBACK').catch(()=>{});if(error instanceof Error&&error.message==='promotion_not_eligible')res.status(409).json({error:'promotion_not_eligible'});else res.status(503).json({error:'wawi_offers_unavailable'});}
 finally{client?.release();}
});
