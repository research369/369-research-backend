import assert from "node:assert/strict";
import test from "node:test";
import { calculateAuthoritativeShopCheckoutPricing } from "./shopCheckoutPricing.js";

test("keeps an authenticated partner's direct discount and credit redemption together", () => {
  const result = calculateAuthoritativeShopCheckoutPricing({
    subtotal: 219,
    shipping: 25,
    automaticGlobalDiscount: 0,
    promotionDiscount: 0,
    partnerDiscount: 21.9,
    partnerCreditUsed: 12.06,
  });

  assert.deepEqual(result, {
    automaticGlobalDiscount: 0,
    promotionDiscount: 0,
    partnerDiscount: 21.9,
    partnerCreditUsed: 12.06,
    totalDiscount: 33.96,
    total: 210.04,
  });
});

test("replaces a stale browser-wide discount instead of double-counting it", () => {
  const result = calculateAuthoritativeShopCheckoutPricing({
    subtotal: 219,
    shipping: 25,
    automaticGlobalDiscount: 0,
    promotionDiscount: 0,
    partnerDiscount: 21.9,
    partnerCreditUsed: 12.06,
  });

  assert.equal(result.totalDiscount, 33.96);
  assert.equal(result.total, 210.04);
});

test("never lets direct discount plus credit reduce shipping or exceed product value", () => {
  const result = calculateAuthoritativeShopCheckoutPricing({
    subtotal: 100,
    shipping: 25,
    automaticGlobalDiscount: 20,
    promotionDiscount: 10,
    partnerDiscount: 70,
    partnerCreditUsed: 50,
  });

  assert.deepEqual(result, {
    automaticGlobalDiscount: 20,
    promotionDiscount: 10,
    partnerDiscount: 70,
    partnerCreditUsed: 0,
    totalDiscount: 100,
    total: 25,
  });
});
