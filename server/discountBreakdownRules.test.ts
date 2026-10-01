import assert from "node:assert/strict";
import test from "node:test";
import { shouldKeepClientDiscountBreakdownSource } from "./discountBreakdownRules.js";

const noAuthoritativeTerms = {
  hasResolvedPromotionCode: false,
  hasResolvedPublicPartnerCode: false,
  hasAuthenticatedPartnerSelfOrder: false,
};

test("replaces the browser promotion preview with the authoritative public partner-code row", () => {
  assert.equal(shouldKeepClientDiscountBreakdownSource("promotion_code", {
    ...noAuthoritativeTerms,
    hasResolvedPublicPartnerCode: true,
  }), false);
  assert.equal(shouldKeepClientDiscountBreakdownSource("partner_self_discount", {
    ...noAuthoritativeTerms,
    hasResolvedPublicPartnerCode: true,
  }), false);
});

test("does not double-count the 10% partner discount for a pre-discounted bundle", () => {
  const browserPreview = [{ source: "promotion_code", amount: 13.86 }];
  const retainedPreviewTotal = browserPreview
    .filter((entry) => shouldKeepClientDiscountBreakdownSource(entry.source, {
      ...noAuthoritativeTerms,
      hasResolvedPublicPartnerCode: true,
    }))
    .reduce((sum, entry) => sum + entry.amount, 0);
  const authoritativePartnerDiscount = 13.86;

  assert.equal(retainedPreviewTotal, 0);
  assert.equal(retainedPreviewTotal + authoritativePartnerDiscount, 13.86);
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
