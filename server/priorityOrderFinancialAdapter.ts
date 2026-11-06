import { sql } from 'drizzle-orm';
import * as partnerService from './partnerCreditService.js';
import * as kwkService from './kwkService.js';
import { createPartnerCreditTransactionQueryClient } from './partnerCreditTransactionQuery.js';
import { queueOrderTask } from './priorityOrderIntegrity.js';
import type { PartnerCreditQueryClient } from './partnerCreditService.js';
export type OrderCancellationAdapters = {
  partner: (orderId:string,client:PartnerCreditQueryClient) => Promise<any>;
  kwk: (orderId:string,client:PartnerCreditQueryClient) => Promise<void>;
};
/** Explicit same-tx contract: ledger-contract.md requires both exports in one release.
 * Caller already holds order row lock and persists storniert in this transaction.
 * No legacy out-of-tx cancellation fallback, no swallowed adapter failure.
 */
export async function reverseOrderFinancesInTransaction(tx: any, orderId: string, adapters?:OrderCancellationAdapters) {
  const partner = partnerService as any;
  const kwk = kwkService as any;
  const sameTx = adapters ?? (typeof kwk.cancelCreditInTransaction === 'function' ? {
    partner:partner.reversePartnerFinancialEntriesForCancelledOrder,
    kwk:kwk.cancelCreditInTransaction,
  } : null);
  if (!sameTx) {
    await queueOrderTask(tx,orderId,'financial_cancellation');
    await tx.execute(sql`UPDATE priority_order_tasks SET state='repair_required',updated_at=now() WHERE order_id=${orderId} AND task='financial_cancellation'`);
    return { repairRequired:true };
  }
  const client = createPartnerCreditTransactionQueryClient(query => tx.execute(query));
  await sameTx.partner(orderId,client);
  await sameTx.kwk(orderId,client);
  return { repairRequired:false };
}
