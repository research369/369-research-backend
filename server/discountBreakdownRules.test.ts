import assert from "node:assert/strict";
import test from "node:test";
import { shouldKeepClientDiscountBreakdownSource } from "./discountBreakdownRules.js";

const noAuthoritativeTerms = {
  hasResolvedPromotionCode: false,
  hasResolvedPublicPartnerCode: false,
  hasAuthenticatedPartnerSelfOrder: false,
};

test("rebuilds both browser previews when promo and public partner terms are server-authoritative", () => {
  assert.equal(shouldKeepClientDiscountBreakdownSource("promotion_code", {
    ...noAuthoritativeTerms,
    hasResolvedPublicPartnerCode: true,
  }), false);
  assert.equal(shouldKeepClientDiscountBreakdownSource("partner_self_discount", {
    ...noAuthoritativeTerms,
    hasResolvedPublicPartnerCode: true,
  }), false);
});

test("does not double-count promo or 15% partner discounts for a pre-discounted bundle", () => {
  const browserPreview = [
    { source: "promotion_code", amount: 10 },
    { source: "partner_self_discount", amount: 13.5 },
  ];
  const retainedPreviewTotal = browserPreview
    .filter((entry) => shouldKeepClientDiscountBreakdownSource(entry.source, {
      ...noAuthoritativeTerms,
      hasResolvedPromotionCode: true,
      hasResolvedPublicPartnerCode: true,
    }))
    .reduce((sum, entry) => sum + entry.amount, 0);
  const authoritativePromoDiscount = 10;
  const authoritativePartnerDiscount = 13.5;

  assert.equal(retainedPreviewTotal, 0);
  assert.equal(retainedPreviewTotal + authoritativePromoDiscount + authoritativePartnerDiscount, 23.5);
});

test("keeps an ordinary browser promotion until the server has resolved it", () => {
  assert.equal(shouldKeepClientDiscountBreakdownSource("promotion_code", noAuthoritativeTerms), true);
  assert.equal(shouldKeepClientDiscountBreakdownSource("promotion_code", {
    ...noAuthoritativeTerms,
    hasResolvedPromotionCode: true,
  }), false);
});

test("keeps other valid discount provenance entries and always rebuilds global discounts", () => {
  assert.equal(shouldKeepClientDiscountBreakdownSource("kwk_credit", noAuthoritativeTerms), true);
  assert.equal(shouldKeepClientDiscountBreakdownSource("automatic_global_percent", noAuthoritativeTerms), false);
});
