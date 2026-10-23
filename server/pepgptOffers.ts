import {resolveSubstitution,extractDosageMg,isSubstitutionEligible} from './substitutionService.js';
/** Ausschließlich öffentliche Angebotsdaten; keine Kunden- oder Bestellzugriffe. */
import {calculateAutomaticGlobalDiscount,calculatePromoDiscount,calculateAuthoritativeShipping,resolveAuthoritativeItemPrice,roundMoney} from './kwkCheckoutPricing.js';
import {parseGlobalAutomaticDiscountConfig,getActiveGlobalAutomaticDiscount} from './globalAutomaticDiscountConfig.js';
import {projectDiscountRules} from './guardianDiscounts.js';
export type OfferArticle={id:number;name:string;sku:string;shop_product_id:string|null;selling_price:string|null;sale_price:string|null;stock:number;category?:string|null;is_active:number;shop_visible:number;variants:unknown};
const norm=(s:unknown)=>String(s??'').toLowerCase().replace(/retatrutid[e]?|r3ta|\breta\b/g,'3g').replace(/[^a-z0-9äöüß]+/g,' ').trim();
const number=(v:unknown)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
export function projectOffers(articles:OfferArticle[],promos:any[],globalValue:string|null,input:{search:string;dosage?:string;quantity:number;country:string;promotion?:{mode:'none'}|{mode:'explicit_code';code:string}|{mode:'bot_approved'}},now:Date,substitutionEnabled=false){
  const words=norm(input.search).split(' ').filter(w=>w.length>1&&!/^\d+$|^(mg|mcg|iu|ml)$/.test(w)&&!['was','kostet','das','denn','ich','möchte','bestellen','preis','für','und','mit','haben','sie','ihr','bitte','wie','ist','der','die','ein','eine','von','auf','hallo','hi','mir'].includes(w));
  const parents=articles.filter(a=>a.is_active===1&&a.shop_visible===1).map(a=>({a,score:words.reduce((n,w)=>n+(norm(a.name+' '+a.sku+' '+a.shop_product_id).split(' ').includes(w)?1:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  const top=parents[0]?.score??0;const selected=parents.filter(x=>x.score===top).slice(0,2);
  const catalog=articles.map(a=>({sku:a.sku,name:a.name,shopProductId:a.shop_product_id,sellingPrice:a.selling_price,salePrice:a.sale_price,variants:a.variants,isActive:a.is_active,shopVisible:a.shop_visible}));
  const selectedCode=input.promotion?.mode==='explicit_code'?input.promotion.code.trim().toUpperCase():null;
  const auto=input.promotion?.mode==='bot_approved';
  const eligiblePromos=auto?promos.filter(p=>p.bot_auto_apply===true):promos;
  const rules=projectDiscountRules(eligiblePromos,[],now).codes.filter(c=>(auto||!!selectedCode&&c.code.toUpperCase()===selectedCode)&&c.active&&(auto||c.customer_limit===0));
  if(selectedCode&&!rules.length)throw Error('promotion_not_eligible');
  const global=getActiveGlobalAutomaticDiscount(parseGlobalAutomaticDiscountConfig(globalValue),now);
  const offers:any[]=[];
  for(const {a} of selected){
    const configured=Array.isArray(a.variants)&&a.variants.length?a.variants:[{dosage:a.name,inventoryArticleId:a.id,price:a.sale_price??a.selling_price}];
    for(const raw of configured){
      const v=raw as any;if(!v||v.hidden===true||v.isActive===false||v.isActive===0)continue;
      const label=String(v.dosage??v.label??v.name??'');if(!label)continue;
      if(input.dosage&&norm(label)!==norm(input.dosage))continue;
      const family=articles.filter(x=>x.is_active===1&&(a.shop_product_id?x.shop_product_id===a.shop_product_id:x.id===a.id));
      const exact=Number(v.inventoryArticleId);let inventory=Number.isSafeInteger(exact)&&exact>0?family.find(x=>x.id===exact):undefined;
      if(!inventory&&(!exact||exact<=0)){
        const sku=String(v.sku??'').toLowerCase();
        const candidates=family.filter(x=>sku?x.sku.toLowerCase()===sku:norm(x.name.match(/\(([^)]+)\)\s*$/)?.[1]??x.name.match(/(\d+(?:\.\d+)?\s*(?:mg|mcg|iu|ml))\s*$/i)?.[1])===norm(label));
        if(candidates.length===1)inventory=candidates[0];
      }
      if(!inventory&&configured.length===1&&!Array.isArray(a.variants))inventory=a;
      // Ohne eindeutige operative Lagerzeile keine Verfügbarkeitsbehauptung.
      const stock=inventory&&Number.isFinite(Number(inventory.stock))?Math.max(0,Number(inventory.stock)):null;
      const configuredPrice=number(v.price),inventoryPrice=number(inventory?.selling_price),sale=number(a.sale_price);
      let unitPrice:number|null=null;
      if((sale!==null&&sale>0)||(configuredPrice!==null&&configuredPrice>0)||(inventoryPrice!==null&&inventoryPrice>0)){
        try{unitPrice=resolveAuthoritativeItemPrice({shopProductId:a.shop_product_id||a.sku,dosage:label,price:0,quantity:input.quantity},catalog);}catch{}
      }
      if(unitPrice!==null&&unitPrice<=0)unitPrice=null;
      const item={shopProductId:a.shop_product_id||a.sku,price:unitPrice??0,quantity:input.quantity};
      const subtotal=unitPrice===null?null:roundMoney(unitPrice*input.quantity);
      const automatic=subtotal===null?0:calculateAutomaticGlobalDiscount(subtotal,global?.percentage??0);
      const standardShipping=calculateAuthoritativeShipping({country:input.country,items:[{name:a.name,variant:label}]});
      const promotions=subtotal===null?[]:rules.flatMap(rule=>{
        if(subtotal<rule.min_order)return[];
        const rawPromo=promos.find(p=>p.code===rule.code);if(!rawPromo)return[];
        const preceding=global?.stackWithPromotionCodes?automatic:0;
        const discount=calculatePromoDiscount({subtotal,items:[item],precedingProductDiscount:preceding,promo:{discountType:rawPromo.discount_type,percentage:Number(rawPromo.percentage||0),fixedAmount:Number(rawPromo.fixed_amount||0),description:rawPromo.description}});
        const shipping=calculateAuthoritativeShipping({country:input.country,items:[{name:a.name,variant:label}],promoDescription:rawPromo.description});
        if(discount<=0&&shipping>=standardShipping)return[];
        const productTotal=roundMoney(subtotal-preceding-discount);
        // Keinen Code als Vorteil nennen, wenn er einen höheren Endpreis verursacht.
        if(productTotal+shipping>subtotal-automatic+standardShipping)return[];
        return[{code:rule.code,...(auto?{bot_approved:true,bot_priority:rawPromo.bot_priority??0,customer_limit:rule.customer_limit,requires_customer_eligibility_check:rule.customer_limit>0||/neukund/i.test(String(rawPromo.description??'')),new_customer_only:/neukund/i.test(String(rawPromo.description??''))}:{}),discount:roundMoney(discount),percentage:rule.percentage,fixed_amount:rule.fixed_amount,min_order:rule.min_order,product_total:productTotal,shipping,total:roundMoney(productTotal+shipping),valid_until:rawPromo.valid_until,valid_until_exact:rawPromo.valid_until_exact,quantity:input.quantity}];
      }).sort((x,y)=>Number(x.requires_customer_eligibility_check??false)-Number(y.requires_customer_eligibility_check??false)||x.total-y.total||(y.bot_priority??0)-(x.bot_priority??0)||x.code.localeCompare(y.code));
      if(auto)promotions.splice(1);
      if(selectedCode&&promotions.length===0)throw Error('promotion_not_eligible');
      let fulfillment:any=null;
      if(substitutionEnabled && inventory && inventory.shop_product_id && stock!==null && stock<input.quantity && isSubstitutionEligible(inventory.category)) {
        const mg=extractDosageMg(label);
        const direct=Math.min(Math.floor(stock),input.quantity);
        if(mg && mg>0) {
          const candidates=articles.filter(x=>x.is_active===1 && x.shop_product_id===inventory!.shop_product_id && (x.category??null)===(inventory!.category??null)).map(x=>({id:x.id,name:x.name,sku:x.sku,stock:x.stock,shopProductId:x.shop_product_id,category:x.category??null}));
          const plan=resolveSubstitution(inventory.shop_product_id,mg,input.quantity-direct,candidates);
          if(plan.possible) {
            const components=[...(direct?[{articleId:inventory.id,articleName:inventory.name,sku:inventory.sku,quantity:direct,dosageMg:mg}]:[]),...plan.components];
            const total=components.reduce((n,c)=>n+c.quantity*c.dosageMg,0);
            if(Math.abs(total-input.quantity*mg)<1e-9) fulfillment={requested_quantity:input.quantity,requested_variant:label,total_content_mg:total,components:components.map(c=>({inventory_article_id:c.articleId,sku:c.sku,name:c.articleName,quantity:c.quantity,content_mg:c.dosageMg}))};
          }
        }
      }
      offers.push({product_id:a.shop_product_id||a.sku,name:a.name,variant:label,inventory_article_id:inventory?.id??null,sku:inventory?.sku??null,unit_price:unitPrice,quantity:input.quantity,stock,available:stock===null?null:stock>=input.quantity||!!fulfillment,...(fulfillment?{fulfillment}:{}),subtotal,automatic_discount:automatic,product_total:subtotal===null?null:roundMoney(subtotal-automatic),shipping:standardShipping,total:subtotal===null?null:roundMoney(subtotal-automatic+standardShipping),promotions});
    }
  }
  return{schema_version:1,source:'369 Research WaWi',as_of:now.toISOString(),currency:'EUR',country:input.country,read_only:true,not_reserved:true,offers:offers.slice(0,20),truncated:offers.length>20};
}
