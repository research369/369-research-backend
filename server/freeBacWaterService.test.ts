import assert from "node:assert/strict";
import test from "node:test";
import { reconcileFreeBacWaterForShopOrder } from "./freeBacWaterService.js";

const blueWonder = {
  name: "Blue Wonder – GHK-Cu & SNAP 8 Serum",
  price: 79,
  quantity: 1,
  type: "peptide",
  shopProductId: "blue-wonder-serum",
};

const freeBac = {
  name: "BAC Wasser 3ml (GRATIS)",
  price: 0,
  quantity: 1,
  type: "accessory",
  shopProductId: "bac-wasser-3ml",
  isFreeGift: true,
};

const catalog = [
  { sku: "369-BLUEWONDER-50ML", shopProductId: "blue-wonder-serum", category: "369 BeautyLine", categories: ["369 BeautyLine"] },
  { sku: "TIRZEPATIDE-20MG", shopProductId: "tirzepatide", category: "GLP-1", categories: ["GLP-1"] },
];

test("removes a browser-generated BAC gift from a cosmetic-only order", () => {
  const result = reconcileFreeBacWaterForShopOrder([blueWonder, freeBac], catalog);
  assert.deepEqual(result, [blueWonder]);
});

test("adds BAC only for actual qualifying peptide vials in a mixed basket", () => {
  const tirzepatide = {
    name: "Tirzepatide",
    price: 80,
    quantity: 2,
    type: "peptide",
    shopProductId: "tirzepatide",
  };
  const result = reconcileFreeBacWaterForShopOrder([blueWonder, tirzepatide, freeBac], catalog);
  assert.equal(result.length, 3);
  const generatedBac = result.find((item) => item.name === "BAC Wasser 3ml (GRATIS)");
  assert.ok(generatedBac);
  assert.equal(generatedBac.quantity, 2);
});

test("keeps the per-vial BAC entitlement for a peptide bundle below the single-vial threshold", () => {
  const bundlePeptide = {
    name: "Tirzepatide",
    price: 39,
    quantity: 2,
    type: "peptide",
    variant: "Bundle: Lean Bundle",
    shopProductId: "tirzepatide",
  };
  const result = reconcileFreeBacWaterForShopOrder([bundlePeptide, freeBac], catalog);
  const generatedBac = result.find((item) => item.name === "BAC Wasser 3ml (GRATIS)");
  assert.ok(generatedBac);
  assert.equal(generatedBac.quantity, 2);
});

test("never gives a BeautyLine bundle component a BAC gift", () => {
  const blueWonderBundle = {
    ...blueWonder,
    price: 39,
    variant: "Bundle: Glow Set",
  };
  const result = reconcileFreeBacWaterForShopOrder([blueWonderBundle, freeBac], catalog);
  assert.deepEqual(result, [blueWonderBundle]);
});

test("never replaces a paid BAC product line", () => {
  const paidBac = {
    name: "BAC Wasser 3ml",
    price: 4,
    quantity: 1,
    type: "accessory",
    shopProductId: "bac-wasser-3ml",
  };
  const result = reconcileFreeBacWaterForShopOrder([blueWonder, paidBac], catalog);
  assert.deepEqual(result, [blueWonder, paidBac]);
});
