import assert from "node:assert/strict";
import test from "node:test";
import { checkoutShippingItems, is369CustomerCheckout } from "./mainshopCheckoutIntegration.js";
import { calculateAuthoritativeShipping } from "./kwkCheckoutPricing.js";
import { reconcileFreeBacWaterForShopOrder } from "./freeBacWaterService.js";
import { shouldKeepClientDiscountBreakdownSource } from "./discountBreakdownRules.js";

const vial = { name: "Tirzepatide", price: 1, quantity: 2, type: "peptide", shopProductId: "tirzepatide" };
const catalog = [{ sku: "TIRZEPATIDE-20MG", shopProductId: "tirzepatide", category: "GLP-1", categories: ["GLP-1"] }];

test("new 369 customer scope excludes P4P and authenticated manual WaWi", () => {
  for (const storeKey of ["369research", "peps4pets", "checkout-v2"] as const) {
    assert.equal(is369CustomerCheckout({ storeKey, isAuthenticatedWawiManualSale: false }), storeKey !== "peps4pets");
    assert.equal(is369CustomerCheckout({ storeKey, isAuthenticatedWawiManualSale: true }), false);
  }
});

test("369 no-cooling shipping retains main P4P/WaWi cold surcharge once per order", () => {
  const items = [{ isPlugPlay: true }, { isNasalSpray: true }];
  for (const storeKey of ["369research", "peps4pets", "checkout-v2"] as const) {
    const customerItems = checkoutShippingItems({ storeKey, isAuthenticatedWawiManualSale: false, items });
    assert.equal(calculateAuthoritativeShipping({ country: "DE", items: customerItems }), storeKey === "peps4pets" ? 15 : 8);
    const wawiItems = checkoutShippingItems({ storeKey, isAuthenticatedWawiManualSale: true, items });
    assert.equal(wawiItems, items);
    assert.equal(calculateAuthoritativeShipping({ country: "DE", items: wawiItems }), 15);
  }
});

test("browser quantity amount cannot survive the authoritative audit-breakdown filter", () => {
  assert.equal(shouldKeepClientDiscountBreakdownSource("quantity_discount", {
    hasResolvedPromotionCode: false, hasResolvedPublicPartnerCode: false, hasAuthenticatedPartnerSelfOrder: false,
  }), false);
});

test("369 matched catalog vial receives BAC regardless of price; P4P and old callers retain threshold", () => {
  for (const price of [0, 1, 49, 50, 99]) {
    const items = [{ ...vial, price }];
    for (const storeKey of ["369research", "checkout-v2"] as const) {
      assert.equal(reconcileFreeBacWaterForShopOrder(items, catalog, { storeKey }).at(-1)?.quantity, 2);
      assert.equal(reconcileFreeBacWaterForShopOrder(items, catalog, { storeKey }).at(-1)?.isFreeGift, true);
    }
    const p4p = reconcileFreeBacWaterForShopOrder(items, catalog, { storeKey: "peps4pets" });
    assert.deepEqual(p4p, reconcileFreeBacWaterForShopOrder(items, catalog));
    assert.equal(p4p.length, price >= 50 ? 2 : 1);
  }
});

test("369 BAC entitlement fails closed for missing identity/categories and excludes non-vial formats", () => {
  assert.deepEqual(reconcileFreeBacWaterForShopOrder([vial], [], { storeKey: "369research" }), [vial]);
  assert.deepEqual(reconcileFreeBacWaterForShopOrder([vial], [{ ...catalog[0], category: "", categories: [] }], { storeKey: "369research" }), [vial]);
  for (const category of ["369 BeautyLine", "Zubehör", "Nasensprays", "Fertigpens", "Kapseln"]) {
    assert.deepEqual(reconcileFreeBacWaterForShopOrder([vial], [{ ...catalog[0], category, categories: [category] }], { storeKey: "369research" }), [vial]);
  }
  for (const flag of ["isPlugPlay", "isNasalSpray", "isNasalDiySet"] as const) {
    const item = { ...vial, [flag]: true };
    assert.deepEqual(reconcileFreeBacWaterForShopOrder([item], catalog, { storeKey: "369research" }), [item]);
  }
});
