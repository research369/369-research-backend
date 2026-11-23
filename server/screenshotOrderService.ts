import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { articles, customers, promoCodes, shopSettings } from '../drizzle/schema.js';
import { getDb, withReadOnlyDatabase } from './db.js';
import type { Context } from './trpc.js';
import { orderRouter } from './orderRouter.js';
import { communicationTemplateRouter } from './communicationTemplateRouter.js';
import { normalizeWhatsappContactPhone } from './whatsappContactIdentity.js';
import { normalizeOrderCommunicationPhone } from './orderCommunicationPhoneService.js';
import { calculateAuthoritativeShipping, calculateAutomaticGlobalDiscount, calculatePromoDiscount, resolveShippingRegion, roundMoney, resolveAuthoritativeItemPrice } from './kwkCheckoutPricing.js';
import { getActiveGlobalAutomaticDiscount, parseGlobalAutomaticDiscountConfig, resolveGlobalAutomaticDiscountBenefits } from './globalAutomaticDiscountConfig.js';
import { reconcileFreeBacWaterForShopOrder } from './freeBacWaterService.js';
import { isPromoCodeExpired } from './promoCodeRouter.js';
import { resultRows } from './priorityOrderIntegrity.js';
import { screenshotHash, screenshotIntentKey, signScreenshotQuote, verifyScreenshotQuote, type ScreenshotQuoteInput, type ScreenshotQuoteEnvelope, type ScreenshotForm } from './screenshotOrderContract.js';
import { readPersistedOrderMessageData } from './orderDiscountMessageService.js';
import { getReleasedBankTransferInstructions } from './paymentInstructionsConfig.js';
import { assertNoActiveCheckoutBlock } from './customerOrderBlockService.js';

