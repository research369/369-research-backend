import test from "node:test";
import assert from "node:assert/strict";
import { publicCodeCommissionPreview } from "./partnerCommissionPreview.js";
import type { ResolvedPartnerCode } from "./partnerProgramService.js";
const code: ResolvedPartnerCode = {
  codeId: 31,
  partnerId: 3,
  partnerName: "Synthetic",
  partnerCode: "TEST",
  partnerNumber: "P-TEST",
  partnerEmail: null,
  customerDiscountPercent: 15,
  commissionPercent: 7.5,
  program: {
    key: "creator",
    label: "Creator",
    active: true,
    customerDiscountPolicy: "each_valid_code_use",
    commissionPolicy: "each_paid_code_order",
    settlementMethod: "payout",
    allowSelfOrderCredit: false,
  },
};
test("preview uses exact code rates and payment basis, never books", () => {
  const r = publicCodeCommissionPreview(
    code,
    { subtotal: 200, discount: 50, creditUsed: 20, email: null },
    false,
  );
  assert.equal(r.base, 170);
  assert.equal(r.expectedAmount, 12.75);
  assert.equal(r.commissionPercent, 7.5);
  assert.equal(r.codeId, 31);
  assert.equal(r.booking, "not_performed");
  assert.equal(r.trigger, "confirmed_payment");
  assert.equal(r.customerHistoryChecked, false);
});
test("first paid policy requires identity and excludes repeat customers; no commission policy remains zero", () => {
  const terms = {
    ...code,
    program: {
      ...code.program,
      commissionPolicy: "first_paid_code_order" as const,
    },
  };
  const input = {
    subtotal: 100,
    discount: 15,
    creditUsed: 0,
    email: null as string | null,
  };
  assert.equal(publicCodeCommissionPreview(terms, input, false).eligible, null);
  input.email = "synthetic@example.invalid";
  assert.equal(
    publicCodeCommissionPreview(terms, input, false).expectedAmount,
    6.38,
  );
  assert.equal(
    publicCodeCommissionPreview(terms, input, true).expectedAmount,
    0,
  );
  assert.equal(
    publicCodeCommissionPreview(
      { ...terms, program: { ...terms.program, commissionPolicy: "none" } },
      input,
      false,
    ).reason,
    "program_without_commission",
  );
});
