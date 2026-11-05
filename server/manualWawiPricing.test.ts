import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDiscountCodeForOrderSource } from "./manualWawiPricing.js";

test("manual WaWi sales never pass manual labels into public promo-code validation", () => {
  assert.equal(normalizeDiscountCodeForOrderSource("wawi_manual", "25%"), null);
  assert.equal(normalizeDiscountCodeForOrderSource("wawi_manual", "Kostenloser Versand"), null);
});

test("shop promotion codes remain available outside the manual WaWi workflow", () => {
  assert.equal(normalizeDiscountCodeForOrderSource("shop", " followup-10 "), "followup-10");
  assert.equal(normalizeDiscountCodeForOrderSource(undefined, ""), null);
});
