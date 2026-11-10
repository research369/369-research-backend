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
