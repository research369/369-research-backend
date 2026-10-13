/** Guardian reads fixed stock and discount projections; no customer access. */
import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {timingSafeEqual} from 'node:crypto';
import {getPool} from './db.js';
import {guardianPromoSql,guardianPartnerSql,projectDiscountRules} from './guardianDiscounts.js';

export const guardianInventorySql = `SELECT id, sku, shop_product_id, stock, is_active, shop_visible,
  CASE WHEN jsonb_typeof(variants::jsonb)='array' THEN
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'dosage',v->>'dosage','label',v->>'label','name',v->>'name',
      'inventoryArticleId',v->'inventoryArticleId','stock',v->'stock',
      'hidden',v->'hidden','isActive',v->'isActive')), '[]'::jsonb)
      FROM jsonb_array_elements(variants::jsonb) v)
    ELSE '[]'::jsonb END AS variants
  FROM articles ORDER BY id LIMIT 5001`;
export function guardianKeyValid(authorization:string|undefined){
  const expected=process.env.GUARDIAN_INVENTORY_READ_KEY;
  if(!expected||expected.length<40||!authorization?.startsWith('Bearer '))return false;
  const a=Buffer.from(authorization.slice(7)),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
export const guardianInventoryRouter=Router();
guardianInventoryRouter.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!guardianKeyValid(req.get('authorization'))){res.status(401).json({error:'unauthorized'});return;}
  if(req.method!=='GET'||!['/inventory','/discounts'].includes(req.path)||Object.keys(req.query).length){res.status(405).json({error:'inventory_read_only'});return;}
  next();
});
guardianInventoryRouter.use(rateLimit({windowMs:60000,limit:6,keyGenerator:()=> 'guardian-inventory',standardHeaders:true,legacyHeaders:false}));
guardianInventoryRouter.get('/inventory',async(_req,res)=>{
  let client;
  try{
    const pool=await getPool();if(!pool)throw Error('unavailable');
    client=await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const result=await client.query(guardianInventorySql);
    if(result.rows.length>5000)throw Error('inventory_limit');
    const {rows:[{as_of}]}=await client.query('SELECT transaction_timestamp() AS as_of');
    await client.query('COMMIT');
    res.json({schema_version:1,source:'369-wawi-inventory',as_of,complete:true,articles:result.rows});
  }catch{
    await client?.query('ROLLBACK').catch(()=>{});
    res.status(503).json({error:'inventory_unavailable'});
  }finally{client?.release();}
});

// Explicit opt-in before expanding the existing inventory credential's read scope.
guardianInventoryRouter.get('/discounts',async(_req,res)=>{
 if(process.env.GUARDIAN_DISCOUNT_READ_ENABLED!=='true'){res.status(503).json({error:'discount_read_disabled'});return;}
 let client;
 try{
  const pool=await getPool();if(!pool)throw Error('unavailable');client=await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '5000ms'");
  const promos=await client.query(guardianPromoSql),partners=await client.query(guardianPartnerSql);
  const {rows:[{as_of}]}=await client.query('SELECT transaction_timestamp() AS as_of');
  const result=projectDiscountRules(promos.rows,partners.rows,new Date(as_of));
  await client.query('COMMIT');res.json(result);
 }catch{await client?.query('ROLLBACK').catch(()=>{});res.status(503).json({error:'discount_rules_unavailable'});}
 finally{client?.release();}
});
