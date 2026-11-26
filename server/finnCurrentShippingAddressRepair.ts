import { createHash } from 'node:crypto';
import { getPool } from './db.js';
import { syncCustomerShippingWithClient, persistedOrderRecipient } from './customerShippingAutoSyncService.js';

/** Owner-requested current CRM address, not the obsolete fixed PLZ from the earlier repair. */
export async function repairFinnCurrentShippingAddress():Promise<void> {
  const pool=await getPool();
  if (!pool) throw Error('finn_shipping_database_unavailable');
  const client=await pool.connect();
  const receiptId=createHash('sha256').update('owner:20261126:finn:369-11384:current-crm-shipping-v2').digest('hex');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2000ms'");
    await client.query("SET LOCAL statement_timeout='5000ms'");
    const customer=(await client.query('SELECT * FROM customers WHERE id=44 FOR UPDATE')).rows[0];
    const order=(await client.query("SELECT * FROM orders WHERE order_id='369-11384' FOR UPDATE")).rows[0];
    if (!order) { await client.query('COMMIT'); return; }
    if ((await client.query('SELECT 1 FROM order_recipient_corrections WHERE id=$1',[receiptId])).rows.length) {
      await client.query('COMMIT'); return;
    }
    if (!customer || customer.name!=='Finn-Ole Kummer' || order.customer_id!==44
      || order.first_name!=='Finn-Ole' || order.last_name!=='Kummer') throw Error('finn_current_shipping_identity_mismatch');
    const result=await syncCustomerShippingWithClient(client,customer,{id:null,username:'Owner Pakko 2026-11-26: CRM address is shipping address'},order.order_id);
    if (result.skippedOrderIds.length || !['offen','bezahlt','gepackt'].includes(order.status)) {
      await client.query('COMMIT');
      console.info('[CRM Shipping] Finn current-address repair skipped: existing shipping evidence.');
      return;
    }
    const after=(await client.query('SELECT * FROM orders WHERE order_id=$1',[order.order_id])).rows[0];
    await client.query(`INSERT INTO order_recipient_corrections(id,order_id,customer_id,actor_id,actor_name,before_snapshot,after_snapshot)
      VALUES($1,$2,44,NULL,$3,$4::jsonb,$5::jsonb)`,[receiptId,order.order_id,
      'Owner Pakko 2026-11-26: one-time current CRM shipping reconciliation',JSON.stringify(persistedOrderRecipient(order)),JSON.stringify(persistedOrderRecipient(after))]);
    await client.query('COMMIT');
    console.info('[CRM Shipping] Finn order 369-11384 reconciled with the current customer record.');
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { client.release(); }
}
