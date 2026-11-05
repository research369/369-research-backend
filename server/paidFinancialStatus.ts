/**
 * A paid order can move through these fulfillment states without losing its
 * financial side effects. Re-running an idempotent ledger release is safe.
 */
const PAID_FINANCIAL_STATUSES = new Set([
  "bezahlt",
  "gepackt",
  "versendet",
  "zugestellt",
  "abgeholt",
]);

export function isFinanciallyPaidStatus(status: string): boolean {
  return PAID_FINANCIAL_STATUSES.has(status);
}
