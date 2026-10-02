import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersonalPromoAssignment,
} from "./customerPromoAssignmentService.js";

test("persönliche Aktionscodes speichern nur Ausstellungsprovenienz", () => {
  const assignment = buildPersonalPromoAssignment({
    promoCodeId: 42,
    customerId: 99,
    originOrderId: "369-12345",
    createdBy: "packing",
  });

  assert.deepEqual(assignment, {
    promoCodeId: 42,
    customerId: 99,
    originOrderId: "369-12345",
    createdBy: "packing",
  });
  assert.equal("emailNormalized" in assignment, false);
  assert.equal("phoneNormalized" in assignment, false);
  assert.equal("maxUsesPerCustomer" in assignment, false);
});
