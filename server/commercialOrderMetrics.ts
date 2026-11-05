export const COMPLETED_REVENUE_STATUSES = new Set([
  "bezahlt",
  "gepackt",
  "versendet",
  "zugestellt",
]);

export type CommercialOrderInput = {
  status?: string | null;
  total?: string | number | null;
};

/**
 * A zero-total order remains a valid historical fulfillment record, but it is
 * not a commercial sale. Keeping this definition central prevents gifts,
 * replacements and goodwill shipments from inflating sales, CRM and follow-up
 * metrics while preserving the original order unchanged.
 */
export function hasPositiveOrderTotal(order: Pick<CommercialOrderInput, "total">): boolean {
  const total = Number(order.total ?? 0);
  return Number.isFinite(total) && total > 0;
}

export function isCommercialOrder(order: CommercialOrderInput): boolean {
  return String(order.status || "").trim().toLowerCase() !== "storniert"
    && hasPositiveOrderTotal(order);
}

export function isCompletedCommercialOrder(order: CommercialOrderInput): boolean {
  return COMPLETED_REVENUE_STATUSES.has(String(order.status || "").trim().toLowerCase())
    && hasPositiveOrderTotal(order);
}

export function isBillableOrderItem(item: { price?: string | number | null }): boolean {
  const price = Number(item.price ?? 0);
  return Number.isFinite(price) && price > 0;
}
