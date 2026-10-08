import {createHash} from 'node:crypto';
import {z} from 'zod';
export const jarvyOrderRequest=z.object({
 customerId:z.number().int().positive(),
 items:z.array(z.object({sku:z.string().trim().min(1).max(50),quantity:z.number().int().min(1).max(100)}).strict()).min(1).max(30),
 paymentMethod:z.enum(['SEPA','Bar','PayPal','Sonstige']),
 internalNote:z.string().trim().max(1000).default(''),
 sendOrderConfirmation:z.boolean().default(false),
}).strict().refine(v=>new Set(v.items.map(i=>i.sku.toLowerCase())).size===v.items.length,'Duplicate SKU');
export function canonical(value:any):string{return JSON.stringify(value===null||typeof value!=='object'?value:Array.isArray(value)?value.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,JSON.parse(canonical(value[k]))])));}
export const orderHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
/** Internal context only. Never deserialize this from a browser/tRPC request. */
export type JarvyOrderContext={mode:'preview'}|{mode:'execute';expectedHash:string;receiptId:string};
