import assert from "node:assert/strict";
import test from "node:test";
import { requiresResearchOnlyValidation } from "./productValidationPolicy.js";

test("cosmetic categories do not require research-only metadata", () => {
  assert.equal(requiresResearchOnlyValidation({ category: "369 BeautyLine", categories: ["369 BeautyLine"] }), false);
  assert.equal(requiresResearchOnlyValidation({ category: null, categories: ["369 BeautyLine"] }), false);
});

test("research products continue to require research-only metadata", () => {
  assert.equal(requiresResearchOnlyValidation({ category: "Vials", categories: ["Vials"] }), true);
  assert.equal(requiresResearchOnlyValidation({ category: "Fertigpens", categories: null }), true);
});
