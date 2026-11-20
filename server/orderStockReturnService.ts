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
  if (order.paidAt || order.bunqPaymentId || order.bunqMatchedAt || !['offen','storniert'].includes(order.status))
    throw Error('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED');
  const [links] = resultRows(await tx.execute(sql`SELECT
    EXISTS(SELECT 1 FROM partner_transactions WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM kwk_ledger WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM kwk_referrals WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM invoices WHERE order_number=${order.orderId} OR order_number=${order.externalOrderReference ?? null}) AS linked`));
  if (links?.linked) throw Error('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED');
  // Used credit is normally debited during checkout, not at payment. Missing
  // ledger evidence with a positive used header is a repair case, not permission.
  if (![order.creditUsed,order.kwkCreditUsed,order.kwkCreditRequested].every(v => Number.isFinite(Number(v ?? 0)) && Number(v ?? 0) >= 0)
    || Number(order.creditUsed) > 0 || Number(order.kwkCreditUsed) > 0) throw Error('ORDER_CREDIT_INTENT_EDIT_REVIEW_REQUIRED');
}
/** Caller owns the row lock. Metadata/discount/credit intent is NOT a booking.
 * The EDIT guard separately checks credit consistency. Never delete booked evidence,
 * even when entries were subsequently reversed or an order was cancelled.
 */
