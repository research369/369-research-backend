import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateProgramDiscount,
  canRedeemShopCredit,
  isDiscountAllowedForProgram,
  isRepeatCodeUseAllowed,
  normalizePartnerCode,
  splitPartnerCodes,
  type PartnerProgram,
} from "./partnerProgramService.js";

const creator: PartnerProgram = {
  key: "creator",
  label: "Creator",
  customerDiscountPolicy: "each_valid_code_use",
  commissionPolicy: "each_paid_code_order",
  settlementMethod: "payout",
  allowSelfOrderCredit: false,
  active: true,
};

const partner: PartnerProgram = {
  key: "partner",
  label: "Partner",
  customerDiscountPolicy: "first_paid_code_use",
  commissionPolicy: "first_paid_code_order",
  settlementMethod: "shop_credit",
  allowSelfOrderCredit: true,
  active: true,
};

test("normalizes and deduplicates individual public partner codes", () => {
  assert.equal(normalizePartnerCode(" creator 10 "), "CREATOR10");
  assert.deepEqual(splitPartnerCodes("creator10, Creator10,  second-code"), ["CREATOR10", "SECOND-CODE"]);
});

test("allows a Creator code repeatedly and keeps it payout-only", () => {
  assert.equal(isRepeatCodeUseAllowed(creator), true);
  assert.equal(isDiscountAllowedForProgram(creator, "customer@example.com", null), true);
  assert.equal(canRedeemShopCredit(creator), false);
});

test("keeps the legacy Partner first-use policy and shop-credit capability", () => {
  assert.equal(isRepeatCodeUseAllowed(partner), false);
  assert.equal(canRedeemShopCredit(partner), true);
});

test("calculates the customer discount only once on the post-promotion product base", () => {
  assert.equal(calculateProgramDiscount(100, 20, 10), 8);
  assert.equal(calculateProgramDiscount(100, 0, 10), 10);
  assert.equal(calculateProgramDiscount(10, 20, 10), 0);
});
