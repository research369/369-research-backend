import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getPool } from './db.js';
import { canonicalRecipientFromCustomer, assertRecipientOrderEditable } from './orderRecipientCorrectionService.js';

let ready = false;
export const isOrderRecipientCorrectionSchemaReady = () => ready;
export async function ensureOrderRecipientCorrectionSchema(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw Error('recipient_correction_database_unavailable');
  await pool.query(readFileSync(new URL('../drizzle/migrations/0039_order_recipient_corrections.sql', import.meta.url), 'utf8'));
  ready = true;
}

/** Explicit owner-authorized startup correction; never run by a read API or CRM save. */
export async function repairFinnPickupOrder(): Promise<void> {
  const pool = await getPool();
  if (!pool || !ready) throw Error('recipient_correction_schema_unavailable');
  const client = await pool.connect();
  const id = createHash('sha256').update('owner:20261126:finn:369-11384:pickup-v1').digest('hex');
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2000ms'");
    await client.query("SET LOCAL statement_timeout='5000ms'");
    const result = await client.query("SELECT * FROM orders WHERE order_id='369-11384' FOR UPDATE");
    const order = result.rows[0];
    if (!order) { await client.query('COMMIT'); return; }
    if ((await client.query('SELECT 1 FROM order_recipient_corrections WHERE id=$1', [id])).rows.length) {
      await client.query('COMMIT'); return;
    }
    if (order.customer_id !== 44 || order.first_name !== 'Finn-Ole' || order.last_name !== 'Kummer'
      || order.street !== 'Packstation' || order.house_number !== '172' || order.zip !== '18528'
      || order.city !== 'Bergen auf Rügen' || order.country !== 'DE'
      || (order.dhl_post_number && order.dhl_post_number !== '1116683275')) throw Error('finn_recipient_identity_mismatch');
    await assertRecipientOrderEditable(client, order);
    const customerResult = await client.query('SELECT * FROM customers WHERE id=44 FOR UPDATE');
    const customer = customerResult.rows[0];
    if (!customer || customer.name !== 'Finn-Ole Kummer' || customer.dhl_post_number !== '1116683275') throw Error('finn_customer_identity_mismatch');
    const after = canonicalRecipientFromCustomer(customer);
    if (after.deliveryType !== 'packstation' || after.street !== 'Packstation' || after.houseNumber !== '172'
      || after.zip !== '18528' || after.city !== 'Bergen auf Rügen' || after.country !== 'DE') throw Error('finn_customer_address_changed');
    const before = { firstName: order.first_name, lastName: order.last_name, company: order.company,
      street: order.street, houseNumber: order.house_number, zip: order.zip, city: order.city,
      country: order.country, deliveryType: order.delivery_type, dhlPostNumber: order.dhl_post_number };
    // Only the missing pickup data changes; stored recipient name/address and every commercial field stay intact.
    await client.query("UPDATE orders SET delivery_type='packstation',dhl_post_number=$1,updated_at=NOW() WHERE order_id=$2", [after.dhlPostNumber, order.order_id]);
    await client.query(`INSERT INTO order_recipient_corrections(id,order_id,customer_id,actor_id,actor_name,before_snapshot,after_snapshot)
      VALUES($1,$2,44,NULL,$3,$4::jsonb,$5::jsonb)`, [id, order.order_id,
      'Owner Pakko authorization 2026-11-26; targeted missing DHL pickup fields', JSON.stringify(before),
      JSON.stringify({ ...before, deliveryType: 'packstation', dhlPostNumber: after.dhlPostNumber })]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
