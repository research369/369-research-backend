import { and, eq, inArray, sql } from 'drizzle-orm';
import { articles, orders, orderItems, stockHistory } from '../drizzle/schema.js';
import { applyStockMovement } from './stockMovementService.js';
import { resultRows } from './priorityOrderIntegrity.js';
export async function lockOrder(tx: any, orderId: string) {
  const [order] = await tx.select().from(orders).where(eq(orders.orderId, orderId)).for('update');
  if (!order) throw Error('ORDER_NOT_FOUND');
  return order;
}
export function assertUnshipped(order: any) {
  if (order.shippedAt || order.deliveredAt || ['versendet','zugestellt','abgeholt'].includes(order.status)) throw Error('ORDER_RETURN_MANUAL_REVIEW_REQUIRED');
}
export async function assertOrderFinanciallyEditable(tx: any, order: any) {
  assertUnshipped(order);
  if (order.paidAt || order.bunqPaymentId || order.bunqMatchedAt || !['offen','storniert'].includes(order.status)
    || order.partnerSourceId || order.partnerCode || order.partnerNumber || Number(order.creditUsed) > 0 || Number(order.kwkCreditUsed) > 0 || Number(order.kwkCreditRequested) > 0 || Number(order.partnerCommission) > 0)
    throw Error('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED');
  const [links] = resultRows(await tx.execute(sql`SELECT
    EXISTS(SELECT 1 FROM partner_transactions WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM kwk_ledger WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM kwk_referrals WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM invoices WHERE order_number=${order.orderId}) AS linked`));
  if (links?.linked) throw Error('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED');
}
/** Caller already owns order row lock. Never use order item names or requested variant. */
export async function returnOrderStock(tx: any, order: any, reason: string, actor: string) {
  assertUnshipped(order);
  if (!['offen','bezahlt','gepackt','storniert'].includes(order.status)) throw Error('ORDER_NOT_CANCELLABLE');
  const [goodie] = resultRows(await tx.execute(sql`SELECT id FROM goodie_assignments WHERE order_id=${order.orderId} LIMIT 1`));
  if (goodie) throw Error('ORDER_GOODIE_RETURN_REVIEW_REQUIRED');
  const history = await tx.select().from(stockHistory).where(eq(stockHistory.orderId, order.orderId)).orderBy(stockHistory.articleId, stockHistory.id).for('update');
  const originals = history.filter((h: any) => h.quantityChange < 0 && h.changeType === 'verkauf');
  const mapped = resultRows(await tx.execute(sql`SELECT original_movement_id,return_movement_id FROM priority_stock_returns WHERE order_id=${order.orderId}`));
  const done = new Set(mapped.map((r: any) => r.original_movement_id));
  const returned = new Set(mapped.map((r: any) => r.return_movement_id));
  // Positive historical returns/corrections are NOT sale evidence and cannot be double-returned.
  if (history.some((h: any) => h.quantityChange > 0 && ['retoure','korrektur'].includes(h.changeType) && !returned.has(h.id))) throw Error('ORDER_STOCK_HISTORY_REVIEW_REQUIRED');
  if (!originals.length) {
    const items = await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, order.orderId));
    if (items.length) throw Error('ORDER_STOCK_HISTORY_REVIEW_REQUIRED');
    return 0;
  }
  const remaining = originals.filter((h: any) => !done.has(h.id));
  const ids: number[] = [...new Set<number>(remaining.map((h: any) => h.articleId))].sort((a,b) => a-b);
  const locked = ids.length ? await tx.select().from(articles).where(inArray(articles.id, ids)).orderBy(articles.id).for('update') : [];
  const catalog = new Map<number, any>(locked.map((a: any) => [a.id,a]));
  let units = 0;
  for (const h of remaining) {
    const a = catalog.get(h.articleId);
    if (!a || !Number.isSafeInteger(h.quantityChange) || h.quantityAfter - h.quantityBefore !== h.quantityChange) throw Error('ORDER_STOCK_HISTORY_REVIEW_REQUIRED');
    const movement = await applyStockMovement(tx, { articleId:a.id,sku:a.sku,expectedStock:a.stock,change:-h.quantityChange,type:'retoure',reason:`Original movement ${h.id}: ${reason}`,orderId:order.orderId,actor });
    await tx.execute(sql`INSERT INTO priority_stock_returns(original_movement_id,return_movement_id,order_id,reason,actor) VALUES(${h.id},${movement.movementId},${order.orderId},${reason},${actor})`);
    a.stock = movement.after;
    units -= h.quantityChange;
  }
  return units;
}
export async function recordOrderAction(tx: any, orderId: string, action: string, reason: string, actor: string, units = 0) {
  await tx.execute(sql`INSERT INTO priority_order_actions(order_id,action,reason,actor,stock_units) VALUES(${orderId},${action},${reason},${actor},${units}) ON CONFLICT DO NOTHING`);
}
export async function deleteOrderAtomically(db: any, orderId: string, restock: boolean, actor: string) {
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`order-delete:${orderId}`},0))`);
    const [prior] = resultRows(await tx.execute(sql`SELECT action,stock_units FROM priority_order_actions WHERE order_id=${orderId} AND action IN ('delete','delete_no_restock')`));
    if (prior) {
      if (prior.action !== (restock ? 'delete' : 'delete_no_restock')) throw Error('ORDER_DELETE_INTENT_CONFLICT');
      return { success:true, restoredStock:prior.stock_units, alreadyDeleted:true };
    }
    const order = await lockOrder(tx, orderId);
    await assertOrderFinanciallyEditable(tx, order);
    // Issued labels preserve shipping audit and require separate deliberate cancellation.
    if (order.shippingLabelUrl || order.trackingNumber) throw Error('ORDER_SHIPPING_REVIEW_REQUIRED');
    const units = restock ? await returnOrderStock(tx,order,'Explicit order deletion',actor) : 0;
    await recordOrderAction(tx,orderId,restock ? 'delete' : 'delete_no_restock','Explicit order deletion',actor,units);
    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await tx.delete(orders).where(eq(orders.orderId, orderId));
    return { success:true, restoredStock:units };
  });
}
