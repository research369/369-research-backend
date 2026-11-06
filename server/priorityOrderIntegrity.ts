import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { getPool } from './db.js';
let ready = false;
export const isPriorityOrderIntegrityReady = () => ready;
export async function ensurePriorityOrderIntegritySchema() {
  ready = false;
  const pool = await getPool();
  if (!pool) throw Error('ORDER_INTEGRITY_DATABASE_UNAVAILABLE');
  await pool.query(await readFile(new URL('../drizzle/migrations/priority_0032_order_integrity.sql', import.meta.url), 'utf8'));
  ready = true;
}
export function canonicalIntent(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalIntent).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalIntent(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
/** Bind parsed request BEFORE repricing/mutation; only transport-generated references excluded. */
export function checkoutFingerprint(input: any) {
  // Renewed auth/confirmation credentials do not constitute a second purchase.
  // All business/contact/credit fields remain bound; first execution still authenticates.
  const { checkoutIdempotencyKey, orderId, date, customerDataChangeConfirmationToken, kwkCreditToken, ...intent } = input;
  return createHash('sha256').update(canonicalIntent(intent)).digest('hex');
}
export const resultRows = (r: any): any[] => Array.isArray(r) ? r : r?.rows ?? [];
export async function readCheckoutReceipt(db: any, key: string, fingerprint: string) {
  const [receipt] = resultRows(await db.execute(sql`SELECT payload_fingerprint, response FROM priority_checkout_receipts WHERE intent_key=${key}`));
  if (!receipt) return null;
  if (receipt.payload_fingerprint !== fingerprint) throw new TRPCError({ code: 'CONFLICT', message: 'CHECKOUT_INTENT_CONFLICT' });
  return receipt.response;
}
export async function lockCheckoutIntent(tx: any, key: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`369-checkout:${key}`},0))`);
}
export async function persistCheckoutReceipt(tx: any, key: string, fingerprint: string, response: any) {
  await tx.execute(sql`INSERT INTO priority_checkout_receipts(intent_key,payload_fingerprint,order_id,response) VALUES(${key},${fingerprint},${response.orderId},${JSON.stringify(response)}::jsonb)`);
}
export async function queueOrderTask(tx: any, orderId: string, task: string) {
  await tx.execute(sql`INSERT INTO priority_order_tasks(order_id,task) VALUES(${orderId},${task}) ON CONFLICT DO NOTHING`);
}
/** Durable one-attempt claim. Unknown/running mail is NEVER automatically released or retried. */
export async function runOrderTask(db: any, orderId: string, task: string, work: () => Promise<any>, communication = false) {
  try {
    const claim = resultRows(await db.execute(sql`UPDATE priority_order_tasks SET state='running',updated_at=now() WHERE order_id=${orderId} AND task=${task} AND state='pending' RETURNING task`));
    if (!claim.length) return null;
    try {
      const value = await work();
      if (task === 'payment_instructions') {
        await db.execute(sql`UPDATE priority_checkout_receipts SET response=jsonb_set(response,'{paymentInstructions}',${JSON.stringify(value ?? null)}::jsonb) WHERE order_id=${orderId}`);
      }
      await db.execute(sql`UPDATE priority_order_tasks SET state='done',updated_at=now() WHERE order_id=${orderId} AND task=${task}`);
      return value;
    } catch {
      await db.execute(sql`UPDATE priority_order_tasks SET state=${communication ? 'unknown' : 'repair_required'},updated_at=now() WHERE order_id=${orderId} AND task=${task}`);
      return null;
    }
  } catch {
    // The pending/running task remains the durable obligation; committed order is success.
    return null;
  }
}

/** One bounded list query, no credentials/payloads and never a background execution. */
export async function getOrderIntegrityIssues(db: any, orderIds: string[]) {
  const result = new Map<string, Array<{ task: string; state: string }>>();
  if (!orderIds.length) return result;
  const entries = resultRows(await db.execute(sql`SELECT order_id,task,state FROM priority_order_tasks WHERE order_id IN (${sql.join(orderIds.map(id => sql`${id}`),sql`,`)}) AND state <> 'done' ORDER BY order_id,task`));
  for (const entry of entries) {
    const issues = result.get(entry.order_id) ?? [];
    issues.push({ task: entry.task, state: entry.state });
    result.set(entry.order_id, issues);
  }
  return result;
}
