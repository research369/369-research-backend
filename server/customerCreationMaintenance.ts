import {TRPCError} from '@trpc/server';
const affected=new Set(['order.create','customer.create','customer.backfillFromOrders']);
export function creationPaused(path:string,type:string,value:string|null|undefined){return type==='mutation'&&affected.has(path)&&value==='paused';}
/** Dedicated short-lived rollout switch. Reads no customer data and changes no fulfilment routes. */
export async function checkCustomerCreationMaintenance(path:string,type:string,pool:{query:(sql:string)=>Promise<{rows:any[]}>}|null){
 if(type!=='mutation'||!affected.has(path))return;
 if(!pool)throw new TRPCError({code:'SERVICE_UNAVAILABLE',message:'Kundenanlage vorübergehend nicht verfügbar. Bitte später erneut versuchen.'});
 let value;
 try{value=(await pool.query("SELECT value FROM shop_settings WHERE key='customer_number_migration_pause' LIMIT 1")).rows[0]?.value;}catch{throw new TRPCError({code:'SERVICE_UNAVAILABLE',message:'Kundenanlage vorübergehend nicht verfügbar. Bitte später erneut versuchen.'});}
 if(creationPaused(path,type,value))throw new TRPCError({code:'SERVICE_UNAVAILABLE',message:'Kurze technische Wartung: Neue Bestellungen und Kundenanlagen sind vorübergehend pausiert. Bitte gleich erneut versuchen.'});
}
