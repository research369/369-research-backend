export interface OrderConfirmationPolicyInput {
  /** True only after the route verified an authenticated WaWi manual sale. */
  isAuthenticatedWawiManualSale: boolean;
  /** Explicit operator choice shown in the manual-sale summary. */
  sendOrderConfirmation?: boolean;
}

/**
 * Shop checkout confirmations remain automatic. A manual WaWi sale sends a
 * customer confirmation only if the authenticated operator opted in.
 */
export function shouldSendOrderConfirmation({
  isAuthenticatedWawiManualSale,
  sendOrderConfirmation,
}: OrderConfirmationPolicyInput): boolean {
  return !isAuthenticatedWawiManualSale || sendOrderConfirmation === true;
}
