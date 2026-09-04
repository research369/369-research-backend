import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateCheckoutV2AutomaticGiftLines,
  type CheckoutV2AutomaticEligibleLine,
} from "./checkoutV2AutomaticBenefits.js";

function line(overrides: Partial<CheckoutV2AutomaticEligibleLine> = {}): CheckoutV2AutomaticEligibleLine {
  return {
    shopProductId: "adamax",
    name: "Adamax (10 mg)",
    dosage: "10 mg",
    quantity: 2,
    unitPrice: 62,
    type: "peptide",
    category: "Peptide",
    isPlugPlay: false,
    isNasalDiySet: false,
    isNasalSpray: false,
    ...overrides,
  };
}

const disabledPromo = { enabled: false, mode: "all" as const, products: [] };
const activePromo = { enabled: true, mode: "all" as const, products: [] };
const bac3ml = { name: "BAC Wasser 3ml", dosage: "3ml" };

test("Checkout V2 derives 2-for-3 gifts only from an active server setting", () => {
  const gifts = calculateCheckoutV2AutomaticGiftLines({
    lines: [line({ quantity: 5, unitPrice: 49 })],
    promotion2for3: activePromo,
    freeBacWaterProduct: null,
  });
  assert.deepEqual(gifts, [{
    source: "promo_2for3",
    shopProductId: "adamax",
    name: "Adamax (10 mg)",
    dosage: "10 mg",
    quantity: 2,
    type: "peptide",
    isNasalDiySet: false,
    isNasalSpray: false,
    isPlugPlay: false,
  }]);
});

test("Checkout V2 never applies 2-for-3 to excluded product types", () => {
  const gifts = calculateCheckoutV2AutomaticGiftLines({
    lines: [
      line({ shopProductId: "nasal", isNasalSpray: true, quantity: 4 }),
      line({ shopProductId: "pen", isPlugPlay: true, quantity: 4 }),
      line({ shopProductId: "capsule", category: "Kapseln", quantity: 4 }),
    ],
    promotion2for3: activePromo,
    freeBacWaterProduct: null,
  });
  assert.equal(gifts.length, 0);
});

test("Checkout V2 honours include and exclude product filters for 2-for-3", () => {
  const include = calculateCheckoutV2AutomaticGiftLines({
    lines: [line({ shopProductId: "adamax", quantity: 2, unitPrice: 49 })],
    promotion2for3: { enabled: true, mode: "include", products: ["other"] },
    freeBacWaterProduct: null,
  });
  const exclude = calculateCheckoutV2AutomaticGiftLines({
    lines: [line({ shopProductId: "adamax", quantity: 2, unitPrice: 49 })],
    promotion2for3: { enabled: true, mode: "exclude", products: ["adamax"] },
    freeBacWaterProduct: null,
  });
  assert.equal(include.length, 0);
  assert.equal(exclude.length, 0);
});

test("Checkout V2 derives Gratis-BAC-Wasser per qualifying paid vial unit", () => {
  const gifts = calculateCheckoutV2AutomaticGiftLines({
    lines: [line({ quantity: 3, unitPrice: 62 })],
    promotion2for3: disabledPromo,
    freeBacWaterProduct: bac3ml,
  });
  assert.deepEqual(gifts, [{
    source: "free_bac_water",
    shopProductId: "bac-wasser-3ml",
    name: "BAC Wasser 3ml",
    dosage: "3ml",
    quantity: 3,
    type: "accessory",
    isNasalDiySet: false,
    isNasalSpray: false,
    isPlugPlay: false,
  }]);
});

test("Checkout V2 excludes nasal, plug-and-play and sub-threshold lines from Gratis-BAC", () => {
  const gifts = calculateCheckoutV2AutomaticGiftLines({
    lines: [
      line({ isNasalSpray: true, quantity: 2 }),
      line({ isPlugPlay: true, quantity: 2 }),
      line({ unitPrice: 49.99, quantity: 2 }),
      line({ category: "Forscher-Bundles", quantity: 2 }),
    ],
    promotion2for3: disabledPromo,
    freeBacWaterProduct: bac3ml,
  });
  assert.equal(gifts.length, 0);
});

test("Checkout V2 rejects a required Gratis-BAC item when the server cannot resolve it", () => {
  assert.throws(
    () => calculateCheckoutV2AutomaticGiftLines({
      lines: [line()],
      promotion2for3: disabledPromo,
      freeBacWaterProduct: null,
    }),
    /FREE_BAC_WATER_CONFIGURATION_INVALID/,
  );
});
