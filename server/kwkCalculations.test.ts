import assert from "node:assert/strict";
import test from "node:test";
import { calculateKwkCommission, calculateKwkCommissionBase, calculateKwkDiscount } from "./kwkService.js";

test("KWK applies 10 percent discount and 10 percent credit", () => {
  assert.equal(calculateKwkDiscount(100), 10);
  assert.equal(calculateKwkCommission(90), 9);
});

test("KWK discount is subtracted once while redeemed credits remain payment instruments", () => {
  const base = calculateKwkCommissionBase({
    subtotal: 100,
    totalDiscount: 30, // 10 promotion + 10 KWK discount + 5 partner credit + 5 KWK credit
    partnerCreditUsed: 5,
    kwkCreditUsed: 5,
  });
  assert.equal(base, 80);
  assert.equal(calculateKwkCommission(base), 8);
});
