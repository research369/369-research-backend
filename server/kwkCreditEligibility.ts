import { isFinanciallyPaidStatus } from "./paidFinancialStatus.js";

export type KwkCreditReleaseEligibility = {
  status: string;
  paidAt: Date | string | null;
  cancelledAt: Date | string | null;
};

/**
 * A KWK credit may be released only after the order carries a persisted payment
 * timestamp, has a financially-paid fulfilment state and was not cancelled.
 */
export function isKwkCreditReleaseEligible(input: KwkCreditReleaseEligibility): boolean {
  return isFinanciallyPaidStatus(input.status)
    && Boolean(input.paidAt)
    && !input.cancelledAt;
}
