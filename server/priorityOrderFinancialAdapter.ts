import * as partnerService from './partnerCreditService.js';
import * as kwkService from './kwkService.js';
import { createPartnerCreditTransactionQueryClient } from './partnerCreditTransactionQuery.js';
import type { PartnerCreditQueryClient } from './partnerCreditService.js';
export type OrderCancellationAdapters = {
  partner: (orderId:string,client:PartnerCreditQueryClient) => Promise<any>;
  kwk: (orderId:string,client:PartnerCreditQueryClient) => Promise<void>;
};
/** Both mandatory ledger exports share the caller's locked order transaction.
 * No legacy out-of-tx fallback or successful cancellation with missing ledgers.
 */
export async function reverseOrderFinancesInTransaction(tx: any, orderId: string, adapters?:OrderCancellationAdapters) {
  const sameTx = adapters ?? {
    partner:partnerService.reversePartnerFinancialEntriesForCancelledOrder,
    kwk:kwkService.cancelCreditInTransaction,
  };
  const client = createPartnerCreditTransactionQueryClient(query => tx.execute(query));
  await sameTx.partner(orderId,client);
  await sameTx.kwk(orderId,client);
  return { repairRequired:false };
}
