import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPromotionMinimumOrder,
  repricePublicCheckoutItems,
} from "./publicCheckoutPricing.js";

const catalog = [
  {
    sku: "PUBLIC-10MG",
    shopProductId: "public-product",
    name: "Public product (10 mg)",
    sellingPrice: "100.00",
    salePrice: null,
    variants: [{ dosage: "10 mg", price: 100 }],
    isActive: 1,
    shopVisible: 1,
  },
];

test("public checkout rebuilds forged browser prices before applying a promotion threshold", () => {
  const repriced = repricePublicCheckoutItems([
    {
      shopProductId: "public-product",
      dosage: "10 mg",
      price: 1,
      quantity: 1,
    },
  ], catalog);

  assert.equal(repriced.items[0].price, 100);
  assert.equal(repriced.subtotal, 100);
  assert.doesNotThrow(() => assertPromotionMinimumOrder(100, repriced.subtotal));
  assert.throws(() => assertPromotionMinimumOrder(101, repriced.subtotal), /AKTIONSCODE_UNGUELTIG/);
});

test("public checkout keeps generated free gifts free while pricing all purchased lines from catalog", () => {
  const repriced = repricePublicCheckoutItems([
    {
      shopProductId: "public-product",
      dosage: "10 mg",
      price: 0.01,
      quantity: 2,
    },
    {
      shopProductId: "bac-water-3ml",
      price: 99,
      quantity: 1,
      isFreeGift: true,
    },
  ], catalog);

  assert.deepEqual(repriced.items.map((item) => item.price), [100, 0]);
  assert.equal(repriced.subtotal, 200);
});
