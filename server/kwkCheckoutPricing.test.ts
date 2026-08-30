import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAuthoritativeKwkOrder,
  calculatePromoDiscount,
  normalizeKwkPhone,
  parsePromoMetadata,
} from "./kwkCheckoutPricing.js";

test("general promo and KWK stack sequentially while shipping stays untouched", () => {
  const promoDiscount = calculatePromoDiscount({
    subtotal: 100,
    items: [{ shopProductId: "3g-triple-g", price: 100, quantity: 1 }],
    promo: { discountType: "percent", percentage: 10, fixedAmount: 0 },
  });
  assert.deepEqual(calculateAuthoritativeKwkOrder({
    subtotal: 100,
    shipping: 8,
    promoDiscount,
    kwkCreditUsed: 0,
    applyReferralDiscount: true,
  }), {
    promoDiscount: 10,
    kwkDiscount: 9,
    kwkCreditUsed: 0,
    totalDiscount: 19,
    total: 89,
  });
});

test("restricted promo only discounts eligible products before KWK", () => {
  const promoDiscount = calculatePromoDiscount({
    subtotal: 150,
    items: [
      { shopProductId: "3g-triple-g", price: 100, quantity: 1 },
      { shopProductId: "bac-water", price: 50, quantity: 1 },
    ],
    promo: {
      discountType: "percent",
      percentage: 20,
      fixedAmount: 0,
      description: 'Aktion | {"restrict":["3g-triple-g"]}',
    },
  });
  assert.equal(promoDiscount, 20);
  assert.equal(calculateAuthoritativeKwkOrder({
    subtotal: 150,
    shipping: 15,
    promoDiscount,
    kwkCreditUsed: 0,
    applyReferralDiscount: true,
  }).kwkDiscount, 13);
});

test("KWK credit is a payment instrument and cannot reduce shipping", () => {
  assert.deepEqual(calculateAuthoritativeKwkOrder({
    subtotal: 50,
    shipping: 8,
    promoDiscount: 0,
    kwkCreditUsed: 100,
    applyReferralDiscount: false,
  }), {
    promoDiscount: 0,
    kwkDiscount: 0,
    kwkCreditUsed: 50,
    totalDiscount: 50,
    total: 8,
  });
});

test("promo metadata and phone normalization are deterministic", () => {
  assert.deepEqual(parsePromoMetadata('Text | {"restrict":["3g"]}'), { restrict: ["3g"] });
  assert.deepEqual(parsePromoMetadata("Text"), { restrict: [] });
  assert.equal(normalizeKwkPhone("+49 (0) 171-123 45"), "4917112345");
  assert.equal(normalizeKwkPhone("0171 123 45"), "4917112345");
  assert.equal(normalizeKwkPhone("0049 171 123 45"), "4917112345");
});
