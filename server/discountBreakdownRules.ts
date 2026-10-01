export type ClientDiscountBreakdownContext = {
  hasResolvedPromotionCode: boolean;
  hasResolvedPublicPartnerCode: boolean;
  hasAuthenticatedPartnerSelfOrder: boolean;
};

/**
 * Client-side line items describe the visible checkout preview only. The
 * checkout replaces monetary terms that it resolves authoritatively (automatic
 * promotions and public partner codes) before persisting the order.
 *
 * In particular, the browser presents any entered code as `promotion_code`.
 * A public partner code is resolved separately server-side, so retaining that
 * preview line and adding the authoritative partner row would double-count the
 * same discount in the audit breakdown.
 */
export function shouldKeepClientDiscountBreakdownSource(
  source: string,
  context: ClientDiscountBreakdownContext,
): boolean {
  if (source === "automatic_global_percent") return false;

  if (source === "promotion_code") {
    return !context.hasResolvedPromotionCode && !context.hasResolvedPublicPartnerCode;
  }

  if (source === "partner_self_discount") {
    return !context.hasResolvedPublicPartnerCode && !context.hasAuthenticatedPartnerSelfOrder;
  }

  return true;
}
