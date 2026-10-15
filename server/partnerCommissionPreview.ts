import {
  calculateCommissionAmount,
  calculateCommissionBase,
} from "./partnerCreditService.js";
import type { ResolvedPartnerCode } from "./partnerProgramService.js";
export function publicCodeCommissionPreview(
  terms: ResolvedPartnerCode,
  input: {
    subtotal: number;
    discount: number;
    creditUsed: number;
    email: string | null;
  },
  previousPaid: boolean,
) {
  const policy = terms.program.commissionPolicy;
  const identityKnown = !!input.email?.trim();
  const eligible =
    policy === "none"
      ? false
      : policy === "first_paid_code_order" && !identityKnown
        ? null
        : policy === "first_paid_code_order"
          ? !previousPaid
          : true;
  const amounts = {
    subtotal: input.subtotal,
    totalProductDiscount: input.discount,
    creditUsed: input.creditUsed,
  };
  return {
    partnerId: terms.partnerId,
    codeId: terms.codeId,
    code: terms.partnerCode,
    program: terms.program,
    customerDiscountPercent: terms.customerDiscountPercent,
    commissionPercent: terms.commissionPercent,
    base: calculateCommissionBase(amounts),
    expectedAmount:
      eligible === null
        ? null
        : eligible
          ? calculateCommissionAmount({
              ...amounts,
              commissionPercent: terms.commissionPercent,
            })
          : 0,
    eligible,
    reason:
      policy === "none"
        ? "program_without_commission"
        : eligible === null
          ? "customer_required"
          : !eligible
            ? "one_time_already_paid"
            : "after_confirmed_payment",
    customerHistoryChecked: identityKnown,
    booking: "not_performed",
    trigger: "confirmed_payment",
  };
}
