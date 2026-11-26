import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { canonicalRecipientFromCustomer, assertRecipientOrderEditable, type RecipientAddress } from './orderRecipientCorrectionService.js';

export type ShippingSyncActor = { id: number | null; username: string };
export type ShippingSyncResult = { updatedOrderIds: string[]; skippedOrderIds: string[] };
type QueryClient = Pick<PoolClient, 'query'>;
const fields = ['firstName','lastName','company','street','houseNumber','zip','city','country','deliveryType','dhlPostNumber'] as const;
export function persistedOrderRecipient(row: Record<string, any>): RecipientAddress {
  return { firstName:row.first_name??'',lastName:row.last_name??'',company:row.company??null,
    street:row.street??'',houseNumber:row.house_number??'',zip:row.zip??'',city:row.city??'',country:row.country??'',
    deliveryType:row.delivery_type,dhlPostNumber:row.dhl_post_number??null };
}
/** Shares the caller's customer-save transaction. No financial, carrier or message operations. */
export async function syncCustomerShippingWithClient(client: QueryClient, customer: Record<string, any>, actor: ShippingSyncActor, onlyOrderId?:string): Promise<ShippingSyncResult> {
  const customerId = Number(customer.id);
  if (!Number.isSafeInteger(customerId) || customerId<=0) throw Error('CUSTOMER_SHIPPING_IDENTITY_REQUIRED');
  const candidates=(await client.query("SELECT * FROM orders WHERE customer_id=$1 AND status IN ('offen','bezahlt','gepackt')"
    +(onlyOrderId?' AND order_id=$2':'')+" ORDER BY order_id FOR UPDATE",onlyOrderId?[customerId,onlyOrderId]:[customerId])).rows;
  const result:ShippingSyncResult={updatedOrderIds:[],skippedOrderIds:[]};
  const editable:Record<string,any>[]=[];
  for (const order of candidates) {
    try { await assertRecipientOrderEditable(client,order); editable.push(order); }
    catch(error) {
      if ((error as any)?.code!=='CONFLICT') throw error;
      result.skippedOrderIds.push(order.order_id);
    }
  }
  if (!editable.length) return result;
  const after=canonicalRecipientFromCustomer(customer);
  for (const order of editable) {
    const before=persistedOrderRecipient(order);
    if (fields.every(key=>before[key]===after[key])) continue;
    await client.query(`UPDATE orders SET first_name=$2,last_name=$3,company=$4,street=$5,house_number=$6,
      zip=$7,city=$8,country=$9,delivery_type=$10,dhl_post_number=$11,updated_at=NOW() WHERE order_id=$1`,
      [order.order_id,after.firstName,after.lastName,after.company,after.street,after.houseNumber,after.zip,after.city,after.country,after.deliveryType,after.dhlPostNumber]);
    const auditId=createHash('sha256').update(JSON.stringify({scope:'crm-shipping-autosync-v1',orderId:order.order_id,
      customerId,actor:actor.username,version:customer.updated_at??customer.updatedAt??null,before,after})).digest('hex');
    await client.query(`INSERT INTO order_recipient_corrections(id,order_id,customer_id,actor_id,actor_name,before_snapshot,after_snapshot)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(id) DO NOTHING`,
      [auditId,order.order_id,customerId,actor.id,actor.username,JSON.stringify(before),JSON.stringify(after)]);
    result.updatedOrderIds.push(order.order_id);
  }
  return result;
}
/** Adapt the existing Drizzle transaction to the same audited PG service, without another connection. */
export async function syncCustomerShippingAddressesInTransaction(tx:any,customer:Record<string,any>,actor:ShippingSyncActor):Promise<ShippingSyncResult> {
  const client={query:async(text:string,values:unknown[]=[])=>{
    const pieces=text.split(/(\$\d+)/g).filter(Boolean).map(piece=>/^\$\d+$/.test(piece)
      ? sql`${values[Number(piece.slice(1))-1]}` : sql.raw(piece));
    const response=await tx.execute(sql.join(pieces,sql.raw('')));
    return {rows:Array.isArray(response)?response:response.rows??[],rowCount:response.rowCount??null};
  }} as unknown as QueryClient;
  return syncCustomerShippingWithClient(client,customer,actor);
}