export async function assertOrderDeletable(tx: any, order: any) {
  assertUnshipped(order);
  const zeroPaidMarker = order.status === 'bezahlt' && !!order.paidAt && Number(order.total) === 0
    && !order.cancelledAt && !order.partnerSourceId && !order.partnerCodeIdSnapshot && !order.partnerCode && !order.partnerNumber
    && [order.creditUsed,order.kwkCreditUsed,order.kwkCreditRequested,order.partnerCommission,order.partnerDiscount].every(v => Number(v ?? 0) === 0);
  if (order.bunqPaymentId || order.bunqMatchedAt || order.packedAt || ((!zeroPaidMarker) && (order.paidAt || !['offen','storniert'].includes(order.status))))
    throw Error('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED');
  if (zeroPaidMarker && (order.packingPhotoAt || order.packingPhotoUrl)) throw Error('ORDER_SHIPPING_REVIEW_REQUIRED');
  if (order.shippingLabelUrl || order.shippingLabelContent || order.trackingNumber)
    throw Error('ORDER_SHIPPING_REVIEW_REQUIRED');
  const [links] = resultRows(await tx.execute(sql`SELECT
    EXISTS(SELECT 1 FROM partner_transactions WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM kwk_ledger WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM kwk_referrals WHERE order_id=${order.orderId}) OR
    EXISTS(SELECT 1 FROM invoices WHERE order_number=${order.orderId} OR order_number=${order.externalOrderReference ?? null}) AS linked`));
  if (links?.linked) throw Error('ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED');
  // Label generations can retain evidence even after a header pointer is cleared.
  // Older installations without the additive archive retain legacy header checks.
  const [archive] = resultRows(await tx.execute(sql`SELECT to_regclass('dhl_label_generations') IS NOT NULL AS present`));
  if (archive?.present) {
    const [label] = resultRows(await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM dhl_label_generations WHERE order_id=${order.orderId} AND state <> 'create_rejected') AS linked`));
    if (label?.linked) throw Error('ORDER_SHIPPING_REVIEW_REQUIRED');
  }
  if (zeroPaidMarker) {
    const [issues] = resultRows(await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM priority_order_tasks WHERE order_id=${order.orderId} AND state <> 'done') AS linked`));
    if (issues?.linked) throw Error('ORDER_INTEGRITY_REVIEW_REQUIRED');
    const [photos] = resultRows(await tx.execute(sql`SELECT to_regclass('packing_photo_history') IS NOT NULL AS present`));
    if (photos?.present) {
      const [photo] = resultRows(await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM packing_photo_history WHERE order_id=${order.orderId}) AS linked`));
      if (photo?.linked) throw Error('ORDER_SHIPPING_REVIEW_REQUIRED');
    }
    const plan = await readOrderReturnPlan(tx,order.orderId);
    if (plan.reasons.length) throw Error(plan.reasons[0]);
    // A genuine zero total, not a stale/wrong header hiding an outstanding amount.
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId,order.orderId));
    if (![order.subtotal,order.discount,order.shipping,order.total,...items.map((i:any)=>i.price)].every(v => Number.isFinite(Number(v)) && Number(v)>=0)
      || items.some((i:any)=>!Number.isSafeInteger(i.quantity) || i.quantity<=0)
      || Math.round(Number(order.subtotal)*100) !== items.reduce((sum:number,i:any)=>sum+Math.round(Number(i.price)*100)*i.quantity,0)
      || Math.round(Number(order.subtotal)*100)-Math.round(Number(order.discount)*100)+Math.round(Number(order.shipping)*100)!==0) throw Error('ORDER_ZERO_TOTAL_REVIEW_REQUIRED');
  }
}
/** Read only: actual journals, never infer inventory from an item name/variant. */
export async function readOrderReturnPlan(tx:any,orderId:string) {
  const history=await tx.select().from(stockHistory).where(eq(stockHistory.orderId,orderId)).orderBy(stockHistory.id);
  const mappings=resultRows(await tx.execute(sql`SELECT original_movement_id,return_movement_id FROM priority_stock_returns WHERE order_id=${orderId}`));
  const returned=new Set(mappings.map(r=>r.original_movement_id));
  const returnIds=new Set(mappings.map(r=>r.return_movement_id));
  const originals=history.filter((h:any)=>h.changeType==='verkauf' && h.quantityChange<0);
  const ids:number[]=[...new Set<number>(originals.map((h:any)=>h.articleId))];
  const catalog=ids.length ? await tx.select({id:articles.id,sku:articles.sku,stock:articles.stock}).from(articles).where(inArray(articles.id,ids)) : [];
  const byId=new Map(catalog.map((a:any)=>[a.id,a]));
  const reasons:string[]=[];
  const [goodie]=resultRows(await tx.execute(sql`SELECT id FROM goodie_assignments WHERE order_id=${orderId} LIMIT 1`));
  if(goodie)reasons.push('ORDER_GOODIE_RETURN_REVIEW_REQUIRED');
  const [positions]=resultRows(await tx.execute(sql`SELECT count(*)::int AS count FROM order_items WHERE order_id=${orderId}`));
  if ((!originals.length && Number(positions?.count)>0)
    || history.some((h:any)=>h.quantityChange>0 && ['retoure','korrektur'].includes(h.changeType) && !returnIds.has(h.id))
    || originals.some((h:any)=>!byId.has(h.articleId) || !Number.isSafeInteger(h.quantityChange) || h.quantityAfter-h.quantityBefore!==h.quantityChange)) reasons.push('ORDER_STOCK_HISTORY_REVIEW_REQUIRED');
  const movements=originals.map((h:any)=>{const a:any=byId.get(h.articleId);return {movementId:h.id,articleId:h.articleId,sku:a?.sku ?? null,currentStock:a?.stock ?? null,quantityBefore:h.quantityBefore,quantityChange:h.quantityChange,quantityAfter:h.quantityAfter,alreadyReturned:returned.has(h.id),returnUnits:returned.has(h.id)?0:-h.quantityChange};});
  return {reasons,movements,returnUnits:movements.reduce((sum:number,h:any)=>sum+h.returnUnits,0)};
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
export async function deleteOrderAtomically(db: any, orderId: string, restock: boolean, actor: string, expected?: {expectedTotal?:number;expectedVersion?:string}) {
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`order-delete:${orderId}`},0))`);
    const [prior] = resultRows(await tx.execute(sql`SELECT action,stock_units FROM priority_order_actions WHERE order_id=${orderId} AND action IN ('delete','delete_no_restock')`));
    if (prior) {
      if (prior.action !== (restock ? 'delete' : 'delete_no_restock')) throw Error('ORDER_DELETE_INTENT_CONFLICT');
      return { success:true, restoredStock:prior.stock_units, alreadyDeleted:true };
    }
    const order = await lockOrder(tx, orderId);
    if ((expected?.expectedTotal !== undefined && Number(order.total)!==expected.expectedTotal)
      || (expected?.expectedVersion !== undefined && new Date(order.updatedAt).toISOString()!==expected.expectedVersion)) throw Error('ORDER_DELETE_SNAPSHOT_CONFLICT');
    await assertOrderDeletable(tx, order);
    const units = restock ? await returnOrderStock(tx,order,'Explicit order deletion',actor) : 0;
    const reason=order.status==='bezahlt' && order.paidAt && Number(order.total)===0
      ? JSON.stringify({reason:'Explicit zero-total order deletion; historical paid marker retained',version:1,subtotal:order.subtotal,discount:order.discount,shipping:order.shipping,total:order.total,status:order.status,paidAt:new Date(order.paidAt).toISOString(),updatedAt:new Date(order.updatedAt).toISOString()})
      : 'Explicit order deletion';
    await recordOrderAction(tx,orderId,restock ? 'delete' : 'delete_no_restock',reason,actor,units);
    await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await tx.delete(orders).where(eq(orders.orderId, orderId));
    return { success:true, restoredStock:units };
  });
}
