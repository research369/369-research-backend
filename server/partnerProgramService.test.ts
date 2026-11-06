import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLegacyPartnerCodeTerms,
  calculatePublicPartnerCustomerDiscount,
  calculateProgramDiscount,
  calculateSelfOrderDiscountPercent,
  canRedeemShopCredit,
  assertNoMixedPartnerOrderInput,
  assertPartnerShopCreditAvailable,
  resolveSelfOrderTerms,
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

test("keeps a partner code as attribution only on a manual WaWi sale", () => {
  assert.equal(calculatePublicPartnerCustomerDiscount({
    subtotal: 185,
    priorProductDiscount: 18.5,
    percentage: 10,
    isAuthenticatedWawiManualSale: true,
  }), 0);

  assert.equal(calculatePublicPartnerCustomerDiscount({
    subtotal: 185,
    priorProductDiscount: 18.5,
    percentage: 10,
    isAuthenticatedWawiManualSale: false,
  }), 16.65);
});

test("stacks a public 15% partner code on an already reduced bundle and an ordinary promo", () => {
  // 100 € is the bundle's current shop price. A 10 € public promotion applies
  // first, then a 15% Creator code applies to the remaining 90 €. Shipping is
  // intentionally outside this price helper and remains untouched.
  const promoDiscount = 10;
  assert.equal(calculateProgramDiscount(100, promoDiscount, 15), 13.5);
  assert.equal(100 - promoDiscount - calculateProgramDiscount(100, promoDiscount, 15), 76.5);
});

test("converts a Creator's public discount plus payout into one self-order discount", () => {
  assert.equal(calculateSelfOrderDiscountPercent(creator, 10, 20), 30);
  assert.equal(calculateSelfOrderDiscountPercent(creator, 5, 12.5), 17.5);
  // Historic partner/self-user programs retain their own configured product discount.
  assert.equal(calculateSelfOrderDiscountPercent(partner, 10, 20), 10);
});

test("explicit Creator-key shop-credit terms keep 10% discount and 10% earning separate", () => {
  const shopCreditCreator = { ...creator, settlementMethod: "shop_credit" as const, allowSelfOrderCredit: true };
  assert.deepEqual(resolveSelfOrderTerms(shopCreditCreator, 10, 10), {
    discountPercent: 10, commissionPercent: 10, creditRedeemable: true, convertsPayoutCommission: false,
  });
  assert.equal(calculateSelfOrderDiscountPercent(shopCreditCreator, 10, 10), 10);
  assert.equal(resolveSelfOrderTerms(partner, 10, 10).commissionPercent, 10);
  assert.deepEqual(resolveSelfOrderTerms(creator, 10, 10), {
    discountPercent: 20, commissionPercent: 0, creditRedeemable: false, convertsPayoutCommission: true,
  });
});

test("commission-policy none and settlement none never create phantom converted commission", () => {
  for (const program of [
    { ...creator, commissionPolicy: "none" as const },
    { ...creator, settlementMethod: "none" as const },
    { ...partner, commissionPolicy: "none" as const },
  ]) {
    const terms = resolveSelfOrderTerms(program, 10, 10);
    assert.equal(terms.discountPercent, 10);
    assert.equal(terms.commissionPercent, 0);
    assert.equal(terms.convertsPayoutCommission, false);
  }
  // Earning policy does not revoke redemption of previously earned shop credit.
  assert.equal(resolveSelfOrderTerms({ ...partner, commissionPolicy: "none" }, 10, 10).creditRedeemable, true);
});

test("inactive/missing programs fail closed and disallowed self-credit does not earn shop credit", () => {
  for (const program of [null, { ...creator, active: false }, { ...partner, active: false }]) {
    assert.deepEqual(resolveSelfOrderTerms(program, 10, 10), {
      discountPercent: 0, commissionPercent: 0, creditRedeemable: false, convertsPayoutCommission: false,
    });
  }
  assert.equal(canRedeemShopCredit({ ...partner, active: false }), false);
  const disabled = resolveSelfOrderTerms({ ...partner, allowSelfOrderCredit: false }, 10, 10);
  assert.equal(disabled.discountPercent, 10);
  assert.equal(disabled.commissionPercent, 0);
  assert.equal(disabled.creditRedeemable, false);
});

test("positive-credit preflight requires current active explicit entitlement before checking balance", () => {
  for (const program of [null, creator, { ...partner, active: false }, { ...partner, allowSelfOrderCredit: false }, { ...partner, settlementMethod: "none" as const }]) {
    assert.throws(() => assertPartnerShopCreditAvailable(program, 12.06, 1000), /PARTNER_GUTHABEN_PROGRAMM_AUSGESCHLOSSEN/);
  }
  assert.throws(() => assertPartnerShopCreditAvailable(partner, 12.06, 12.05), /PARTNER_GUTHABEN_NICHT_AUSREICHEND/);
  assert.throws(() => assertPartnerShopCreditAvailable(partner, 12.06, NaN), /PARTNER_GUTHABEN_NICHT_AUSREICHEND/);
  assert.throws(() => assertPartnerShopCreditAvailable(partner, -1, 100), /Ungültiger/);
  assert.doesNotThrow(() => assertPartnerShopCreditAvailable(partner, 12.06, 12.06));
  assert.doesNotThrow(() => assertPartnerShopCreditAvailable(creator, 0, 100));
});

test("mixed public code plus self-order number or positive credit is rejected explicitly", () => {
  for (const input of [
    { partnerCode: "FOREIGN", partnerNumber: "OWN" },
    { partnerCode: "FOREIGN", creditUsed: 12.06 },
    { partnerCode: "OWNCODE", partnerNumber: "OWN", creditUsed: 12.06 },
  ]) assert.throws(() => assertNoMixedPartnerOrderInput(input), /PARTNER_CODE_SELBSTBESTELLUNG_AUSGESCHLOSSEN/);
  assert.doesNotThrow(() => assertNoMixedPartnerOrderInput({ partnerCode: "PUBLIC", creditUsed: 0 }));
  assert.doesNotThrow(() => assertNoMixedPartnerOrderInput({ partnerCode: " ", partnerNumber: "OWN", creditUsed: 12.06 }));
});
