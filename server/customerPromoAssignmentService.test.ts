import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersonalPromoAssignment,
  CUSTOMER_PROMO_ASSIGNMENT_SCHEMA_SQL,
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

test("die Migration entfernt die historische Kontakt-Check-Regel idempotent", () => {
  assert.match(
    CUSTOMER_PROMO_ASSIGNMENT_SCHEMA_SQL,
    /DROP CONSTRAINT IF EXISTS customer_promo_assignments_check/i,
  );
  assert.match(CUSTOMER_PROMO_ASSIGNMENT_SCHEMA_SQL, /SELECT conname\s+FROM pg_constraint/i);
  assert.doesNotMatch(CUSTOMER_PROMO_ASSIGNMENT_SCHEMA_SQL, /SELECT constraint_name/i);
});
