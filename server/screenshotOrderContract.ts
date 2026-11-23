import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalIntent } from './priorityOrderIntegrity.js';

const text = (max: number) => z.string().trim().min(1).max(max);
export const screenshotCustomerSchema = z.object({
  firstName: text(200), lastName: text(200), email: z.string().trim().email().max(320).optional().or(z.literal('')),
  phone: text(50), street: text(300), houseNumber: text(100), zip: text(30), city: text(100), country: text(100),
  company: z.string().trim().max(200).optional(), deliveryType: z.enum(['home','packstation','postfiliale']),
  dhlPostNumber: z.string().trim().regex(/^\d{6,12}$/).optional(),
}).strict().superRefine((v,c) => {
  if (v.deliveryType !== 'home' && (!v.dhlPostNumber || !/^(DE|Deutschland|Germany)$/i.test(v.country)))
    c.addIssue({code:'custom',message:'DHL_POSTNUMBER_REQUIRED'});
});
export const screenshotDiscountSchema = z.discriminatedUnion('mode', [
  z.object({mode:z.literal('none')}).strict(),
  z.object({mode:z.literal('code'),code:text(50)}).strict(),
  z.object({mode:z.literal('percent'),value:z.number().finite().min(0).max(100)}).strict(),
  z.object({mode:z.literal('amount'),value:z.number().finite().min(0).max(1000000).refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7,'CENT_AMOUNT_REQUIRED')}).strict(),
]);
export const screenshotQuoteInputSchema = z.object({
  draftId:z.string().uuid(), existingCustomerId:z.number().int().positive().optional(), existingCustomerReviewed:z.boolean().optional(),
  customer:screenshotCustomerSchema,
  items:z.array(z.object({sku:text(50),quantity:z.number().int().min(1).max(100)}).strict()).min(1).max(30),
  discount:screenshotDiscountSchema, coldShippingRequested:z.boolean().optional(), internalNote:z.string().trim().max(1000).optional(),
  customerConfirmed:z.literal(true), addressWarningConfirmed:z.boolean().optional(),
}).strict().superRefine((v,c)=>{
  if(new Set(v.items.map(i=>i.sku.toLowerCase())).size!==v.items.length)c.addIssue({code:'custom',message:'DUPLICATE_SKU'});
  if(v.existingCustomerId && v.existingCustomerReviewed!==true)c.addIssue({code:'custom',message:'CUSTOMER_REVIEW_REQUIRED'});
});
export const screenshotCustomersInputSchema=z.object({phone:z.string().trim().max(50).optional(),email:z.string().trim().max(320).optional(),name:z.string().trim().max(200).optional()}).strict().refine(v=>Boolean(v.phone||v.email||v.name),'CONTACT_OR_NAME_REQUIRED');
export const screenshotCatalogInputSchema=z.object({query:z.string().trim().max(200).optional(),strength:z.string().trim().max(50).optional(),form:z.enum(['vial','plug_play','nasal','other']).optional()}).strict();
export const screenshotDraftInputSchema=z.object({draftId:z.string().uuid()}).strict();
export const screenshotExecuteInputSchema=z.object({quoteToken:z.string().min(80).max(65536),confirmed:z.literal(true)}).strict();
export type ScreenshotQuoteInput=z.infer<typeof screenshotQuoteInputSchema>;
export type ScreenshotForm='vial'|'plug_play'|'nasal'|'other';
export interface ScreenshotQuoteEnvelope { version:1; actorId:number; draftId:string; expiresAt:number; revision:string; canonicalInput:any; expectedHash:string; sourceHash:string }
export const screenshotHash=(value:unknown)=>createHash('sha256').update(canonicalIntent(JSON.parse(JSON.stringify(value)))).digest('hex');
export const screenshotIntentKey=(actorId:number,draftId:string)=>screenshotHash({scope:'screenshot-order-v1',actorId,draftId});
function secret(){const s=process.env.JWT_SECRET;if(!s||Buffer.byteLength(s)<32||/^(dev|development|changeme|secret)$|dev-secret|fallback/i.test(s))throw Error('SCREENSHOT_SECRET_REQUIRED');return s;}
export function signScreenshotQuote(envelope:ScreenshotQuoteEnvelope){const payload=Buffer.from(JSON.stringify(envelope)).toString('base64url');return payload+'.'+createHmac('sha256',secret()).update('screenshot-order-v1.'+payload).digest('base64url');}
export function verifyScreenshotQuote(token:string,actorId:number,now=Date.now(),allowExpired=false):ScreenshotQuoteEnvelope{
  const [payload,signature,extra]=token.split('.');if(extra||!payload||!signature)throw Error('QUOTE_INVALID');
  const expected=createHmac('sha256',secret()).update('screenshot-order-v1.'+payload).digest();const actual=Buffer.from(signature,'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('QUOTE_INVALID');
  let e:ScreenshotQuoteEnvelope;try{e=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{throw Error('QUOTE_INVALID');}
  if(e.version!==1||e.actorId!==actorId||!z.string().uuid().safeParse(e.draftId).success||!Number.isSafeInteger(e.expiresAt)||e.expiresAt>now+600000||!e.canonicalInput||!e.sourceHash||!e.expectedHash)throw Error('QUOTE_INVALID');
  if(!allowExpired&&e.expiresAt<=now)throw Error('QUOTE_EXPIRED');return e;
}
/** Server-only; never accepted from request input. Preview cannot disable normal checkout receipts. */
export type ScreenshotOrderContext={mode:'preview'}|{mode:'execute';actorId:number;draftId:string;expectedHash:string;validateInTransaction:(tx:any)=>Promise<void>};
