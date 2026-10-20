/** PepGPT liest Angebote; dieser Zugang besitzt keine Schreibroute. */
import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {getPool} from './db.js';
import {projectOffers} from './pepgptOffers.js';
export function validOffersKey(value:string|undefined){
 const expected=process.env.PEPGPT_OFFERS_READ_KEY;
 if(!expected||expected.length<40||!value?.startsWith('Bearer '))return false;
 const a=Buffer.from(value.slice(7)),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);
}
const input=z.object({search:z.string().trim().min(2).max(1000),dosage:z.string().trim().min(1).max(100).optional(),quantity:z.number().int().min(1).max(100).default(1),country:z.enum(['DE','AT','CH','FR','NL','BE','IT','ES']).default('DE')}).strict();
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
  const promos=await client.query(`SELECT code,discount_type,percentage,fixed_amount,min_order,max_uses,current_uses,valid_from,valid_until,valid_until_exact,is_active,description FROM promo_codes p WHERE NOT EXISTS(SELECT 1 FROM customer_promo_assignments a WHERE a.promo_code_id=p.id) ORDER BY p.id LIMIT 501`);
  const settings=await client.query("SELECT value FROM shop_settings WHERE key='global_automatic_discount' LIMIT 1");
  const {rows:[{as_of}]}=await client.query('SELECT transaction_timestamp() AS as_of');
  if(articles.rows.length>5000||promos.rows.length>500)throw Error('limit');
  const result=projectOffers(articles.rows,promos.rows,settings.rows[0]?.value??null,parsed.data,new Date(as_of));
  await client.query('COMMIT');res.json(result);
 }catch{await client?.query('ROLLBACK').catch(()=>{});res.status(503).json({error:'wawi_offers_unavailable'});}
 finally{client?.release();}
});
