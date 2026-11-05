/** Fixed private rule projection: no contacts, orders, balances or credentials. */
export const guardianPromoSql = `SELECT code, discount_type, percentage, fixed_amount, min_order,
 max_uses, current_uses, valid_from, valid_until, valid_until_exact, is_active, description
 FROM promo_codes ORDER BY id LIMIT 501`;
export const guardianPartnerSql = `SELECT pc.display_code AS code, pc.customer_discount_percent AS percentage,
 pc.is_active AND p.is_active = 1 AND pp.active AS active,
 pp.key AS kind, pp.customer_discount_policy AS policy
 FROM partner_codes pc JOIN partners p ON p.id=pc.partner_id
 JOIN partner_programs pp ON pp.key=p.program_key ORDER BY pc.id LIMIT 501`;
export function projectDiscountRules(promos:any[],partners:any[],now=new Date()) {
 if(promos.length+partners.length>500)throw Error('discount_limit');
 const codes=promos.map(p=>{
  let metadata:any={};const text=String(p.description??'');const i=text.lastIndexOf(' | {');
  if(i>=0){try{metadata=JSON.parse(text.slice(i+3));}catch{throw Error('discount_metadata_invalid');}}
  const strings=(v:any)=>v===undefined?[]:Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length<=160)?v:(()=>{throw Error('discount_metadata_invalid');})();
  const end=p.valid_until?new Date(p.valid_until):null;
  if(end&&p.valid_until_exact!==1)end.setHours(23,59,59,999);
  const active=p.is_active===1&&(!p.valid_from||new Date(p.valid_from)<=now)&&(!end||now<=end)&&(!(p.max_uses>0)||p.current_uses<p.max_uses);
  return {code:p.code,kind:'promo',active,policy:'code_rules',percentage:p.discount_type==='percent'?Number(p.percentage):0,fixed_amount:p.discount_type==='fixed'?Number(p.fixed_amount):0,min_order:Number(p.min_order),restrict:strings(metadata.restrict),free_shipping:strings(metadata.freeShipping),customer_limit:Number(metadata.maxPerCustomer??0)};
 }).concat(partners.map(p=>({code:p.code,kind:p.kind,active:p.active===true,policy:p.policy,percentage:Number(p.percentage),fixed_amount:0,min_order:0,restrict:[],free_shipping:[],customer_limit:0})));
 const seen=new Set();for(const c of codes){if(typeof c.code!=='string'||!c.code||c.code.length>50||seen.has(c.code.toUpperCase())||!Number.isFinite(c.percentage)||c.percentage<0||c.percentage>100||![c.fixed_amount,c.min_order,c.customer_limit].every(x=>Number.isFinite(x)&&x>=0))throw Error('discount_rules_invalid');seen.add(c.code.toUpperCase());}
 return {schema_version:1,source:'369-wawi-discounts',as_of:now.toISOString(),complete:true,codes};
}
