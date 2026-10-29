import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCheckoutV2QuantityDiscount,
  isCheckoutV2QuantityDiscountEligible,
} from "./checkoutV2QuantityDiscount.js";

test("Checkout V2 applies the 35 percent quantity tier to 36 eligible product units", () => {
  const discount = calculateCheckoutV2QuantityDiscount([{
    shopProductId: "bpc-157",
    name: "BPC-157",
    quantity: 36,
    unitPrice: 10,
    type: "peptide",
    category: "Peptide",
  }]);

  assert.deepEqual(discount, {
    percentage: 35,
    eligibleItems: 36,
    eligibleSubtotal: 360,
    amount: 126,
  });
});

test("Checkout V2 excludes BAC water and ordinary accessories but includes the pen with case", () => {
  assert.equal(isCheckoutV2QuantityDiscountEligible({
    shopProductId: "bac-wasser-3ml", name: "BAC Wasser 3 ml", quantity: 1, unitPrice: 4.16, type: "accessory", category: "Zubehör",
  }), false);
  assert.equal(isCheckoutV2QuantityDiscountEligible({
    shopProductId: "pen-nadel", name: "Pen Nadel", quantity: 1, unitPrice: 7, type: "accessory", category: "Zubehör",
  }), false);
  assert.equal(isCheckoutV2QuantityDiscountEligible({
    shopProductId: "forscherpen", name: "Peptidpen mit Case", quantity: 1, unitPrice: 49, type: "accessory", category: "Forscherpens",
  }), true);
});
