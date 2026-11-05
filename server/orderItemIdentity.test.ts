import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubstitutionProductFamily } from "./orderItemIdentity.js";

test("resolves a legacy selected bundle SKU to the canonical smart-substitution family", () => {
  const family = resolveSubstitutionProductFamily("RETATRUTIDE-15MG", [
    { sku: "RETATRUTIDE-15MG", shopProductId: "3g-triple-g" },
  ]);

  assert.equal(family, "3g-triple-g");
});

test("preserves an explicit canonical shop product id", () => {
  const family = resolveSubstitutionProductFamily("3g-triple-g", [
    { sku: "RETATRUTIDE-15MG", shopProductId: "3g-triple-g" },
  ]);

  assert.equal(family, "3g-triple-g");
});
