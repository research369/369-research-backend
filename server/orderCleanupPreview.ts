import { sql, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { orders } from '../drizzle/schema.js';
import { resultRows } from './priorityOrderIntegrity.js';
import { assertOrderDeletable, readOrderReturnPlan } from './orderStockReturnService.js';

export function orderCleanupError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const key=error instanceof Error ? error.message : '';
  const messages:Record<string,string>={
    ORDER_NOT_FOUND:'Bestellung nicht gefunden.',
    ORDER_DELETE_SNAPSHOT_CONFLICT:'Bestellung wurde geändert. Löschvorschau neu laden und den aktuellen Zustand prüfen.',
    ORDER_FINANCIAL_CORRECTION_REVIEW_REQUIRED:'Löschen nicht möglich: Zahlung oder gebuchte Finanz-/Rechnungsbelege vorhanden. Eine geprüfte finanzielle Korrektur ist erforderlich.',
    ORDER_RETURN_MANUAL_REVIEW_REQUIRED:'Versand oder Auslieferung vorhanden. Manuelle Prüfung erforderlich.',
    ORDER_SHIPPING_REVIEW_REQUIRED:'Versandlabel oder Tracking-Beleg vorhanden. Manuelle Prüfung erforderlich.',
    ORDER_STOCK_HISTORY_REVIEW_REQUIRED:'Originale Bestandsbewegungen sind nicht eindeutig nachgewiesen. Keine automatische Löschung/Rückbuchung.',
    ORDER_GOODIE_RETURN_REVIEW_REQUIRED:'Goodie-Zuordnung erfordert eine geprüfte Bestandskorrektur.',
    ORDER_INTEGRITY_REVIEW_REQUIRED:'Unerledigte Integritäts-/Reparaturaufgaben vorhanden. Vor dem Löschen prüfen.',
    ORDER_ZERO_TOTAL_REVIEW_REQUIRED:'Null-Euro-Gesamtbetrag stimmt nicht sicher mit den gespeicherten Artikeln und Beträgen überein.',
    ORDER_DELETE_INTENT_CONFLICT:'Bestellung bereits mit anderer Bestandsrückgabe-Absicht gelöscht. Audit prüfen.',
    stock_conflict:'Bestand wurde geändert. Löschvorschau neu laden.',
    invalid_stock:'Bestandsrückgabe würde einen ungültigen Bestand erzeugen. Manuelle Prüfung erforderlich.',
  };
  if(messages[key])throw new TRPCError({code:key==='ORDER_NOT_FOUND'?'NOT_FOUND':'CONFLICT',message:`${messages[key]} (${key})`,cause:error});
  throw error;
}
/** No ensure/migration, write or row lock. Dedicated read-only snapshot. No customer PII. */
export async function orderCleanupPreview(db:any,orderId:string) {
  return db.transaction(async(tx:any)=>{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const [order]=await tx.select().from(orders).where(eq(orders.orderId,orderId));
    if(!order)orderCleanupError(Error('ORDER_NOT_FOUND'));
    const [links]=resultRows(await tx.execute(sql`SELECT
      EXISTS(SELECT 1 FROM partner_transactions WHERE order_id=${orderId}) AS partner,
      EXISTS(SELECT 1 FROM kwk_ledger WHERE order_id=${orderId}) AS kwk,
      EXISTS(SELECT 1 FROM kwk_referrals WHERE order_id=${orderId}) AS referral,
      EXISTS(SELECT 1 FROM invoices WHERE order_number=${orderId}) AS invoice,
      EXISTS(SELECT 1 FROM invoices WHERE order_number=${order.externalOrderReference ?? null}) AS external_invoice,
      EXISTS(SELECT 1 FROM priority_order_tasks WHERE order_id=${orderId} AND state <> 'done') AS integrity`));
    const [archive]=resultRows(await tx.execute(sql`SELECT to_regclass('dhl_label_generations') IS NOT NULL AS present`));
    let archivedLabel=false;
    if(archive?.present){const [label]=resultRows(await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM dhl_label_generations WHERE order_id=${orderId} AND state <> 'create_rejected') AS linked`));archivedLabel=!!label?.linked;}
    const [photos]=resultRows(await tx.execute(sql`SELECT to_regclass('packing_photo_history') IS NOT NULL AS present`));
    let archivedPackingPhoto=false;
    if(photos?.present){const [photo]=resultRows(await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM packing_photo_history WHERE order_id=${orderId}) AS linked`));archivedPackingPhoto=!!photo?.linked;}
    const plan=await readOrderReturnPlan(tx,orderId);
    const reasons:string[]=[];
    try {await assertOrderDeletable(tx,order);} catch(error){if(error instanceof Error && /^ORDER_/.test(error.message))reasons.push(error.message);else throw error;}
    if(links?.partner)reasons.push('PARTNER_TRANSACTIONS_PRESENT');
    if(links?.kwk)reasons.push('KWK_LEDGER_PRESENT');
    if(links?.referral)reasons.push('KWK_REFERRAL_PRESENT');
    if(links?.invoice || links?.external_invoice)reasons.push('INVOICE_PRESENT');
    if(order.bunqPaymentId || order.bunqMatchedAt)reasons.push('BANK_PAYMENT_PRESENT');
    if(order.shippingLabelUrl || order.shippingLabelContent || order.trackingNumber || archivedLabel)reasons.push('SHIPPING_EVIDENCE_PRESENT');
    if(order.packedAt || order.packingPhotoAt || order.packingPhotoUrl || archivedPackingPhoto)reasons.push('PACKING_EVIDENCE_PRESENT');
    if(order.shippedAt || order.deliveredAt || ['versendet','zugestellt','abgeholt'].includes(order.status))reasons.push('SHIPPED_OR_DELIVERED');
    if(order.status==='bezahlt' && Number(order.total)===0 && links?.integrity)reasons.push('UNRESOLVED_INTEGRITY_TASKS');
    const restockReasons=[...new Set([...reasons,...plan.reasons])];
    return {orderId,expectedTotal:Number(order.total),expectedVersion:new Date(order.updatedAt).toISOString(),
      status:order.status,paidAt:order.paidAt ? new Date(order.paidAt).toISOString():null,
      packed:!!order.packedAt,shipped:!!order.shippedAt,delivered:!!order.deliveredAt,
      links:{partnerTransactions:!!links?.partner,kwkLedger:!!links?.kwk,kwkReferrals:!!links?.referral,invoices:!!links?.invoice,externalReferenceInvoices:!!links?.external_invoice,bankPayment:!!(order.bunqPaymentId || order.bunqMatchedAt),headerLabel:!!(order.shippingLabelUrl || order.shippingLabelContent),tracking:!!order.trackingNumber,archiveAvailable:!!archive?.present,archivedLabel,headerPackingPhoto:!!(order.packingPhotoAt || order.packingPhotoUrl),archivedPackingPhoto,integrityTasks:!!links?.integrity},
      deletion:{eligible:reasons.length===0,reasons:[...new Set(reasons)],restockEligible:restockReasons.length===0,restockReasons},
      stock:{returnUnits:plan.returnUnits,movements:plan.movements,reasons:plan.reasons}};
  });
}