const revisions=new Map<string,{revision:string;expiresAt:number}>();
const email=(v:unknown)=>String(v??'').trim().toLowerCase();
const phone=(v:unknown)=>normalizeWhatsappContactPhone(String(v??''));
const norm=(v:unknown)=>String(v??'').toLowerCase().replace(/retatrutid[e]?|r3ta|\breta\b|triple\s*g/g,'3g').replace(/\b(tierze|tirze)\b/g,'tirzepatide').replace(/[^a-z0-9äöüß]+/g,' ').trim();
const strength=(v:unknown)=>String(v??'').toLowerCase().replace(/,/g,'.').replace(/\s+/g,'').trim();
export function screenshotCustomerResolution(rows:any[],input:{phone?:string;email?:string;name?:string}){
  const p=phone(input.phone),e=email(input.email),n=norm(input.name);
  const ps=p?rows.filter(c=>phone(c.phone)===p):[],es=e?rows.filter(c=>email(c.email)===e):[];
  const contacts=[...new Map([...ps,...es].map(c=>[c.id,c])).values()];
  const conflict=ps.length>1||es.length>1||contacts.length>1;
  const names=n?rows.filter(c=>norm(c.name||[c.firstName,c.lastName].join(' ')).includes(n)).slice(0,20):[];
  const candidates=[...contacts,...names.filter(c=>!contacts.some(x=>x.id===c.id))].map(c=>({
    id:c.id,customerNumber:c.customerNumber??null,name:c.name??'',firstName:c.firstName??'',lastName:c.lastName??'',email:c.email??null,phone:c.phone??null,
    street:c.street??'',houseNumber:c.houseNumber??'',zip:c.zip??'',city:c.city??'',country:c.country??'',company:c.company??null,dhlPostNumber:c.dhlPostNumber??null,deliveryType:/^packstation\b/i.test(c.street??'')&&/^\d{6,12}$/.test(c.dhlPostNumber??'')?'packstation':/^postfiliale\b/i.test(c.street??'')&&/^\d{6,12}$/.test(c.dhlPostNumber??'')?'postfiliale':'home',
    matchBasis:ps.some(x=>x.id===c.id)?es.some(x=>x.id===c.id)?'phone_email':'phone':es.some(x=>x.id===c.id)?'email':'name',
  }));
  return {match:conflict?'conflict' as const:contacts.length===1?'exact' as const:'none' as const,...(!conflict&&contacts.length===1?{exactCustomerId:contacts[0].id}:{}),candidates,...(conflict?{reason:'duplicate_or_split_contacts'}:{})};
}
function form(a:any,label=''):ScreenshotForm{const s=[a.name,a.sku,a.category,JSON.stringify(a.categories??[]),label].join(' ');if(/nasal|nasenspray/i.test(s))return 'nasal';if(/plug\s*[&+_-]?\s*play|patrone|cartridge|fertigpen|forscherpen/i.test(s))return 'plug_play';return /vial|peptide/i.test(s)?'vial':'other';}
function dosage(a:any){return a.name.match(/\((\d+(?:[.,]\d+)?\s*(?:mg|mcg|iu|ml))\)\s*$/i)?.[1]??a.name.match(/\b(\d+(?:[.,]\d+)?\s*(?:mg|mcg|iu|ml))\s*$/i)?.[1]??'';}
/** Existing canonical price resolver and published-parent -> exact inventory mapping. */
export function screenshotCatalogProjection(rows:any[]){
  const duplicates=new Set<string>();const seen=new Set<string>();for(const a of rows){const k=a.sku.toLowerCase();if(seen.has(k))duplicates.add(k);seen.add(k);}
  const result=new Map<string,any>(),ambiguous=new Set<string>();
  for(const parent of rows.filter(a=>a.isActive===1&&a.shopVisible===1&&a.publishedAt&&Number(a.sellingPrice)>0&&!/\[draft\]|price[_ -]?open|open[_ -]?price/i.test([a.name,a.notes,JSON.stringify(a.description??{})].join(' ')))){
    const variants=Array.isArray(parent.variants)&&parent.variants.length?parent.variants:[{label:dosage(parent),inventoryArticleId:parent.id}];
    for(const v of variants){if(!v||v.hidden===true||v.isActive===false||v.isActive===0||v.price===null)continue;
      const label=String(v.dosage??v.label??v.name??dosage(parent));
      const family=rows.filter(a=>a.isActive===1&&(parent.shopProductId?a.shopProductId===parent.shopProductId:a.id===parent.id));
      const choices=v.inventoryArticleId?family.filter(a=>a.id===Number(v.inventoryArticleId)):v.sku?family.filter(a=>a.sku.toLowerCase()===String(v.sku).toLowerCase()):family.filter(a=>strength(dosage(a))===strength(label));
      if(choices.length!==1)continue;const a=choices[0];if(duplicates.has(a.sku.toLowerCase())||Number(a.sellingPrice)<=0)continue;
      let price:number;try{price=resolveAuthoritativeItemPrice({shopProductId:a.sku,dosage:label,price:0,quantity:1},rows);}catch{continue;}
      if(!Number.isFinite(price)||price<=0)continue;
      const candidate={sku:a.sku,name:a.name,dosage:label,form:form(a,label),price:roundMoney(price),stock:a.stock,shopProductId:parent.shopProductId||a.sku,articleId:a.id,parentId:parent.id};
      const old=result.get(a.sku);if(old&&screenshotHash({...old,parentId:0})!==screenshotHash({...candidate,parentId:0}))ambiguous.add(a.sku);else result.set(a.sku,candidate);
    }
  }
  return [...result.values()].filter(c=>!ambiguous.has(c.sku));
}
export async function lookupScreenshotCustomers(input:any){return withReadOnlyDatabase(async()=>{const db=await getDb();if(!db)throw Error('DATABASE_UNAVAILABLE');return screenshotCustomerResolution(await db.select().from(customers),input);});}
export async function lookupScreenshotCatalog(input:any){return withReadOnlyDatabase(async()=>{const db=await getDb();if(!db)throw Error('DATABASE_UNAVAILABLE');const words=norm(input.query).split(' ').filter(Boolean);const candidates=screenshotCatalogProjection(await db.select().from(articles)).filter(c=>words.every(w=>norm(c.name+' '+c.sku+' '+c.shopProductId).includes(w))&&(!input.strength||strength(c.dosage)===strength(input.strength))&&(!input.form||c.form===input.form)).slice(0,100).map(({articleId,parentId,...c})=>c);return {candidates};});}
async function source(db:any,request:ScreenshotQuoteInput){
  const arts=await db.select().from(articles);const profiles=await db.select().from(customers);
  const settings=await db.select().from(shopSettings);const globalValue=settings.find((s:any)=>s.key==='global_automatic_discount')?.value;
  const global=getActiveGlobalAutomaticDiscount(parseGlobalAutomaticDiscountConfig(globalValue));
  const resolution=screenshotCustomerResolution(profiles,request.customer);if(resolution.match==='conflict')throw Error('CUSTOMER_CONTACT_CONFLICT');
  const selectedId=request.existingCustomerId??resolution.exactCustomerId;
  if(request.existingCustomerId&&resolution.exactCustomerId&&resolution.exactCustomerId!==request.existingCustomerId)throw Error('CUSTOMER_CONTACT_CONFLICT');
  const selected=selectedId?profiles.find((c:any)=>c.id===selectedId):null;if(selectedId&&!selected)throw Error('CUSTOMER_NOT_FOUND');
  const customer={...request.customer};if(selected){customer.firstName=selected.firstName??'';customer.lastName=selected.lastName??'';customer.phone=selected.phone??'';customer.email=selected.email??'';if(!customer.firstName||!customer.lastName||!normalizeOrderCommunicationPhone(customer.phone))throw Error('CUSTOMER_PROFILE_REQUIRES_REVIEW');}
  const selectedResolution=screenshotCustomerResolution(profiles,customer);
  if(selectedResolution.match==='conflict'||(selectedResolution.exactCustomerId&&selectedResolution.exactCustomerId!==selectedId))throw Error('CUSTOMER_CONTACT_CONFLICT');
  if(!normalizeOrderCommunicationPhone(customer.phone))throw Error('CUSTOMER_PHONE_INVALID');
  const catalog=screenshotCatalogProjection(arts);const items=request.items.map(line=>{const c=catalog.find(c=>c.sku===line.sku);if(!c)throw Error('EXACT_PUBLISHED_SKU_REQUIRED');if(c.stock<line.quantity)throw Error('STOCK_UNAVAILABLE');if(c.form!=='vial'||/bundle|diy|\bset\b/i.test(c.name))throw Error('COMPONENT_FORM_REQUIRES_WAWI');return {name:c.name,dosage:c.dosage,shopProductId:c.sku,price:c.price,quantity:line.quantity,type:'peptide'};});
  const subtotal=roundMoney(items.reduce((s,i)=>s+i.price*i.quantity,0));
  let promo:any=null;if(request.discount.mode==='code'){
    const code=request.discount.code.toUpperCase();const matches=(await db.select().from(promoCodes)).filter((p:any)=>p.code.toUpperCase()===code);
    if(matches.length!==1)throw Error('PROMOTION_INVALID');promo=matches[0];
    if(promo.isActive!==1||(promo.validFrom&&Date.now()<new Date(promo.validFrom).getTime())||isPromoCodeExpired(promo)||((promo.maxUses??0)>0&&promo.currentUses>=promo.maxUses)||subtotal<Number(promo.minOrder||0))throw Error('PROMOTION_INVALID');
    // Generic public promos only. Personalized/partner/new-customer eligibility belongs to its native flow.
    const guards=resultRows(await db.execute(sql`SELECT EXISTS(SELECT 1 FROM customer_promo_assignments WHERE promo_code_id=${promo.id}) AS personal,
      EXISTS(SELECT 1 FROM partner_codes WHERE upper(code_normalized)=upper(${code})) AS partner,
      EXISTS(SELECT 1 FROM sales_followups WHERE promo_code_id=${promo.id}) AS followup`))[0];
    if(guards.personal||guards.partner||guards.followup||/neukund|new.customer|follow.?up|reminder|kwk|partner|creator/i.test(promo.description??''))throw Error('PROMOTION_REQUIRES_NATIVE_ELIGIBILITY');
  }
  if(global?.exclusiveCampaign&&request.discount.mode!=='none')throw Error('EXCLUSIVE_CAMPAIGN_DISCOUNT_FORBIDDEN');
  const benefits=resolveGlobalAutomaticDiscountBenefits(global,{merchandiseSubtotal:subtotal,shippingRegion:resolveShippingRegion(customer.country),hasPromotionCode:Boolean(promo)});
  const automatic=benefits.globalDiscountApplies?calculateAutomaticGlobalDiscount(subtotal,global?.percentage??0):0;
  const requested=request.discount.mode==='percent'?roundMoney(subtotal*request.discount.value/100):request.discount.mode==='amount'?request.discount.value:0;
  const manual=roundMoney(Math.min(Math.max(0,subtotal-automatic),requested));
  const promoAmount=promo?calculatePromoDiscount({subtotal,items,precedingProductDiscount:automatic,promo:{discountType:promo.discountType,percentage:Number(promo.percentage||0),fixedAmount:Number(promo.fixedAmount||0),description:promo.description}}):0;
  const shipping=calculateAuthoritativeShipping({country:customer.country,items,coldChainRequested:request.coldShippingRequested,promoDescription:promo?.description,freeBaseShipping:benefits.globalFreeShippingApplies,coldShippingSurcharge:global?.coldShippingSurcharge});
  const manualBreakdown=manual>0?[{source:request.discount.mode==='percent'?'manual_global_percent':'manual_global_amount',label:request.discount.mode==='percent'?`Manueller Rabatt (${request.discount.value}%)`:'Manueller Betragsrabatt',amount:manual,...(request.discount.mode==='percent'?{percentage:request.discount.value}:{})}]:[];
  const canonicalInput={orderSource:'wawi_manual',storeKey:'369research',communicationLanguage:selected?.communicationLanguage==='en'?'en':'de',sendOrderConfirmation:false,customer,items:reconcileFreeBacWaterForShopOrder(items,arts,global),subtotal,discount:manual+promoAmount,discountBreakdown:manualBreakdown,discountCode:promo?.code??null,shipping,shippingCountry:resolveShippingRegion(customer.country),total:roundMoney(subtotal-manual-promoAmount+shipping),paymentMethod:'wise',date:new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Berlin'}),...(selectedId?{existingCustomerId:selectedId}:{}),internalNote:request.internalNote??'',coldShippingRequested:request.coldShippingRequested??false,...(request.addressWarningConfirmed?{addressValidationOverride:{confirmed:true}}:{})};
  const relevantIds=new Set(catalog.filter(c=>request.items.some(i=>i.sku===c.sku)).flatMap(c=>[c.articleId,c.parentId]));
  // Hash data/revisions, not names as identity. No persistent quote/customer store.
  const sourceHash=screenshotHash({articles:arts.filter((a:any)=>relevantIds.has(a.id)||request.items.some(i=>i.sku.toLowerCase()===a.sku.toLowerCase())),resolution,selected: selected?{...selected,totalOrders:undefined,totalSpent:undefined,firstOrderDate:undefined,lastOrderDate:undefined}:null,settings:settings.filter((s:any)=>/global_automatic_discount|bank_transfer_payment_instructions|address_validation|cold_shipping|customer_number_migration_pause/.test(s.key)),global,promo,canonicalInput});
  return {canonicalInput,sourceHash,selectedId,relevantArticleIds:[...relevantIds].sort((a,b)=>a-b)};
}
export async function quoteScreenshotOrder(request:ScreenshotQuoteInput,ctx:Context){
  if(!ctx.user||ctx.user.role!=='admin')throw Error('ADMIN_REQUIRED');
  const calculated=await withReadOnlyDatabase(async()=>{const db=await getDb();if(!db)throw Error('DATABASE_UNAVAILABLE');const s=await source(db,request);const result=await orderRouter.createCaller({...ctx,screenshotOrder:{mode:'preview'}}).create(s.canonicalInput as any);if(!('screenshotPreview' in result))throw Error('QUOTE_UNAVAILABLE');return {...s,result:result as any};});
  const key=screenshotIntentKey(ctx.user.id,request.draftId),expiresAt=Date.now()+600000,revision=randomUUID();
  for(const [k,v] of revisions)if(v.expiresAt<=Date.now())revisions.delete(k);if(revisions.size>=10000&&!revisions.has(key))throw Error('QUOTE_CAPACITY');
  const envelope:ScreenshotQuoteEnvelope={version:1,actorId:ctx.user.id,draftId:request.draftId,expiresAt,revision,canonicalInput:calculated.canonicalInput,expectedHash:calculated.result.hash,sourceHash:calculated.sourceHash};
  // Validated original request is inside the signed envelope; used only for locked reconstruction.
  (envelope as any).request=request;(envelope as any).articleIds=calculated.relevantArticleIds;const quoteToken=signScreenshotQuote(envelope);revisions.set(key,{revision,expiresAt});
  const {input,discountBreakdown}=calculated.result.screenshotPreview;
  return {quoteToken,expiresAt:new Date(expiresAt).toISOString(),preview:{customer:input.customer,existingCustomerId:calculated.selectedId??null,items:input.items.map((i:any)=>({sku:i.shopProductId,name:i.name,dosage:i.dosage??'',quantity:i.quantity,price:i.price,isFreeGift:Boolean(i.isFreeGift)})),subtotal:input.subtotal,discount:input.discount,discountBreakdown,shipping:input.shipping,total:input.total,paymentMethod:'wise' as const,coldShippingRequested:Boolean(input.coldShippingRequested)},warnings:request.addressWarningConfirmed?['ADDRESS_WARNING_EXPLICITLY_CONFIRMED']:[]};
}
async function receipt(draftId:string,actorId:number){const db=await getDb();if(!db)throw Error('DATABASE_UNAVAILABLE');const r=resultRows(await db.execute(sql`SELECT response FROM priority_checkout_receipts WHERE intent_key=${screenshotIntentKey(actorId,draftId)}`))[0]?.response;return r?.screenshotActorId===actorId&&r?.screenshotDraftId===draftId?r:null;}
export async function statusScreenshotOrder(draftId:string,actorId:number):Promise<{state:'not_found'|'succeeded'|'unknown';orderId?:string}>{try{const r=await receipt(draftId,actorId);return r?{state:'succeeded',orderId:r.orderId}:{state:'not_found'};}catch{return {state:'unknown'};}}
export async function executeScreenshotOrder(token:string,ctx:Context){
  if(!ctx.user||ctx.user.role!=='admin')throw Error('ADMIN_REQUIRED');const envelope=verifyScreenshotQuote(token,ctx.user.id,Date.now(),true);const key=screenshotIntentKey(ctx.user.id,envelope.draftId);
  const saved=await receipt(envelope.draftId,ctx.user.id);if(saved)return {state:'succeeded' as const,orderId:saved.orderId,idempotencyKey:key};
  verifyScreenshotQuote(token,ctx.user.id);const current=revisions.get(key);if(!current||current.revision!==envelope.revision)throw Error('QUOTE_REPLACED');
  const request=(envelope as any).request as ScreenshotQuoteInput;
  const response=await orderRouter.createCaller({...ctx,screenshotOrder:{mode:'execute',actorId:ctx.user.id,draftId:envelope.draftId,expectedHash:envelope.expectedHash,validateInTransaction:async(tx)=>{
    // Policy/config mutations use this same global campaign key. Exact stock and customer
    // checks happen BEFORE any canonical transaction writes, including receipt/stock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('global_automatic_discount'))`);
    await tx.execute(sql`SELECT key FROM shop_settings WHERE key LIKE 'address_validation%' OR key LIKE 'cold_shipping%' OR key IN ('global_automatic_discount','bank_transfer_payment_instructions','customer_number_migration_pause') ORDER BY key FOR SHARE`);
    // Match canonical block keys before customer rows; never lock unrelated CRM/shop tables.
    await assertNoActiveCheckoutBlock(tx,envelope.canonicalInput.customer);
    const identities=[...new Set([email(request.customer.email),phone(request.customer.phone),email(envelope.canonicalInput.customer.email),phone(envelope.canonicalInput.customer.phone)].filter(Boolean))].sort();
    for(const identity of identities)await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'wawi-contact:'+identity},0))`);
    const currentProfiles=await tx.select().from(customers);
    const targetIds=currentProfiles.filter((c:any)=>c.id===envelope.canonicalInput.existingCustomerId||identities.includes(email(c.email))||identities.includes(phone(c.phone))).map((c:any)=>c.id).sort((a:number,b:number)=>a-b);
    if(targetIds.length)await tx.execute(sql`SELECT id FROM customers WHERE id IN (${sql.join(targetIds.map((id:number)=>sql`${id}`),sql`,`)}) ORDER BY id FOR UPDATE NOWAIT`);
    const articleIds=(envelope as any).articleIds as number[];
    await tx.execute(sql`SELECT id FROM articles WHERE id IN (${sql.join(articleIds.map(id=>sql`${id}`),sql`,`)}) ORDER BY id FOR UPDATE NOWAIT`);
    const actor=resultRows(await tx.execute(sql`SELECT id FROM users WHERE id=${ctx.user!.id} AND role='admin' FOR SHARE`));if(!actor.length)throw Error('ACTOR_REVOKED');
    if(envelope.expiresAt<=Date.now()||revisions.get(key)?.revision!==envelope.revision)throw Error('QUOTE_EXPIRED_OR_REPLACED');
    if(request.discount.mode==='code')await tx.execute(sql`SELECT id FROM promo_codes WHERE upper(code)=upper(${request.discount.code}) FOR UPDATE NOWAIT`);
    const fresh=await source(tx,request);if(fresh.sourceHash!==envelope.sourceHash)throw Error('QUOTE_CHANGED');
  }}}).create({...envelope.canonicalInput,checkoutIdempotencyKey:key} as any);
  if(!('orderId' in response)||!response.orderId)throw Error('ORDER_RESULT_UNKNOWN');return {state:'succeeded' as const,orderId:response.orderId,idempotencyKey:key};
}
function assertScreenshotMessageAdmin(ctx:Context){if(!ctx.user)throw new TRPCError({code:'UNAUTHORIZED',message:'Bitte anmelden'});if(ctx.user.role!=='admin')throw new TRPCError({code:'FORBIDDEN',message:'Keine Berechtigung'});}
function savedConfirmationBody(saved:any):string|null{return saved.screenshotConfirmation?.version===1&&typeof saved.screenshotConfirmation.body==='string'&&saved.screenshotConfirmation.body.trim()&&typeof saved.screenshotConfirmation.preparedAt==='string'?saved.screenshotConfirmation.body:null;}
async function readScreenshotOrderResult(draftId:string,ctx:Context,renderMissing=false){
  assertScreenshotMessageAdmin(ctx);
  const saved=await receipt(draftId,ctx.user!.id);if(!saved)throw new TRPCError({code:'NOT_FOUND',message:'ORDER_NOT_FOUND'});
  const base={state:'succeeded' as const,orderId:saved.orderId,idempotencyKey:screenshotIntentKey(ctx.user!.id,draftId),order:saved.orderSnapshot as Record<string,unknown>,paymentInstructions:saved.paymentInstructions as Record<string,unknown>|null};
  let recipient:string|null=null;try{
    const effective=await orderRouter.createCaller(ctx).getCommunicationPhone({orderId:saved.orderId});recipient=normalizeOrderCommunicationPhone(effective.effectivePhone);
    if(!recipient)throw Error('RECIPIENT_UNAVAILABLE');
    if(!saved.paymentInstructions?.accounts?.length)throw Error('WISE_CONFIGURATION_UNAVAILABLE');
    const rendered=await withReadOnlyDatabase(async()=>{
      const db=await getDb();if(!db)throw Error('DATABASE_UNAVAILABLE');
      const persisted=await readPersistedOrderMessageData(db,saved.orderId);
      const snapshot={...persisted.orderSnapshot,customer:persisted.emailData.customer,customerId:persisted.order.customerId,paymentMethod:persisted.order.paymentMethod};
      if(screenshotHash(snapshot)!==screenshotHash(saved.orderSnapshot))throw Error('ORDER_CHANGED');
      const released=await getReleasedBankTransferInstructions();if(screenshotHash(released)!==screenshotHash(saved.paymentInstructions))throw Error('WISE_CHANGED');
      const profile=(await db.select().from(customers).where(sql`id=${persisted.order.customerId}`))[0];
      if(!profile||profile.firstName!==persisted.order.firstName||profile.lastName!==persisted.order.lastName||profile.name!==`${persisted.order.firstName} ${persisted.order.lastName}`.trim())throw Error('CUSTOMER_MESSAGE_NAME_CHANGED');
      const cached=savedConfirmationBody(saved);if(cached)return {whatsappBody:cached};
      if(!renderMissing||Object.hasOwn(saved,'screenshotConfirmation'))throw Error('ORDER_MESSAGE_NOT_PREPARED');
      const templates=await communicationTemplateRouter.createCaller(ctx).list({channel:'whatsapp',language:saved.orderSnapshot?.communicationLanguage==='en'?'en':'de',activeOnly:true});const selected=templates.filter(t=>t.templateKey==='order_confirmation');
    if(selected.length!==1)throw Error('ORDER_TEMPLATE_UNAVAILABLE');
    const composed=await communicationTemplateRouter.createCaller(ctx).render({templateId:selected[0].id,orderId:saved.orderId});
    if(composed.missing.length||!composed.whatsappBody||!selected[0].bodyTemplate.includes('{{paymentDetails}}')||!selected[0].bodyTemplate.includes('{{orderId}}'))throw Error('ORDER_TEMPLATE_INCOMPLETE');return composed;
    });
    return {...base,whatsapp:{state:'ready' as const,recipient,message:rendered.whatsappBody}};
  }catch{return {...base,whatsapp:{state:'pending' as const,recipient,message:null,reason:'COMMUNICATION_REVIEW_REQUIRED'}};}
}
/** Read-only result: never renders or persists a missing confirmation body. */
export async function resultScreenshotOrder(draftId:string,ctx:Context){return readScreenshotOrderResult(draftId,ctx);}
/** Explicit admin mutation; immutable first-ready body, no send or order execution. */
export async function prepareScreenshotOrderMessage(draftId:string,ctx:Context){
  assertScreenshotMessageAdmin(ctx);
  const candidate=await readScreenshotOrderResult(draftId,ctx,true);if(candidate.whatsapp.state!=='ready')return candidate;
  try{
    const db=await getDb();if(!db)throw Error('DATABASE_UNAVAILABLE');
    const confirmation={version:1,body:candidate.whatsapp.message,preparedAt:new Date().toISOString()};
    // JSONB field CAS scopes one receipt to actor+draft+order and preserves all other fields.
    // A concurrent winner is authoritative; the final read never returns our losing render.
    await db.execute(sql`UPDATE priority_checkout_receipts SET response=jsonb_set(response,'{screenshotConfirmation}',${JSON.stringify(confirmation)}::jsonb)
      WHERE intent_key=${screenshotIntentKey(ctx.user!.id,draftId)} AND order_id=${candidate.orderId}
      AND response->>'orderId'=${candidate.orderId} AND response->>'screenshotActorId'=${String(ctx.user!.id)} AND response->>'screenshotDraftId'=${draftId}
      AND response->'orderSnapshot'=${JSON.stringify(candidate.order)}::jsonb AND response->'paymentInstructions'=${JSON.stringify(candidate.paymentInstructions)}::jsonb
      AND NOT (response ? 'screenshotConfirmation') RETURNING response`);
    return await resultScreenshotOrder(draftId,ctx);
  }catch{return {...candidate,whatsapp:{state:'pending' as const,recipient:candidate.whatsapp.recipient,message:null,reason:'COMMUNICATION_REVIEW_REQUIRED'}};}
}
export function screenshotSafeError(error:unknown):never{
  if(error instanceof TRPCError&&['UNAUTHORIZED','FORBIDDEN','NOT_FOUND'].includes(error.code))throw error;
  const message=error instanceof Error?error.message:'';
  const messages:Record<string,string>={
    QUOTE_INVALID:'Die Vorschau ist ungültig. Bitte erneut prüfen und eine neue Vorschau erstellen.',
    QUOTE_EXPIRED:'Die Vorschau ist abgelaufen. Bitte erneut prüfen und eine neue Vorschau erstellen.',
    QUOTE_REPLACED:'Die Vorschau wurde ersetzt. Bitte die aktuelle Vorschau erneut prüfen.',
    QUOTE_EXPIRED_OR_REPLACED:'Die Vorschau ist abgelaufen oder wurde ersetzt. Bitte eine neue Vorschau erstellen.',
    QUOTE_CHANGED:'Die Bestelldaten wurden geändert. Bitte erneut prüfen und eine neue Vorschau erstellen.',
    QUOTE_UNAVAILABLE:'Die sichere Vorschau ist derzeit nicht verfügbar. Bitte den normalen WaWi-Bestellweg verwenden.',
    QUOTE_CAPACITY:'Derzeit können keine weiteren Vorschauen erstellt werden. Bitte kurz warten und erneut prüfen.',
    ACTOR_REVOKED:'Die Administratorfreigabe ist nicht mehr gültig. Bitte die Berechtigung prüfen.',
    CUSTOMER_CONTACT_CONFLICT:'Telefon und E-Mail sind nicht eindeutig. Bitte doppelte oder widersprüchliche Kundenkontakte zuerst in der WaWi prüfen.',
    CUSTOMER_PROFILE_REQUIRES_REVIEW:'Das ausgewählte Kundenprofil ist unvollständig. Bitte Namen und Kontakt im Kundenprofil prüfen.',
    CUSTOMER_PHONE_INVALID:'Bitte eine gültige internationale Telefonnummer oder deutsche Mobilnummer eingeben.',
    CUSTOMER_ORDER_BLOCKED:'Für diesen Kunden sind neue Bestellungen gesperrt. Bitte die Kundensperre in der WaWi prüfen.',
    CUSTOMER_NOT_FOUND:'Das ausgewählte Kundenprofil ist nicht mehr vorhanden. Bitte neu auswählen.',
    STOCK_UNAVAILABLE:'Der Bestand reicht nicht für diese Menge. Bitte Menge oder Artikel prüfen.',
    EXACT_PUBLISHED_SKU_REQUIRED:'Bitte einen eindeutigen, aktiven und veröffentlichten Lagerartikel auswählen.',
    COMPONENT_FORM_REQUIRES_WAWI:'Diese Produktform benötigt den normalen manuellen WaWi-Bestellweg. Bitte dort bestellen; andere Artikel sind hier weiterhin möglich.',
    EXCLUSIVE_CAMPAIGN_DISCOUNT_FORBIDDEN:'Die aktive exklusive Aktion erlaubt keine zusätzlichen Codes oder manuellen Rabatte.',
    PROMOTION_INVALID:'Der Aktionscode ist ungültig, abgelaufen oder für diesen Warenwert nicht verfügbar.',
    PROMOTION_REQUIRES_NATIVE_ELIGIBILITY:'Dieser personenbezogene, Partner- oder Neukundencode muss im normalen WaWi-Bestellweg geprüft werden.',
    ADDRESS_WARNING_CONFIRMATION_REQUIRED:'Bitte den Adresshinweis prüfen und ausdrücklich bestätigen.',
    SCREENSHOT_SECRET_REQUIRED:'Die sichere Bestellfreigabe ist serverseitig noch nicht konfiguriert. Der normale WaWi-Bestellweg bleibt verfügbar.',
  };
  // Never classify an unknown QUOTE_/CUSTOMER_/PROMOTION_ prefix as pre-write:
  // an unfamiliar error may originate from a post-commit task or result rendering.
  const addressPrefix='ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH: ';
  const addressWarning=message.startsWith(addressPrefix)?message.slice(addressPrefix.length).slice(0,1200):null;
  const safe=Object.hasOwn(messages,message)?message:addressWarning!==null?'ADDRESS_WARNING_CONFIRMATION_REQUIRED':null;
  const dbCode=(error as any)?.cause?.cause?.code??(error as any)?.cause?.code??(error as any)?.code;
  // Only known pre-write validation errors (or database-aborted transactions) are
  // definitive rejections. Unknown failures may have happened after a commit.
  if (safe) throw new TRPCError({code:'PRECONDITION_FAILED',message:`${safe}: ${addressWarning?`Adressprüfung: ${addressWarning}`:messages[safe]}`});
  if (['55P03','40P01','40001'].includes(dbCode)) throw new TRPCError({code:'PRECONDITION_FAILED',message:'TRANSACTION_REJECTED: Kunde oder Artikel wird gerade bearbeitet. Bitte kurz warten und die Vorschau erneut prüfen.'});
  throw new TRPCError({code:'INTERNAL_SERVER_ERROR',message:'BOOKING_OUTCOME_UNKNOWN: Das Buchungsergebnis ist nicht eindeutig bestätigt. Bitte ausschließlich den Status der ursprünglichen Bestellung prüfen.'});
}
