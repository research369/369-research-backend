import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAuthoritativeKwkOrder,
  calculatePromoDiscount,
  calculateAuthoritativeShipping,
  normalizeKwkPhone,
  parsePromoMetadata,
  resolveAuthoritativeItemPrice,
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
  assert.deepEqual(parsePromoMetadata('Text | {"restrict":["3g"],"freeShipping":["de"]}'), { restrict: ["3g"], freeShipping: ["de"] });
  assert.deepEqual(parsePromoMetadata("Text"), { restrict: [], freeShipping: [] });
  assert.equal(normalizeKwkPhone("+49 (0) 171-123 45"), "4917112345");
  assert.equal(normalizeKwkPhone("0171 123 45"), "4917112345");
  assert.equal(normalizeKwkPhone("0049 171 123 45"), "4917112345");
});

test("catalog prices and option surcharges are authoritative", () => {
  const catalog = [{
    sku: "TEST-10MG", shopProductId: "test", name: "Test (10 mg)", sellingPrice: "49.00",
    salePrice: null, variants: [{ dosage: "10mg", price: 55 }], isActive: 1, shopVisible: 1,
  }];
  assert.equal(resolveAuthoritativeItemPrice({ shopProductId: "test", dosage: "10 mg", price: 1, quantity: 1 }, catalog), 55);
  assert.equal(resolveAuthoritativeItemPrice({ shopProductId: "test", dosage: "10 mg", price: 1, quantity: 1, isPlugPlay: true }, catalog), 70);
});

test("shipping comes from the delivery country and is never discounted by KWK", () => {
  assert.equal(calculateAuthoritativeShipping({ country: "Deutschland", items: [] }), 8);
  assert.equal(calculateAuthoritativeShipping({ country: "Schweiz", items: [{ isPlugPlay: true }] }), 25);
  assert.equal(calculateAuthoritativeShipping({ country: "Deutschland", items: [{ isPlugPlay: true }], promoDescription: 'Aktion | {"freeShipping":["de"]}' }), 0);
});
