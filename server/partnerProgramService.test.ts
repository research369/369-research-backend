import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLegacyPartnerCodeTerms,
  calculateProgramDiscount,
  canRedeemShopCredit,
  isDiscountAllowedForProgram,
  isRepeatCodeUseAllowed,
  normalizePartnerCode,
  normalizePartnerCodeTerms,
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

test("keeps different terms for two public codes of one partner", () => {
  const terms = normalizePartnerCodeTerms([
    { code: "creator-five", customerDiscountPercent: 5, commissionPercent: 12.5 },
    { code: "creator-ten", customerDiscountPercent: 10, commissionPercent: 20 },
  ]);
  assert.deepEqual(terms, [
    { code: "CREATOR-FIVE", customerDiscountPercent: 5, commissionPercent: 12.5, isActive: true },
    { code: "CREATOR-TEN", customerDiscountPercent: 10, commissionPercent: 20, isActive: true },
  ]);
});

test("legacy CSV updates do not flatten previously stored code-specific terms", () => {
  const existing = [
    { id: 41, code: "CODE-A", customerDiscountPercent: 5, commissionPercent: 11, isActive: true },
    { id: 42, code: "CODE-B", customerDiscountPercent: 15, commissionPercent: 21, isActive: true },
  ];
  const synced = buildLegacyPartnerCodeTerms("code-a, code-b, code-c", existing, {
    customerDiscountPercent: 9,
    commissionPercent: 19,
  });
  assert.deepEqual(synced, [
    { id: 41, code: "CODE-A", customerDiscountPercent: 5, commissionPercent: 11, isActive: true },
    { id: 42, code: "CODE-B", customerDiscountPercent: 15, commissionPercent: 21, isActive: true },
    { code: "CODE-C", customerDiscountPercent: 9, commissionPercent: 19, isActive: true },
  ]);
});

test("rejects duplicate, invalid and fully deactivated public-code configurations", () => {
  assert.throws(() => normalizePartnerCodeTerms([
    { code: "same", customerDiscountPercent: 5, commissionPercent: 10 },
    { code: " SAME ", customerDiscountPercent: 10, commissionPercent: 15 },
  ]), /mehrfach/);
  assert.throws(() => normalizePartnerCodeTerms([
    { code: "invalid", customerDiscountPercent: 101, commissionPercent: 10 },
  ]), /zwischen 0 und 100/);
  assert.throws(() => normalizePartnerCodeTerms([
    { code: "disabled", customerDiscountPercent: 5, commissionPercent: 10, isActive: false },
  ]), /aktiv bleiben/);
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
