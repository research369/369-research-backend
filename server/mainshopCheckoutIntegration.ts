import type { ShippingCheckoutItem } from "./kwkCheckoutPricing.js";

export type CheckoutIntegrationStore = "369research" | "peps4pets" | "checkout-v2";

/** WaWi and P4P never inherit the new public 369 customer rules. */
export function is369CustomerCheckout(input: {
  storeKey: CheckoutIntegrationStore;
  isAuthenticatedWawiManualSale: boolean;
}): boolean {
  return !input.isAuthenticatedWawiManualSale && input.storeKey !== "peps4pets";
}

/** Preserve main's shared shipping helper and P4P/WaWi item-dependent cold-chain rules. */
export function checkoutShippingItems<T extends ShippingCheckoutItem>(input: {
  storeKey: CheckoutIntegrationStore;
  isAuthenticatedWawiManualSale: boolean;
  items: T[];
}): T[] {
  return is369CustomerCheckout(input) ? [] : input.items;
}

/**
 * Schema compatibility is not price parity. Until the quantity -> global -> promo
 * -> partner/KWK chain is approved in Legacy, refuse a new 369 quantity-discount
 * checkout before database access. Never store/accept its browser-supplied amount.
 * Existing P4P and authenticated manual WaWi pricing remain outside this rule.
 */
export function assertLegacyQuantityPricingReady(input: {
  storeKey: CheckoutIntegrationStore;
  orderSource: "shop" | "wawi_manual";
  discountBreakdown?: readonly { source: string }[];
}): void {
  if (input.orderSource === "shop" && input.storeKey !== "peps4pets"
    && input.discountBreakdown?.some((entry) => entry.source === "quantity_discount")) {
    throw new Error("LEGACY_QUANTITY_PRICING_NOT_APPROVED: Mengenpreisvertrag noch nicht freigegeben; kein Auftrag angelegt.");
  }
}
