import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCheckoutFailurePayload } from "./checkoutErrorRouter.js";

test("normalizes a recoverable checkout failure without changing it into an order", () => {
  const result = normalizeCheckoutFailurePayload({
    orderId: "FEHLER-369-1790011282151",
    customer: { firstName: "Marco", lastName: "Brehmer", email: "marco@example.test" },
    items: [{ name: "Example 10 mg", dosage: "10 mg", quantity: 1 }],
    total: 100,
    subtotal: 100,
    paymentMethod: "bunq",
    error: "ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH",
  });

  assert.equal(result.orderId, "FEHLER-369-1790011282151");
  assert.equal(result.total, 100);
  assert.equal(result.items.length, 1);
  assert.match(result.inputJson, /ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH/);
});

test("rejects unmarked or unverifiable error reports", () => {
  assert.throws(
    () => normalizeCheckoutFailurePayload({
      orderId: "369-1790011282151",
      customer: { firstName: "Marco" },
      total: 100,
    }),
    /Fehlerreferenz/
  );

  assert.throws(
    () => normalizeCheckoutFailurePayload({
      orderId: "FEHLER-369-1790011282151",
      customer: {},
      total: 100,
    }),
    /Kundendaten/
  );
});
